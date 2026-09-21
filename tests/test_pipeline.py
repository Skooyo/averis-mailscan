from __future__ import annotations

from typing import Optional
from unittest.mock import MagicMock

import pytest

from backend.comparison import NO_MISMATCH_MESSAGE
from backend.extract import Extraction, ExtractedField
from backend.models import Attachment, Classification, Email
from backend.pipeline import (
    compare_si_vs_bl,
    dedupe_attachments,
    main,
    process_comparison_requests,
    run_pipeline,
    summarize_comparisons,
)


def _attachment(
    path: str,
    doc_type: str = "unknown",
    text: Optional[str] = None,
    read_error: Optional[str] = None,
) -> Attachment:
    """Build a real backend.models.Attachment the same way ingest.py does
    (all fields explicit), rather than a hand-rolled fake -- Email validates
    its attachments field strictly, so a duck-typed stand-in doesn't pass.
    """
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return Attachment(path=path, doc_type=doc_type, ext=ext, text=text, read_error=read_error)


def _classification(
    category: str, confidence: float = 0.95, reasoning: str = "test fixture"
) -> Classification:
    return Classification(category=category, confidence=confidence, reasoning=reasoning)


def _field(value, confidence=0.9):
    return ExtractedField(value=value, confidence=confidence, evidence="e")


def _extraction(doc_type: str, shipper: str, **overrides) -> Extraction:
    base = dict(
        doc_type_detected=doc_type,
        shipper=_field(shipper),
        consignee=_field("Globex Corp"),
        notify_party=_field("Globex Corp"),
        port_of_loading=_field("Singapore"),
        port_of_discharge=_field("Port Klang"),
        container_count=_field("3"),
        gross_weight_kg=_field("12500"),
    )
    base.update(overrides)
    return Extraction(**base)


@pytest.mark.asyncio
async def test_compare_si_vs_bl_auto_detects_and_matches(monkeypatch, tmp_path):
    si_attachment = _attachment("si.txt", text="SI text")
    bl_attachment = _attachment("bl.txt", text="BL text")

    fake_extractions = {
        "si.txt": _extraction("SI", shipper="ACME PTE LTD"),
        "bl.txt": _extraction("BL", shipper="Acme Pte. Ltd."),  # same company, different formatting
    }

    async def fake_extract_all(attachments, **kwargs):
        return fake_extractions

    monkeypatch.setattr("backend.pipeline.extract_all", fake_extract_all)

    result = await compare_si_vs_bl([si_attachment, bl_attachment], cache_path=tmp_path / "c.json")

    assert result["status"] == "match"
    assert result["message"] == NO_MISMATCH_MESSAGE


@pytest.mark.asyncio
async def test_compare_si_vs_bl_auto_detects_real_mismatch(monkeypatch):
    si_attachment = _attachment("si.txt", text="SI text")
    bl_attachment = _attachment("bl.txt", text="BL text")

    fake_extractions = {
        "si.txt": _extraction("SI", shipper="ACME PTE LTD", port_of_discharge=_field("Port Klang")),
        "bl.txt": _extraction("BL", shipper="ACME PTE LTD", port_of_discharge=_field("Shanghai")),
    }

    async def fake_extract_all(attachments, **kwargs):
        return fake_extractions

    monkeypatch.setattr("backend.pipeline.extract_all", fake_extract_all)

    result = await compare_si_vs_bl([si_attachment, bl_attachment])

    assert result["status"] == "mismatch"
    assert "port_of_discharge" in result["incorrect_or_missing"]


@pytest.mark.asyncio
async def test_compare_si_vs_bl_raises_when_no_bl_found(monkeypatch):
    si_attachment = _attachment("si.txt", text="SI text")

    fake_extractions = {"si.txt": _extraction("SI", shipper="ACME PTE LTD")}

    async def fake_extract_all(attachments, **kwargs):
        return fake_extractions

    monkeypatch.setattr("backend.pipeline.extract_all", fake_extract_all)

    with pytest.raises(ValueError, match="Could not uniquely identify"):
        await compare_si_vs_bl([si_attachment])


