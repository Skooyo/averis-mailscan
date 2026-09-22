from __future__ import annotations

from backend.escalate import (
    annotate_with_escalation,
    escalation_queue,
    evaluate_email,
)
from backend.extract import Extraction, ExtractedField
from backend.models import Attachment, Classification, Email


def _attachment(path: str, read_error: str | None = None) -> Attachment:
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return Attachment(path=path, doc_type="unknown", ext=ext, text="text", read_error=read_error)


def _email(email_id: str, *attachments: Attachment) -> Email:
    return Email(email_id=email_id, sender="a@b.com", subject="s", body="b", attachments=list(attachments))


def _classification(category: str, confidence: float = 0.95) -> Classification:
    return Classification(category=category, confidence=confidence, reasoning="test fixture")


def _field(value, confidence=0.9):
    return ExtractedField(value=value, confidence=confidence, evidence="e")


def _extraction(doc_type: str, **overrides) -> Extraction:
    base = dict(
        doc_type_detected=doc_type,
        shipper=_field("ACME PTE LTD"),
        consignee=_field("Globex Corp"),
        notify_party=_field("Globex Corp"),
        port_of_loading=_field("Singapore"),
        port_of_discharge=_field("Port Klang"),
        container_count=_field("3"),
        gross_weight_kg=_field("12500"),
    )
    base.update(overrides)
    return Extraction(**base)


# ---------------------------------------------------------------------------
# evaluate_email
# ---------------------------------------------------------------------------

def test_clean_comparison_request_does_not_escalate():
    email = _email("e1", _attachment("si.txt"), _attachment("bl.txt"))
    classification = _classification("comparison_request")
    result = {"status": "match"}

    report = evaluate_email(email, classification, result)

    assert report.required is False
    assert report.reasons == []


def test_no_classification_escalates():
    email = _email("e1", _attachment("a.txt"))

    report = evaluate_email(email, None, None)

    assert report.required is True
    assert any(r.code == "unclassified" for r in report.reasons)


def test_low_confidence_classification_escalates():
    email = _email("e1", _attachment("a.txt"))
    classification = _classification("general", confidence=0.4)

    report = evaluate_email(email, classification, None)

    assert report.required is True
    assert any(r.code == "low_confidence_classification" for r in report.reasons)


def test_unreadable_attachment_escalates():
    email = _email("e1", _attachment("bl.pdf", read_error="pdf_no_text_layer"))
    classification = _classification("comparison_request")

    report = evaluate_email(email, classification, {"status": "error"})

    codes = [r.code for r in report.reasons]
    assert "unreadable_attachment" in codes
    assert any("pdf_no_text_layer" in r.detail for r in report.reasons)


def test_missing_attachments_on_comparison_request_escalates():
    email = _email("e1")  # no attachments at all
    classification = _classification("comparison_request")

    report = evaluate_email(email, classification, None)

    assert any(r.code == "missing_attachment" for r in report.reasons)


def test_missing_attachments_on_general_email_does_not_escalate():
    email = _email("e1")
    classification = _classification("general")

    report = evaluate_email(email, classification, None)

    assert report.required is False


def test_missing_attachments_on_new_si_request_does_not_escalate():
    # A new_si_request normally has no attachments -- the shipment details are inline in the body
    # (classify.py's own category definition). Regression test for a bug where every attachment-less
    # new_si_request email (125/125 in the demo dataset) was wrongly escalated as missing_attachment.
    email = _email("e1")
    classification = _classification("new_si_request")

    report = evaluate_email(email, classification, None)

    assert not any(r.code == "missing_attachment" for r in report.reasons)


def test_ambiguous_si_bl_error_gets_specific_code():
    email = _email("e1", _attachment("a.txt"))
    classification = _classification("comparison_request")
    result = {"status": "error", "message": "Could not uniquely identify an SI and a BL"}

    report = evaluate_email(email, classification, result)

    assert any(r.code == "ambiguous_si_bl" for r in report.reasons)


def test_generic_processing_error_gets_processing_error_code():
    email = _email("e1", _attachment("a.txt"))
    classification = _classification("comparison_request")
    result = {"status": "error", "message": "boom, something else broke"}

    report = evaluate_email(email, classification, result)

    assert any(r.code == "processing_error" for r in report.reasons)
    assert not any(r.code == "ambiguous_si_bl" for r in report.reasons)


def test_mismatch_result_alone_does_not_escalate():
    # A real, confidently-detected mismatch is a finding, not uncertainty.
    email = _email("e1", _attachment("si.txt"), _attachment("bl.txt"))
    classification = _classification("comparison_request")
    result = {"status": "mismatch", "incorrect_or_missing": ["shipper"]}

    report = evaluate_email(email, classification, result)

    assert report.required is False


def test_low_confidence_extraction_escalates():
    email = _email("e1", _attachment("si.txt"))
    classification = _classification("comparison_request")
    extraction_cache = {"si.txt": _extraction("SI", shipper=_field("ACME", confidence=0.2))}

    report = evaluate_email(email, classification, {"status": "match"}, extraction_cache)

    reasons = [r for r in report.reasons if r.code == "low_confidence_extraction"]
    assert len(reasons) == 1
    assert "shipper" in reasons[0].detail


def test_missing_extracted_field_escalates_as_missing_not_low_confidence():
    email = _email("e1", _attachment("si.txt"))
    classification = _classification("comparison_request")
    extraction_cache = {"si.txt": _extraction("SI", shipper=_field(None, confidence=0.0))}

    report = evaluate_email(email, classification, {"status": "match"}, extraction_cache)

    codes = [r.code for r in report.reasons]
    assert codes.count("missing_extracted_field") == 1
    assert "low_confidence_extraction" not in codes  # elif, not both


def test_extraction_cache_ignores_attachments_not_present_in_it():
    email = _email("e1", _attachment("other.txt"))  # not a key in the cache
    classification = _classification("general")
    extraction_cache = {"si.txt": _extraction("SI")}

    report = evaluate_email(email, classification, None, extraction_cache)

    assert report.required is False


# ---------------------------------------------------------------------------
# annotate_with_escalation / escalation_queue
# ---------------------------------------------------------------------------

def test_annotate_with_escalation_adds_escalation_key_to_every_result():
    emails = [_email("e1", _attachment("a.txt")), _email("e2", _attachment("b.txt"))]
    classifications = {"e1": _classification("general"), "e2": _classification("general", confidence=0.3)}
    results = {"e1": {"status": "skipped"}, "e2": {"status": "skipped"}}

    annotate_with_escalation(emails, classifications, results)

    assert results["e1"]["escalation"]["required"] is False
    assert results["e2"]["escalation"]["required"] is True


def test_annotate_with_escalation_creates_missing_result_entry():
    emails = [_email("e1", _attachment("a.txt"))]
    classifications = {"e1": _classification("general")}
    results: dict = {}  # e1 missing entirely

    annotate_with_escalation(emails, classifications, results)

    assert "e1" in results
    assert "escalation" in results["e1"]


def test_escalation_queue_filters_to_required_only():
    results = {
        "e1": {"escalation": {"required": False, "reasons": []}},
        "e2": {"escalation": {"required": True, "reasons": [{"code": "unclassified", "detail": "x"}]}},
        "e3": {},  # no escalation key at all
    }

    assert escalation_queue(results) == ["e2"]
