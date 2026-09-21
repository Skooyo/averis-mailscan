from __future__ import annotations

from typing import Optional

import pytest

from backend.comparison import NO_MISMATCH_MESSAGE
from backend.extract import Extraction, ExtractedField, save_cache
from backend.models import Attachment, Classification, Email
from backend.review import (
    Correction,
    apply_corrections,
    load_corrections,
    mark_resolved,
    record_correction,
    retry_and_reannotate,
    retry_email,
)


def _attachment(path: str, text: Optional[str] = "text") -> Attachment:
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return Attachment(path=path, doc_type="unknown", ext=ext, text=text)


def _email(email_id: str, *attachments: Attachment) -> Email:
    return Email(email_id=email_id, sender="a@b.com", subject="s", body="b", attachments=list(attachments))


def _classification(category: str) -> Classification:
    return Classification(category=category, confidence=0.95, reasoning="test fixture")


def _field(value, confidence=0.9):
    return ExtractedField(value=value, confidence=confidence, evidence="e")


def _extraction(doc_type: str) -> Extraction:
    return Extraction(
        doc_type_detected=doc_type,
        shipper=_field("ACME PTE LTD"),
        consignee=_field("Globex Corp"),
        notify_party=_field("Globex Corp"),
        port_of_loading=_field("Singapore"),
        port_of_discharge=_field("Port Klang"),
        container_count=_field("3"),
        gross_weight_kg=_field("12500"),
    )


# ---------------------------------------------------------------------------
# correction ledger
# ---------------------------------------------------------------------------

def test_record_correction_persists_and_appends(tmp_path):
    path = tmp_path / "corrections.json"

    record_correction("e1", "shipper", "ACME PTE LTD", note="verified against original SI", path=path)
    record_correction("e1", "consignee", "Globex", path=path)

    loaded = load_corrections(path)

    assert set(loaded) == {"e1"}
    assert [c.field for c in loaded["e1"]] == ["shipper", "consignee"]
    assert loaded["e1"][0].value == "ACME PTE LTD"
    assert loaded["e1"][0].note == "verified against original SI"


def test_load_corrections_missing_file_returns_empty(tmp_path):
    assert load_corrections(tmp_path / "does_not_exist.json") == {}


def test_apply_corrections_resolves_flagged_field_and_flips_to_match():
    results = {
        "e1": {
            "status": "mismatch",
            "message": "1 field(s) mismatched: shipper",
            "incorrect_or_missing": ["shipper"],
            "details": {"shipper": {"si": "ACME", "bl": "ACME CO"}},
            "escalation": {"required": False, "reasons": []},
        }
    }
    corrections = {"e1": [Correction(email_id="e1", field="shipper", value="ACME PTE LTD", corrected_by="alice")]}

    apply_corrections(results, corrections)

    record = results["e1"]
    assert record["status"] == "match"
    assert record["message"] == NO_MISMATCH_MESSAGE
    assert "shipper" not in record["incorrect_or_missing"]
    assert "shipper" not in record["details"]
    assert record["escalation"]["resolved"] is True
    assert record["escalation"]["resolved_by"] == "alice"
    assert record["corrections"][0]["field"] == "shipper"


def test_apply_corrections_leaves_status_mismatch_if_another_field_still_outstanding():
    results = {
        "e1": {
            "status": "mismatch",
            "incorrect_or_missing": ["shipper", "consignee"],
            "details": {"shipper": {"si": "A", "bl": "B"}, "consignee": {"si": "C", "bl": "D"}},
            "escalation": {"required": False, "reasons": []},
        }
    }
    corrections = {"e1": [Correction(email_id="e1", field="shipper", value="X")]}

    apply_corrections(results, corrections)

    assert results["e1"]["status"] == "mismatch"
    assert results["e1"]["incorrect_or_missing"] == ["consignee"]


def test_apply_corrections_overrides_category():
    results = {
        "e1": {"status": "skipped", "category": "general", "escalation": {"required": True, "reasons": []}}
    }
    corrections = {"e1": [Correction(email_id="e1", field="category", value="comparison_request")]}

    apply_corrections(results, corrections)

    assert results["e1"]["category"] == "comparison_request"
    assert results["e1"]["escalation"]["resolved"] is True


