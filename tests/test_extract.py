from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Optional

import pytest

from backend.extract import (
    Extraction,
    ExtractedField,
    aextract_attachment,
    extract_all,
    extract_attachment,
    load_cache,
    save_cache,
)

EXPECTED_FIELDS = {
    "shipper",
    "consignee",
    "notify_party",
    "port_of_loading",
    "port_of_discharge",
    "container_count",
    "gross_weight_kg",
}


@dataclass
class FakeAttachment:
    """Minimal stand-in for the real attachment object. Exposes exactly the
    attributes backend.extract reads via getattr (path / text / filename /
    doc_type / read_error) -- nothing more -- so tests don't depend on
    whatever concrete Attachment class the rest of the app uses.
    """

    path: str
    text: Optional[str] = None
    filename: Optional[str] = None
    doc_type: str = "unknown"
    read_error: Optional[str] = None


SAMPLE_SI_TEXT = """
SHIPPING INSTRUCTION

Shipper: ACME PTE LTD
Consignee: Global Trading LLC
Notify Party: Global Trading LLC
Port of Loading: Singapore
Port of Discharge: Port Klang
Container Count: 3 x 40HC
Gross Weight: 12.5 MT
"""


def _field(value, confidence=0.99, evidence="evidence line"):
    return ExtractedField(value=value, confidence=confidence, evidence=evidence)


def _sample_extraction() -> Extraction:
    """A fully-populated Extraction matching SAMPLE_SI_TEXT, using the real
    nested ExtractedField shape the schema actually requires (not flat
    strings).
    """
    return Extraction(
        doc_type_detected="SI",
        shipper=_field("ACME PTE LTD", evidence="Shipper: ACME PTE LTD"),
        consignee=_field("Global Trading LLC", evidence="Consignee: Global Trading LLC"),
        notify_party=_field("Global Trading LLC", evidence="Notify Party: Global Trading LLC"),
        port_of_loading=_field("Singapore", evidence="Port of Loading: Singapore"),
        port_of_discharge=_field("Port Klang", evidence="Port of Discharge: Port Klang"),
        container_count=_field("3", evidence="Container Count: 3 x 40HC"),
        gross_weight_kg=_field("12500", evidence="Gross Weight: 12.5 MT"),
    )


# ---------------------------------------------------------------------------
# extract_attachment (sync) / aextract_attachment (async) -- single document
# ---------------------------------------------------------------------------

def test_extract_attachment_returns_schema_populated_by_llm(monkeypatch):
    attachment = FakeAttachment(path="si_001.txt", text=SAMPLE_SI_TEXT, doc_type="SI")
    expected = _sample_extraction()

    def fake_structured_completion(system, user, schema):
        # extract_attachment calls positionally: (SYSTEM_PROMPT, prompt, Extraction)
        assert schema is Extraction
        assert "Shipper: ACME PTE LTD" in user
        return expected

    monkeypatch.setattr("backend.extract.structured_completion", fake_structured_completion)

    result = extract_attachment(attachment)

    assert result == expected
    assert result.shipper.value == "ACME PTE LTD"
    assert result.gross_weight_kg.value == "12500"
    assert result.doc_type_detected == "SI"


def test_extract_attachment_raises_on_read_error():
    attachment = FakeAttachment(path="broken.pdf", text=None, read_error="OCR failed")
    with pytest.raises(ValueError, match="unreadable"):
        extract_attachment(attachment)


def test_extract_attachment_raises_on_empty_text():
    attachment = FakeAttachment(path="empty.txt", text="   ")
    with pytest.raises(ValueError, match="no readable text"):
        extract_attachment(attachment)


@pytest.mark.asyncio
async def test_aextract_attachment_calls_async_completion(monkeypatch):
    attachment = FakeAttachment(path="si_001.txt", text=SAMPLE_SI_TEXT, doc_type="SI")
    expected = _sample_extraction()

    async def fake_astructured_completion(system, user, schema):
        assert schema is Extraction
        return expected

    monkeypatch.setattr("backend.extract.astructured_completion", fake_astructured_completion)

    result = await aextract_attachment(attachment)
    assert result == expected