@pytest.mark.asyncio
async def test_compare_si_vs_bl_raises_on_multiple_si_matches(monkeypatch):
    si_a = _attachment("si_a.txt")
    si_b = _attachment("si_b.txt")
    bl = _attachment("bl.txt")
    fake_extractions = {
        "si_a.txt": _extraction("SI", shipper="ACME PTE LTD"),
        "si_b.txt": _extraction("SI", shipper="ACME PTE LTD"),
        "bl.txt": _extraction("BL", shipper="ACME PTE LTD"),
    }

    async def fake_extract_all(attachments, **kwargs):
        return fake_extractions

    monkeypatch.setattr("backend.pipeline.extract_all", fake_extract_all)

    with pytest.raises(ValueError, match="Could not uniquely identify"):
        await compare_si_vs_bl([si_a, si_b, bl])


@pytest.mark.asyncio
async def test_compare_si_vs_bl_explicit_keys_bypass_auto_detection(monkeypatch):
    # Even with ambiguous doc_type_detected (two "other"), explicit keys work
    # -- as long as they name attachments actually passed in this call.
    doc_a = _attachment("doc_a.txt")
    doc_b = _attachment("doc_b.txt")
    fake_extractions = {
        "doc_a.txt": _extraction("other", shipper="ACME PTE LTD"),
        "doc_b.txt": _extraction("other", shipper="ACME PTE LTD"),
    }

    async def fake_extract_all(attachments, **kwargs):
        return fake_extractions

    monkeypatch.setattr("backend.pipeline.extract_all", fake_extract_all)

    result = await compare_si_vs_bl(
        [doc_a, doc_b],
        si_attachment_key="doc_a.txt",
        bl_attachment_key="doc_b.txt",
    )

    assert result["status"] == "match"


@pytest.mark.asyncio
async def test_compare_si_vs_bl_explicit_key_not_found_raises(monkeypatch):
    si_attachment = _attachment("si.txt")
    fake_extractions = {"si.txt": _extraction("SI", shipper="ACME PTE LTD")}

    async def fake_extract_all(attachments, **kwargs):
        return fake_extractions

    monkeypatch.setattr("backend.pipeline.extract_all", fake_extract_all)

    with pytest.raises(ValueError, match="bl_attachment_key"):
        await compare_si_vs_bl(
            [si_attachment], si_attachment_key="si.txt", bl_attachment_key="missing.txt"
        )


@pytest.mark.asyncio
async def test_compare_si_vs_bl_ignores_other_emails_cached_in_shared_extraction_cache(
    monkeypatch,
):
    # Regression test: extract_all's cache is persistent and shared across
    # every call using the same cache_path, so it returns the WHOLE
    # accumulated cache -- not just entries for the attachments passed in.
    # This reproduces the real-world bug: email_004's own SI/BL, PLUS
    # email_001's already-cached SI/BL leaking in from a prior call in the
    # same run, which incorrectly looked like 2 SI-typed / 2 BL-typed.
    si_attachment = _attachment("attachments/email_004_SI.txt", text="SI text")
    bl_attachment = _attachment("attachments/email_004_BL.txt", text="BL text")

    fake_extractions = {
        # already cached from a PRIOR call for a different email in this run
        "attachments/email_001_SI.txt": _extraction("SI", shipper="OTHER CO"),
        "attachments/email_001_BL.txt": _extraction("BL", shipper="OTHER CO"),
        # this call's own attachments
        "attachments/email_004_SI.txt": _extraction("SI", shipper="ACME PTE LTD"),
        "attachments/email_004_BL.txt": _extraction("BL", shipper="Acme Pte. Ltd."),
    }

    async def fake_extract_all(attachments, **kwargs):
        return fake_extractions  # the WHOLE cache, as the real extract_all does

    monkeypatch.setattr("backend.pipeline.extract_all", fake_extract_all)

    result = await compare_si_vs_bl([si_attachment, bl_attachment])

    assert result["status"] == "match"


# ---------------------------------------------------------------------------
# dedupe_attachments -- same document attached twice under different names
# ---------------------------------------------------------------------------