def test_apply_corrections_ignores_email_ids_not_in_results():
    results = {"e1": {"status": "match"}}
    corrections = {"e2": [Correction(email_id="e2", field="category", value="general")]}

    apply_corrections(results, corrections)  # must not raise

    assert "e2" not in results


def test_mark_resolved_sets_escalation_flags_without_touching_values():
    results = {
        "e1": {
            "status": "error",
            "message": "boom",
            "escalation": {"required": True, "reasons": [{"code": "processing_error", "detail": "boom"}]},
        }
    }

    record = mark_resolved(results, "e1", note="retried manually, now fine", resolved_by="alice")

    assert record is results["e1"]
    assert record["status"] == "error"  # unchanged -- this is acknowledgement, not correction
    esc = record["escalation"]
    assert esc["resolved"] is True
    assert esc["resolved_by"] == "alice"
    assert esc["resolution_note"] == "retried manually, now fine"
    assert esc["required"] is True  # historical reasons untouched


def test_mark_resolved_missing_email_id_raises_key_error():
    with pytest.raises(KeyError):
        mark_resolved({}, "does_not_exist")


# ---------------------------------------------------------------------------
# retry_email
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_retry_email_evicts_only_this_emails_cached_attachments(monkeypatch, tmp_path):
    si = _attachment("email_004_SI.txt")
    bl = _attachment("email_004_BL.txt")
    email = _email("email_004", si, bl)
    classification = _classification("comparison_request")

    cache_path = tmp_path / "extractions.json"
    save_cache(
        {
            "email_004_SI.txt": _extraction("SI"),
            "email_004_BL.txt": _extraction("BL"),
            "email_999_SI.txt": _extraction("SI"),  # unrelated -- must survive
        },
        cache_path,
    )

    received_kwargs = {}

    async def fake_compare_si_vs_bl(attachments, **kwargs):
        received_kwargs.update(kwargs)
        return {"status": "match", "message": NO_MISMATCH_MESSAGE}

    monkeypatch.setattr("backend.review.compare_si_vs_bl", fake_compare_si_vs_bl)

    result = await retry_email(email, classification, cache_path=cache_path)

    assert result["status"] == "match"
    assert result["retried"] is True
    assert result["category"] == "comparison_request"
    assert received_kwargs["cache_path"] == cache_path

    from backend.extract import load_cache

    remaining = load_cache(cache_path)
    assert set(remaining) == {"email_999_SI.txt"}


@pytest.mark.asyncio
async def test_retry_email_rejects_non_comparison_request_categories():
    email = _email("e1", _attachment("a.txt"))
    classification = _classification("general")

    with pytest.raises(ValueError, match="comparison_request"):
        await retry_email(email, classification)


@pytest.mark.asyncio
async def test_retry_email_rejects_when_unclassified():
    email = _email("e1", _attachment("a.txt"))

    with pytest.raises(ValueError, match="comparison_request"):
        await retry_email(email, None)


@pytest.mark.asyncio
async def test_retry_and_reannotate_updates_results_and_escalation_in_place(monkeypatch, tmp_path):
    email = _email("email_004", _attachment("email_004_SI.txt"), _attachment("email_004_BL.txt"))
    classification = _classification("comparison_request")
    results = {
        "email_004": {
            "status": "error",
            "category": "comparison_request",
            "message": "boom",
            "escalation": {"required": True, "reasons": [{"code": "processing_error", "detail": "boom"}]},
        }
    }

    async def fake_compare_si_vs_bl(attachments, **kwargs):
        return {"status": "match", "message": NO_MISMATCH_MESSAGE}

    monkeypatch.setattr("backend.review.compare_si_vs_bl", fake_compare_si_vs_bl)

    record = await retry_and_reannotate(
        email, classification, results, extraction_cache_path=tmp_path / "e.json"
    )

    assert record is results["email_004"]
    assert results["email_004"]["status"] == "match"
    assert results["email_004"]["retried"] is True
    assert results["email_004"]["escalation"]["required"] is False  # fresh evaluation, no reasons
