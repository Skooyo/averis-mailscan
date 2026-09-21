from __future__ import annotations

from types import SimpleNamespace

import pytest

import backend.ocr_llm as ocr_llm
from backend.ocr_llm import LLMOCRUnavailable, llm_ocr_pdf


def _clear_gateway_env(monkeypatch):
    monkeypatch.delenv("AI_GATEWAY_API_KEY", raising=False)
    monkeypatch.delenv("VERCEL_OIDC_TOKEN", raising=False)


def _enable_fallback(monkeypatch):
    monkeypatch.setenv("ENABLE_LLM_OCR_FALLBACK", "1")


def test_llm_ocr_pdf_raises_unavailable_when_not_opted_in(monkeypatch, tmp_path):
    # Gateway configured, but ENABLE_LLM_OCR_FALLBACK isn't set -- must not
    # render or call out, even though AI_GATEWAY_API_KEY alone would be enough
    # for every other LLM stage in this pipeline.
    monkeypatch.delenv("ENABLE_LLM_OCR_FALLBACK", raising=False)
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "fake-key")

    def boom(path):
        raise AssertionError("pdfplumber.open should never be called without ENABLE_LLM_OCR_FALLBACK=1")

    monkeypatch.setattr("pdfplumber.open", boom)

    with pytest.raises(LLMOCRUnavailable):
        llm_ocr_pdf(tmp_path / "scan.pdf")


def test_llm_ocr_pdf_raises_unavailable_without_rendering_or_calling_gateway(monkeypatch, tmp_path):
    _enable_fallback(monkeypatch)
    _clear_gateway_env(monkeypatch)

    def boom(path):
        raise AssertionError("pdfplumber.open should never be called when the Gateway isn't configured")

    monkeypatch.setattr("pdfplumber.open", boom)

    with pytest.raises(LLMOCRUnavailable):
        llm_ocr_pdf(tmp_path / "scan.pdf")


class _FakeImage:
    def __init__(self):
        self.original = SimpleNamespace(save=lambda buf, format: buf.write(b"fake-png-bytes"))


class _FakePage:
    def to_image(self, resolution):
        assert resolution == 200
        return _FakeImage()


class _FakePdf:
    def __init__(self, n_pages):
        self.pages = [_FakePage() for _ in range(n_pages)]

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


def test_llm_ocr_pdf_transcribes_each_page_and_joins_them(monkeypatch, tmp_path):
    _enable_fallback(monkeypatch)
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "fake-key")
    monkeypatch.setattr("pdfplumber.open", lambda path: _FakePdf(2))

    calls = []

    def fake_vision_completion(system, user, image_b64, schema):
        calls.append((system, user, image_b64))
        return schema(text=f"page {len(calls)} text")

    monkeypatch.setattr(ocr_llm, "vision_structured_completion", fake_vision_completion)

    text = llm_ocr_pdf(tmp_path / "scan.pdf")

    assert text == "page 1 text\n\npage 2 text"
    assert len(calls) == 2
    assert all(c[2] == "ZmFrZS1wbmctYnl0ZXM=" for c in calls)  # base64("fake-png-bytes")


def test_llm_ocr_pdf_respects_max_pages(monkeypatch, tmp_path):
    _enable_fallback(monkeypatch)
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "fake-key")
    monkeypatch.setattr("pdfplumber.open", lambda path: _FakePdf(10))

    calls = []
    monkeypatch.setattr(
        ocr_llm,
        "vision_structured_completion",
        lambda system, user, image_b64, schema: (calls.append(1), schema(text="x"))[1],
    )

    llm_ocr_pdf(tmp_path / "scan.pdf", max_pages=3)

    assert len(calls) == 3


def test_llm_ocr_pdf_propagates_real_gateway_failures(monkeypatch, tmp_path):
    _enable_fallback(monkeypatch)
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "fake-key")
    monkeypatch.setattr("pdfplumber.open", lambda path: _FakePdf(1))

    def raise_real_error(system, user, image_b64, schema):
        raise RuntimeError("Gateway 500")

    monkeypatch.setattr(ocr_llm, "vision_structured_completion", raise_real_error)

    with pytest.raises(RuntimeError, match="Gateway 500"):
        llm_ocr_pdf(tmp_path / "scan.pdf")