def test_dedupe_attachments_collapses_identical_content():
    a = _attachment("a.txt", text="same content")
    b = _attachment("b.txt", text="same content")

    kept, duplicates = dedupe_attachments([a, b])

    assert [x.path for x in kept] == ["a.txt"]
    assert duplicates == {"a.txt": ["b.txt"]}


def test_dedupe_attachments_keeps_distinct_content():
    a = _attachment("a.txt", text="content A")
    b = _attachment("b.txt", text="content B")

    kept, duplicates = dedupe_attachments([a, b])

    assert [x.path for x in kept] == ["a.txt", "b.txt"]
    assert duplicates == {}


def test_dedupe_attachments_does_not_treat_unreadable_attachments_as_duplicates():
    a = _attachment("a.pdf", text=None, read_error="pdf_no_text_layer")
    b = _attachment("b.pdf", text=None, read_error="pdf_no_text_layer")

    kept, duplicates = dedupe_attachments([a, b])

    assert [x.path for x in kept] == ["a.pdf", "b.pdf"]
    assert duplicates == {}


def test_dedupe_attachments_groups_multiple_duplicates_under_first_occurrence():
    a = _attachment("a.txt", text="same content")
    b = _attachment("b.txt", text="same content")
    c = _attachment("c.txt", text="same content")

    kept, duplicates = dedupe_attachments([a, b, c])

    assert [x.path for x in kept] == ["a.txt"]
    assert duplicates == {"a.txt": ["b.txt", "c.txt"]}


@pytest.mark.asyncio
async def test_compare_si_vs_bl_dedupes_before_extraction_and_reports_it(monkeypatch):
    si_attachment = _attachment("si.txt", text="SI text")
    si_duplicate = _attachment("si_copy.txt", text="SI text")  # same content, different name
    bl_attachment = _attachment("bl.txt", text="BL text")

    received_attachments = []

    async def fake_extract_all(attachments, **kwargs):
        received_attachments.extend(attachments)
        return {
            "si.txt": _extraction("SI", shipper="ACME PTE LTD"),
            "bl.txt": _extraction("BL", shipper="ACME PTE LTD"),
        }

    monkeypatch.setattr("backend.pipeline.extract_all", fake_extract_all)

    result = await compare_si_vs_bl([si_attachment, si_duplicate, bl_attachment])

    # the duplicate never reached extract_all -- no wasted extraction call
    assert [a.path for a in received_attachments] == ["si.txt", "bl.txt"]
    assert result["status"] == "match"
    assert result["duplicate_attachments"] == {"si.txt": ["si_copy.txt"]}


@pytest.mark.asyncio
async def test_compare_si_vs_bl_without_duplicates_has_no_duplicate_key(monkeypatch):
    si_attachment = _attachment("si.txt", text="SI text")
    bl_attachment = _attachment("bl.txt", text="BL text")

    async def fake_extract_all(attachments, **kwargs):
        return {
            "si.txt": _extraction("SI", shipper="ACME PTE LTD"),
            "bl.txt": _extraction("BL", shipper="ACME PTE LTD"),
        }

    monkeypatch.setattr("backend.pipeline.extract_all", fake_extract_all)

    result = await compare_si_vs_bl([si_attachment, bl_attachment])

    assert "duplicate_attachments" not in result


# ---------------------------------------------------------------------------
# process_comparison_requests -- classify.py -> compare_si_vs_bl dispatcher
# ---------------------------------------------------------------------------

def _email(email_id: str, *attachments: Attachment) -> Email:
    return Email(email_id=email_id, sender="a@b.com", subject="s", body="b", attachments=list(attachments))


