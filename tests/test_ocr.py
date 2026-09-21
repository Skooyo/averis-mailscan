from __future__ import annotations

from types import SimpleNamespace

import pytest

import backend.ocr as ocr
from backend.ocr import OCRUnavailable, ocr_pdf


@pytest.fixture(autouse=True)
def _reset_cached_client(monkeypatch):
    # get_documentai_client caches globally -- make sure one test's fake
    # client never leaks into the next.
    monkeypatch.setattr(ocr, "_documentai_client", None)


def _clear_env(monkeypatch):
    monkeypatch.delenv("PROJECT_ID", raising=False)
    monkeypatch.delenv("PROCESSOR_ID", raising=False)
    monkeypatch.delenv("LOCATION", raising=False)


def test_client_config_raises_when_unconfigured(monkeypatch):
    _clear_env(monkeypatch)

    with pytest.raises(OCRUnavailable):
        ocr._client_config()


def test_client_config_raises_when_partially_configured(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("PROJECT_ID", "proj")
    # PROCESSOR_ID / LOCATION left unset

    with pytest.raises(OCRUnavailable):
        ocr._client_config()


def test_ocr_pdf_raises_ocr_unavailable_without_calling_document_ai(monkeypatch, tmp_path):
    _clear_env(monkeypatch)

    def boom():
        raise AssertionError("Document AI client should never be constructed when unconfigured")

    monkeypatch.setattr(ocr, "get_documentai_client", lambda location: boom())

    with pytest.raises(OCRUnavailable):
        ocr_pdf(tmp_path / "scan.pdf")


def test_ocr_pdf_returns_document_text_when_configured(monkeypatch, tmp_path):
    monkeypatch.setenv("PROJECT_ID", "proj")
    monkeypatch.setenv("PROCESSOR_ID", "proc")
    monkeypatch.setenv("LOCATION", "asia-southeast1")

    pdf_path = tmp_path / "scan.pdf"
    pdf_path.write_bytes(b"%PDF-1.4 fake scanned content")

    fake_result = SimpleNamespace(document=SimpleNamespace(text="OCR'd shipping text"))

    class FakeClient:
        def processor_path(self, project_id, location, processor_id):
            assert (project_id, location, processor_id) == ("proj", "asia-southeast1", "proc")
            return f"projects/{project_id}/locations/{location}/processors/{processor_id}"

        def process_document(self, request):
            assert request.name.endswith("processors/proc")
            assert request.raw_document.mime_type == "application/pdf"
            assert request.raw_document.content == pdf_path.read_bytes()
            return fake_result

    fake_documentai_v1 = SimpleNamespace(
        RawDocument=lambda content, mime_type: SimpleNamespace(content=content, mime_type=mime_type),
        ProcessRequest=lambda name, raw_document: SimpleNamespace(name=name, raw_document=raw_document),
    )

    monkeypatch.setattr(ocr, "_documentai_module", lambda: fake_documentai_v1)
    monkeypatch.setattr(ocr, "get_documentai_client", lambda location: FakeClient())

    text = ocr_pdf(pdf_path)

    assert text == "OCR'd shipping text"


def test_ocr_pdf_returns_empty_string_when_document_text_is_none(monkeypatch, tmp_path):
    monkeypatch.setenv("PROJECT_ID", "proj")
    monkeypatch.setenv("PROCESSOR_ID", "proc")
    monkeypatch.setenv("LOCATION", "asia-southeast1")

    pdf_path = tmp_path / "scan.pdf"
    pdf_path.write_bytes(b"%PDF-1.4 fake")

    fake_result = SimpleNamespace(document=SimpleNamespace(text=None))

    class FakeClient:
        def processor_path(self, project_id, location, processor_id):
            return "projects/proj/locations/asia-southeast1/processors/proc"

        def process_document(self, request):
            return fake_result

    fake_documentai_v1 = SimpleNamespace(
        RawDocument=lambda content, mime_type: SimpleNamespace(content=content, mime_type=mime_type),
        ProcessRequest=lambda name, raw_document: SimpleNamespace(name=name, raw_document=raw_document),
    )

    monkeypatch.setattr(ocr, "_documentai_module", lambda: fake_documentai_v1)
    monkeypatch.setattr(ocr, "get_documentai_client", lambda location: FakeClient())

    assert ocr_pdf(pdf_path) == ""


def test_ocr_pdf_propagates_real_document_ai_failures(monkeypatch, tmp_path):
    monkeypatch.setenv("PROJECT_ID", "proj")
    monkeypatch.setenv("PROCESSOR_ID", "proc")
    monkeypatch.setenv("LOCATION", "asia-southeast1")

    pdf_path = tmp_path / "scan.pdf"
    pdf_path.write_bytes(b"%PDF-1.4 fake")

    class FakeClient:
        def processor_path(self, project_id, location, processor_id):
            return "projects/proj/locations/asia-southeast1/processors/proc"

        def process_document(self, request):
            raise RuntimeError("Document AI quota exceeded")

    fake_documentai_v1 = SimpleNamespace(
        RawDocument=lambda content, mime_type: SimpleNamespace(content=content, mime_type=mime_type),
        ProcessRequest=lambda name, raw_document: SimpleNamespace(name=name, raw_document=raw_document),
    )

    monkeypatch.setattr(ocr, "_documentai_module", lambda: fake_documentai_v1)
    monkeypatch.setattr(ocr, "get_documentai_client", lambda location: FakeClient())

    with pytest.raises(RuntimeError, match="quota exceeded"):
        ocr_pdf(pdf_path)