# ---------------------------------------------------------------------------
# extract_all -- batch extraction, caching, skip rules, concurrency
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_extract_all_extracts_and_caches_new_attachment(monkeypatch, tmp_path):
    attachment = FakeAttachment(path="si_001.txt", text=SAMPLE_SI_TEXT, doc_type="SI")
    expected = _sample_extraction()
    cache_path = tmp_path / "extractions.json"

    async def fake_astructured_completion(system, user, schema):
        return expected

    monkeypatch.setattr("backend.extract.astructured_completion", fake_astructured_completion)

    result = await extract_all([attachment], cache_path=cache_path)

    # extract_all returns {attachment_key: Extraction}, not a flat field dict.
    assert set(result) == {"si_001.txt"}
    extraction = result["si_001.txt"]
    assert extraction.shipper.value == "ACME PTE LTD"
    assert extraction.consignee.value == "Global Trading LLC"
    assert extraction.notify_party.value == "Global Trading LLC"
    assert extraction.port_of_loading.value == "Singapore"
    assert extraction.port_of_discharge.value == "Port Klang"
    assert extraction.container_count.value == "3"
    assert extraction.gross_weight_kg.value == "12500"
    assert extraction.doc_type_detected == "SI"
    assert set(Extraction.model_fields) - {"doc_type_detected"} == EXPECTED_FIELDS

    # Persisted to the caller-supplied cache file, not the module default.
    assert cache_path.is_file()
    reloaded = load_cache(cache_path)
    assert reloaded["si_001.txt"] == expected


@pytest.mark.asyncio
async def test_extract_all_skips_unreadable_attachment(monkeypatch, tmp_path):
    attachment = FakeAttachment(path="broken.pdf", text=None, read_error="OCR failed")
    calls = []

    async def fake_astructured_completion(system, user, schema):
        calls.append(1)
        return _sample_extraction()

    monkeypatch.setattr("backend.extract.astructured_completion", fake_astructured_completion)

    result = await extract_all([attachment], cache_path=tmp_path / "extractions.json")

    assert result == {}
    assert calls == []


@pytest.mark.asyncio
async def test_extract_all_skips_attachment_with_no_text(monkeypatch, tmp_path):
    attachment = FakeAttachment(path="empty.txt", text="   ")
    calls = []

    async def fake_astructured_completion(system, user, schema):
        calls.append(1)
        return _sample_extraction()

    monkeypatch.setattr("backend.extract.astructured_completion", fake_astructured_completion)

    result = await extract_all([attachment], cache_path=tmp_path / "extractions.json")

    assert result == {}
    assert calls == []


@pytest.mark.asyncio
async def test_extract_all_uses_existing_cache_without_recomputing(monkeypatch, tmp_path):
    attachment = FakeAttachment(path="si_001.txt", text=SAMPLE_SI_TEXT, doc_type="SI")
    cached = _sample_extraction()
    cache_path = tmp_path / "extractions.json"
    save_cache({"si_001.txt": cached}, cache_path)

    calls = []

    async def fake_astructured_completion(system, user, schema):
        calls.append(1)
        raise AssertionError("should not call the LLM for an already-cached attachment")

    monkeypatch.setattr("backend.extract.astructured_completion", fake_astructured_completion)

    result = await extract_all([attachment], cache_path=cache_path)

    assert calls == []
    assert result["si_001.txt"] == cached


@pytest.mark.asyncio
async def test_extract_all_force_recomputes_even_if_cached(monkeypatch, tmp_path):
    attachment = FakeAttachment(path="si_001.txt", text=SAMPLE_SI_TEXT, doc_type="SI")
    stale = _sample_extraction()
    stale.shipper.value = "STALE SHIPPER"
    cache_path = tmp_path / "extractions.json"
    save_cache({"si_001.txt": stale}, cache_path)

    fresh = _sample_extraction()

    async def fake_astructured_completion(system, user, schema):
        return fresh

    monkeypatch.setattr("backend.extract.astructured_completion", fake_astructured_completion)

    result = await extract_all([attachment], cache_path=cache_path, force=True)

    assert result["si_001.txt"].shipper.value == "ACME PTE LTD"


@pytest.mark.asyncio
async def test_extract_all_respects_concurrency_limit(monkeypatch, tmp_path):
    attachments = [
        FakeAttachment(path=f"si_{i}.txt", text=SAMPLE_SI_TEXT, doc_type="SI")
        for i in range(5)
    ]
    in_flight = 0
    max_in_flight = 0

    async def fake_astructured_completion(system, user, schema):
        nonlocal in_flight, max_in_flight
        in_flight += 1
        max_in_flight = max(max_in_flight, in_flight)
        await asyncio.sleep(0)  # yield so overlapping calls are possible
        in_flight -= 1
        return _sample_extraction()

    monkeypatch.setattr("backend.extract.astructured_completion", fake_astructured_completion)

    result = await extract_all(
        attachments, cache_path=tmp_path / "extractions.json", concurrency=2
    )

    assert len(result) == 5
    assert max_in_flight <= 2