@pytest.mark.asyncio
async def test_dispatcher_only_compares_comparison_request_emails_but_returns_every_email(
    monkeypatch, tmp_path
):
    emails = [
        _email("e1", _attachment("si.txt"), _attachment("bl.txt")),
        _email("e2", _attachment("foo.txt")),
        _email("e3", _attachment("bar.txt")),
    ]
    classifications = {
        "e1": _classification("comparison_request"),
        "e2": _classification("invoice_query"),
        # e3 deliberately has no classification entry at all
    }

    calls = []

    async def fake_compare_si_vs_bl(attachments, **kwargs):
        calls.append([a.path for a in attachments])
        return {"status": "match", "message": NO_MISMATCH_MESSAGE}

    monkeypatch.setattr("backend.pipeline.compare_si_vs_bl", fake_compare_si_vs_bl)

    results = await process_comparison_requests(
        emails, classifications, cache_path=tmp_path / "extractions.json"
    )

    # Every email gets an entry now, not just comparison_request ones.
    assert set(results) == {"e1", "e2", "e3"}
    assert results["e1"]["status"] == "match"
    assert results["e1"]["category"] == "comparison_request"
    assert calls == [["si.txt", "bl.txt"]]  # compare only ran for e1

    assert results["e2"]["status"] == "skipped"
    assert results["e2"]["category"] == "invoice_query"

    assert results["e3"]["status"] == "unclassified"
    assert results["e3"]["category"] is None

    # Every email also gets an escalation verdict.
    for record in results.values():
        assert "escalation" in record and "required" in record["escalation"]
    assert results["e3"]["escalation"]["required"] is True  # unclassified


@pytest.mark.asyncio
async def test_dispatcher_captures_failure_without_halting_batch(monkeypatch, tmp_path):
    emails = [
        _email("e1", _attachment("si.txt")),  # missing BL
        _email("e2", _attachment("si2.txt"), _attachment("bl2.txt")),
    ]
    classifications = {
        "e1": _classification("comparison_request"),
        "e2": _classification("comparison_request"),
    }

    async def fake_compare_si_vs_bl(attachments, **kwargs):
        paths = [a.path for a in attachments]
        if len(paths) == 1:
            raise ValueError("Could not uniquely identify an SI and a BL")
        return {"status": "match", "message": NO_MISMATCH_MESSAGE}

    monkeypatch.setattr("backend.pipeline.compare_si_vs_bl", fake_compare_si_vs_bl)

    results = await process_comparison_requests(
        emails, classifications, cache_path=tmp_path / "extractions.json"
    )

    assert results["e1"]["status"] == "error"
    assert "Could not uniquely identify" in results["e1"]["message"]
    assert results["e1"]["escalation"]["required"] is True
    reasons = [r["code"] for r in results["e1"]["escalation"]["reasons"]]
    assert "ambiguous_si_bl" in reasons
    # e2 still got processed even though e1 failed
    assert results["e2"]["status"] == "match"
    assert results["e2"]["escalation"]["required"] is False


@pytest.mark.asyncio
async def test_dispatcher_passes_through_kwargs(monkeypatch, tmp_path):
    emails = [_email("e1", _attachment("si.txt"), _attachment("bl.txt"))]
    classifications = {"e1": _classification("comparison_request")}

    received_kwargs = {}

    async def fake_compare_si_vs_bl(attachments, **kwargs):
        received_kwargs.update(kwargs)
        return {"status": "match", "message": NO_MISMATCH_MESSAGE}

    monkeypatch.setattr("backend.pipeline.compare_si_vs_bl", fake_compare_si_vs_bl)

    await process_comparison_requests(
        emails,
        classifications,
        use_llm_fallback=True,
        confidence_threshold=0.5,
        cache_path=tmp_path / "c.json",
    )

    assert received_kwargs["use_llm_fallback"] is True
    assert received_kwargs["confidence_threshold"] == 0.5
    assert received_kwargs["cache_path"] == tmp_path / "c.json"


