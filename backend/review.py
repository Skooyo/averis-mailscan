"""backend/review.py

The human side of escalation: a reviewer looking at backend/escalate.py's
output needs to be able to (a) retry an email that failed transiently or
whose source document was fixed/replaced, and (b) record a correction --
"I checked the original SI, the shipper is actually X" -- and have that
override reflected in the result. backend/escalate.py itself stays
read-only (pure rules over the pipeline's own output); this module is
where a human's action on an escalation gets recorded and applied.

There's deliberately no CLI/API surface here yet -- that needs a
persisted results store (email_id -> result), which doesn't exist until
the submission JSON schema is confirmed (todo.md's blocking item #2, still
waiting on sample_submission.json). These are the primitives a review UI
or CLI would call once that store exists.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from .comparison import NO_MISMATCH_MESSAGE
from .escalate import evaluate_email
from .extract import CACHE_PATH as EXTRACTION_CACHE_PATH
from .extract import _attachment_key
from .extract import load_cache as load_extraction_cache
from .extract import save_cache as save_extraction_cache
from .models import Classification, Email
from .pipeline import compare_si_vs_bl

CORRECTIONS_CACHE_PATH = Path(__file__).resolve().parent.parent / "data" / "corrections.json"


class Correction(BaseModel):
    email_id: str
    field: str  # "category", or a canonical field name (e.g. "shipper")
    value: Any
    note: Optional[str] = None
    corrected_by: Optional[str] = None
    corrected_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


# --- correction ledger -------------------------------------------------------


def load_corrections(path: Path = CORRECTIONS_CACHE_PATH) -> Dict[str, List[Correction]]:
    if not path.is_file():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {
        email_id: [Correction.model_validate(c) for c in entries]
        for email_id, entries in raw.items()
    }


def save_corrections(corrections: Dict[str, List[Correction]], path: Path = CORRECTIONS_CACHE_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    output = {
        email_id: [c.model_dump() for c in entries]
        for email_id, entries in sorted(corrections.items())
    }
    path.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")


def record_correction(
    email_id: str,
    field: str,
    value: Any,
    note: Optional[str] = None,
    corrected_by: Optional[str] = None,
    path: Path = CORRECTIONS_CACHE_PATH,
) -> Correction:
    """Append one human correction to the ledger and persist it."""
    corrections = load_corrections(path)
    correction = Correction(email_id=email_id, field=field, value=value, note=note, corrected_by=corrected_by)
    corrections.setdefault(email_id, []).append(correction)
    save_corrections(corrections, path)
    return correction


def apply_corrections(
    results: Dict[str, Dict[str, Any]],
    corrections: Dict[str, List[Correction]],
) -> Dict[str, Dict[str, Any]]:
    """Overlay recorded corrections onto `results` in place.

    A "category" correction overrides result["category"] directly. Any
    other field is treated as a canonical comparison field: if it was in
    that result's incorrect_or_missing list, the correction resolves it
    (removed from incorrect_or_missing/details; status flips to "match"
    once nothing is left outstanding). Every correction is also appended
    to result["corrections"] as an audit trail, and the email's escalation
    is marked resolved=True -- a human has now looked at it, whatever the
    original reasons said.
    """
    for email_id, email_corrections in corrections.items():
        record = results.get(email_id)
        if record is None or not email_corrections:
            continue

        applied = record.setdefault("corrections", [])
        for correction in email_corrections:
            applied.append(correction.model_dump())

            if correction.field == "category":
                record["category"] = correction.value
                continue

            incorrect = record.get("incorrect_or_missing")
            if isinstance(incorrect, list) and correction.field in incorrect:
                incorrect.remove(correction.field)
                record.get("details", {}).pop(correction.field, None)
                if not incorrect:
                    record["status"] = "match"
                    record["message"] = NO_MISMATCH_MESSAGE

        escalation = record.setdefault("escalation", {"required": False, "reasons": []})
        escalation["resolved"] = True
        escalation["resolved_by"] = email_corrections[-1].corrected_by
        notes = [c.note for c in email_corrections if c.note]
        escalation["resolution_note"] = "; ".join(notes) if notes else None

    return results


def mark_resolved(
    results: Dict[str, Dict[str, Any]],
    email_id: str,
    note: Optional[str] = None,
    resolved_by: Optional[str] = None,
) -> Dict[str, Any]:
    """Acknowledge an escalation without changing any value -- a human
    looked at it and it's fine as-is (e.g. a low-confidence field that's
    actually correct). Raises KeyError if email_id isn't in results.
    """
    record = results[email_id]
    escalation = record.setdefault("escalation", {"required": False, "reasons": []})
    escalation["resolved"] = True
    escalation["resolved_by"] = resolved_by
    escalation["resolution_note"] = note
    return record


# --- retry --------------------------------------------------------------


async def retry_email(
    email: Email,
    classification: Optional[Classification],
    use_llm_fallback: bool = False,
    confidence_threshold: float = 0.0,
    cache_path: Path = EXTRACTION_CACHE_PATH,
    **extract_kwargs: Any,
) -> Dict[str, Any]:
    """Re-run comparison for one email, forcing fresh extraction of just
    this email's own attachments (e.g. after a transient LLM failure, or
    after the source document was fixed/replaced) -- without discarding
    every other attachment's cached extraction the way extract_all's own
    force=True would.

    Only applies to comparison_request emails; raises ValueError for any
    other category, since retrying a "skipped" email is meaningless.
    """
    category = classification.category if classification else None
    if category != "comparison_request":
        raise ValueError(
            f"retry_email only re-processes comparison_request emails (got {category!r})"
        )

    cache = load_extraction_cache(cache_path)
    evicted = False
    for attachment in email.attachments:
        if cache.pop(_attachment_key(attachment), None) is not None:
            evicted = True
    if evicted:
        save_extraction_cache(cache, cache_path)

    result = await compare_si_vs_bl(
        email.attachments,
        use_llm_fallback=use_llm_fallback,
        confidence_threshold=confidence_threshold,
        cache_path=cache_path,
        **extract_kwargs,
    )
    result["category"] = category
    result["retried"] = True
    return result


async def retry_and_reannotate(
    email: Email,
    classification: Optional[Classification],
    results: Dict[str, Dict[str, Any]],
    extraction_cache_path: Path = EXTRACTION_CACHE_PATH,
    **retry_kwargs: Any,
) -> Dict[str, Any]:
    """retry_email, then refresh both the result and its escalation verdict
    in `results` in place -- the single call a review UI/CLI makes for
    "retry this email", so results never ends up holding a stale
    escalation next to a freshly retried comparison outcome.
    """
    record = await retry_email(email, classification, cache_path=extraction_cache_path, **retry_kwargs)
    extraction_cache = load_extraction_cache(extraction_cache_path)
    report = evaluate_email(email, classification, record, extraction_cache)
    record["escalation"] = report.model_dump()
    results[email.email_id] = record
    return record
