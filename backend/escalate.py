"""backend/escalate.py

Rules-based escalation: decides which processed emails need a human's
attention before the pipeline's output can be trusted, per the problem
statement's "ask for help" capability.

Pure rules over data the earlier stages already produced (classification,
extraction cache, comparison result) -- no LLM calls, so this step is
instant, free, and reproducible. Slots into pipeline.py right after
process_comparison_requests builds a base result for every email.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from .comparison import FIELDS
from .extract import Extraction, _attachment_key
from .models import Classification, Email

DEFAULT_CLASSIFICATION_CONFIDENCE_FLOOR = 0.6
DEFAULT_FIELD_CONFIDENCE_FLOOR = 0.5

# Categories where a completely attachment-less email is itself suspicious: comparison needs an
# SI+BL. new_si_request is deliberately NOT here -- per classify.py's own category definition, a
# new_si_request normally carries its shipment details inline in the body, not as an attachment
# ("even if it closes with revert with draft BL once available"), so having none is the expected
# case, not a red flag. Including it here previously escalated every attachment-less new_si_request
# email (125/125 in the demo dataset) into the review queue, each routed to a comparison screen
# that would then say the category doesn't require SI/BL comparison at all.
_ATTACHMENT_EXPECTED_CATEGORIES = {"comparison_request"}


class EscalationReason(BaseModel):
    code: str
    detail: str


class EscalationReport(BaseModel):
    required: bool = False
    reasons: List[EscalationReason] = Field(default_factory=list)
    # Set by backend/review.py once a human has looked at this email --
    # left False/None by evaluate_email itself, which only ever judges the
    # pipeline's own output, not whether a person has acted on it since.
    resolved: bool = False
    resolved_by: Optional[str] = None
    resolution_note: Optional[str] = None


def evaluate_email(
    email: Email,
    classification: Optional[Classification],
    result: Optional[Dict[str, Any]] = None,
    extraction_cache: Optional[Dict[str, Extraction]] = None,
    *,
    classification_confidence_floor: float = DEFAULT_CLASSIFICATION_CONFIDENCE_FLOOR,
    field_confidence_floor: float = DEFAULT_FIELD_CONFIDENCE_FLOOR,
) -> EscalationReport:
    """Decide whether one email needs human review, and why.

    Checks, in order:
    1. Missing classification, or classification confidence below floor.
    2. Any attachment with a read_error (missing/unreadable document).
    3. A comparison_request email with no attachments at all.
    4. The comparison stage failed outright (process_comparison_requests
       caught an exception) -- specifically flags the "could not uniquely
       identify an SI and a BL" case as ambiguous_si_bl.
    5. Any extracted field (for this email's own attachments, per
       extraction_cache) that's null or below field_confidence_floor.

    A "mismatch" comparison result is NOT itself a reason -- that's a
    legitimate finding for a human to act on, not something uncertain
    about the pipeline's own confidence.
    """
    reasons: List[EscalationReason] = []

    if classification is None:
        reasons.append(
            EscalationReason(code="unclassified", detail="no classification produced for this email")
        )
    elif classification.confidence < classification_confidence_floor:
        reasons.append(
            EscalationReason(
                code="low_confidence_classification",
                detail=f"confidence {classification.confidence:.2f} below floor {classification_confidence_floor:.2f}",
            )
        )

    category = classification.category if classification else None

    for attachment in email.attachments:
        if attachment.read_error:
            reasons.append(
                EscalationReason(
                    code="unreadable_attachment",
                    detail=f"{attachment.path}: {attachment.read_error}",
                )
            )

    if category in _ATTACHMENT_EXPECTED_CATEGORIES and not email.attachments:
        reasons.append(
            EscalationReason(code="missing_attachment", detail="no attachments present")
        )

    if result is not None and result.get("status") == "error":
        message = result.get("message", "")
        code = "ambiguous_si_bl" if "Could not uniquely identify" in message else "processing_error"
        reasons.append(EscalationReason(code=code, detail=message))

    if extraction_cache:
        for attachment in email.attachments:
            extraction = extraction_cache.get(_attachment_key(attachment))
            if extraction is None:
                continue
            for field_name in FIELDS:
                field = getattr(extraction, field_name)
                if field.value is None:
                    reasons.append(
                        EscalationReason(
                            code="missing_extracted_field",
                            detail=f"{attachment.path}: {field_name} is missing",
                        )
                    )
                elif field.confidence < field_confidence_floor:
                    reasons.append(
                        EscalationReason(
                            code="low_confidence_extraction",
                            detail=(
                                f"{attachment.path}: {field_name} confidence "
                                f"{field.confidence:.2f} below floor {field_confidence_floor:.2f}"
                            ),
                        )
                    )

    return EscalationReport(required=bool(reasons), reasons=reasons)


def annotate_with_escalation(
    emails: List[Email],
    classifications: Dict[str, Classification],
    results: Dict[str, Dict[str, Any]],
    extraction_cache: Optional[Dict[str, Extraction]] = None,
    **floors: float,
) -> Dict[str, Dict[str, Any]]:
    """Add an "escalation" key to every email's result record in place.

    Assumes `results` already has an entry for every email in `emails`
    (process_comparison_requests guarantees this after fix #1) -- creates
    one if somehow missing, so this never silently drops an email.
    """
    for email in emails:
        classification = classifications.get(email.email_id)
        record = results.setdefault(email.email_id, {})
        report = evaluate_email(email, classification, record, extraction_cache, **floors)
        record["escalation"] = report.model_dump()
    return results


def escalation_queue(results: Dict[str, Dict[str, Any]]) -> List[str]:
    """email_ids flagged as needing human review, in results' iteration order."""
    return [
        email_id
        for email_id, record in results.items()
        if record.get("escalation", {}).get("required")
    ]