# ---------------------------------------------------------------------------
# run_pipeline -- ingest.load_inbox -> classify.classify_all -> compare
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_run_pipeline_wires_ingest_classify_and_compare(monkeypatch, tmp_path):
    fake_emails = [_email("e1"), _email("e2")]
    fake_classifications = {"e1": _classification("comparison_request")}

    def fake_load_inbox(data_dir, text_store=None):
        assert data_dir == tmp_path
        return iter(fake_emails)

    async def fake_classify_all(emails, **kwargs):
        assert list(emails) == fake_emails
        return fake_classifications

    captured = {}

    async def fake_process_comparison_requests(emails, classifications, **kwargs):
        captured["emails"] = emails
        captured["classifications"] = classifications
        captured["kwargs"] = kwargs
        return {"e1": {"status": "match", "message": NO_MISMATCH_MESSAGE}}

    monkeypatch.setattr("backend.pipeline.load_inbox", fake_load_inbox)
    monkeypatch.setattr("backend.pipeline.classify_all", fake_classify_all)
    monkeypatch.setattr(
        "backend.pipeline.process_comparison_requests", fake_process_comparison_requests
    )

    result = await run_pipeline(tmp_path, use_llm_fallback=True, confidence_threshold=0.4)

    assert result == {"e1": {"status": "match", "message": NO_MISMATCH_MESSAGE}}
    assert captured["emails"] == fake_emails
    assert captured["classifications"] == fake_classifications
    assert captured["kwargs"]["use_llm_fallback"] is True
    assert captured["kwargs"]["confidence_threshold"] == 0.4


@pytest.mark.asyncio
async def test_run_pipeline_passes_through_classify_and_extract_kwargs(monkeypatch, tmp_path):
    def fake_load_inbox(data_dir, text_store=None):
        return iter([])

    received_classify_kwargs = {}

    async def fake_classify_all(emails, **kwargs):
        received_classify_kwargs.update(kwargs)
        return {}

    received_extract_kwargs = {}

    async def fake_process_comparison_requests(emails, classifications, **kwargs):
        received_extract_kwargs.update(kwargs)
        return {}

    monkeypatch.setattr("backend.pipeline.load_inbox", fake_load_inbox)
    monkeypatch.setattr("backend.pipeline.classify_all", fake_classify_all)
    monkeypatch.setattr(
        "backend.pipeline.process_comparison_requests", fake_process_comparison_requests
    )

    await run_pipeline(
        tmp_path,
        classify_kwargs={"concurrency": 3, "force": True},
        extract_kwargs={"cache_path": tmp_path / "e.json"},
    )

    assert received_classify_kwargs == {"concurrency": 3, "force": True}
    assert received_extract_kwargs["cache_path"] == tmp_path / "e.json"


@pytest.mark.asyncio
async def test_run_pipeline_limit_slices_before_classify(monkeypatch, tmp_path):
    fake_emails = [_email("e1"), _email("e2"), _email("e3")]

    def fake_load_inbox(data_dir, text_store=None):
        return iter(fake_emails)

    received_emails = {}

    async def fake_classify_all(emails, **kwargs):
        received_emails["classify"] = list(emails)
        return {}

    async def fake_process_comparison_requests(emails, classifications, **kwargs):
        received_emails["process"] = list(emails)
        return {}

    monkeypatch.setattr("backend.pipeline.load_inbox", fake_load_inbox)
    monkeypatch.setattr("backend.pipeline.classify_all", fake_classify_all)
    monkeypatch.setattr(
        "backend.pipeline.process_comparison_requests", fake_process_comparison_requests
    )

    await run_pipeline(tmp_path, limit=2)

    assert received_emails["classify"] == fake_emails[:2]
    assert received_emails["process"] == fake_emails[:2]


@pytest.mark.asyncio
async def test_run_pipeline_no_limit_processes_everything(monkeypatch, tmp_path):
    fake_emails = [_email("e1"), _email("e2"), _email("e3")]

    def fake_load_inbox(data_dir, text_store=None):
        return iter(fake_emails)

    received_emails = {}

    async def fake_classify_all(emails, **kwargs):
        received_emails["classify"] = list(emails)
        return {}

    async def fake_process_comparison_requests(emails, classifications, **kwargs):
        return {}

    monkeypatch.setattr("backend.pipeline.load_inbox", fake_load_inbox)
    monkeypatch.setattr("backend.pipeline.classify_all", fake_classify_all)
    monkeypatch.setattr(
        "backend.pipeline.process_comparison_requests", fake_process_comparison_requests
    )

    await run_pipeline(tmp_path)

    assert received_emails["classify"] == fake_emails


# ---------------------------------------------------------------------------
# summarize_comparisons
# ---------------------------------------------------------------------------

def test_summarize_comparisons_counts_and_lists_problems():
    results = {
        "e1": {"status": "match", "message": NO_MISMATCH_MESSAGE},
        "e2": {"status": "mismatch", "incorrect_or_missing": ["port_of_discharge"]},
        "e3": {"status": "error", "message": "Could not uniquely identify an SI and a BL"},
    }

    report = summarize_comparisons(results)

    assert "emails processed: 3" in report
    assert "match: 1" in report
    assert "mismatch: 1" in report
    assert "error: 1" in report
    assert "MISMATCH e2: port_of_discharge" in report
    assert "ERROR e3: Could not uniquely identify an SI and a BL" in report


# ---------------------------------------------------------------------------
# main() -- CLI entry point (`python -m backend.pipeline [data_dir] [limit]`)
# ---------------------------------------------------------------------------

def test_main_parses_data_dir_and_limit_positional_args(monkeypatch, tmp_path, capsys):
    captured = {}

    async def fake_run_pipeline(data_dir, text_store=None, limit=None, **kwargs):
        captured["data_dir"] = data_dir
        captured["limit"] = limit
        return {}

    monkeypatch.setattr("backend.pipeline.run_pipeline", fake_run_pipeline)

    main(["prog", str(tmp_path), "5"])

    assert captured["data_dir"] == tmp_path
    assert captured["limit"] == 5
    assert "emails processed: 0" in capsys.readouterr().out


def test_main_without_limit_arg_defaults_to_none(monkeypatch, tmp_path):
    captured = {}

    async def fake_run_pipeline(data_dir, text_store=None, limit=None, **kwargs):
        captured["limit"] = limit
        return {}

    monkeypatch.setattr("backend.pipeline.run_pipeline", fake_run_pipeline)

    main(["prog", str(tmp_path)])

    assert captured["limit"] is None


def test_main_without_any_args_defaults_data_dir_too(monkeypatch):
    captured = {}

    async def fake_run_pipeline(data_dir, text_store=None, limit=None, **kwargs):
        captured["data_dir"] = data_dir
        captured["limit"] = limit
        return {}

    monkeypatch.setattr("backend.pipeline.run_pipeline", fake_run_pipeline)

    main(["prog"])

    assert captured["limit"] is None
    assert captured["data_dir"].name != ""  # resolved to repo root, not empty


def test_main_without_write_db_flag_never_calls_upsert_results(monkeypatch, tmp_path):
    async def fake_run_pipeline(data_dir, text_store=None, limit=None, **kwargs):
        return {"email_001": {"status": "match"}}

    monkeypatch.setattr("backend.pipeline.run_pipeline", fake_run_pipeline)
    fake_upsert = MagicMock()
    monkeypatch.setattr("backend.db.upsert_results", fake_upsert)

    main(["prog", str(tmp_path)])

    fake_upsert.assert_not_called()


def test_main_with_write_db_flag_upserts_the_run_results(monkeypatch, tmp_path, capsys):
    results = {"email_001": {"status": "match"}}

    async def fake_run_pipeline(data_dir, text_store=None, limit=None, **kwargs):
        return results

    monkeypatch.setattr("backend.pipeline.run_pipeline", fake_run_pipeline)
    fake_upsert = MagicMock(return_value=1)
    monkeypatch.setattr("backend.db.upsert_results", fake_upsert)

    main(["prog", str(tmp_path), "--write-db"])

    fake_upsert.assert_called_once_with("shared", results)
    assert "wrote 1 result(s) to MongoDB" in capsys.readouterr().out


def test_main_with_write_db_and_owner_flags_passes_owner_through(monkeypatch, tmp_path):
    async def fake_run_pipeline(data_dir, text_store=None, limit=None, **kwargs):
        return {}

    monkeypatch.setattr("backend.pipeline.run_pipeline", fake_run_pipeline)
    fake_upsert = MagicMock(return_value=0)
    monkeypatch.setattr("backend.db.upsert_results", fake_upsert)

    main(["prog", str(tmp_path), "--write-db", "--owner", "someone@example.com"])

    fake_upsert.assert_called_once_with("someone@example.com", {})