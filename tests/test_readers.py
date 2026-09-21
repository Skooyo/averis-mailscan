from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from backend.readers import _read_txt, detect_format, read_attachment


# ---------------------------------------------------------------------------
# _read_txt -- the UTF-8 encoding regression
# ---------------------------------------------------------------------------

def test_read_txt_decodes_non_ascii_correctly(tmp_path):
    p = tmp_path / "sample.txt"
    p.write_text("Gross Weight毛重(KGS): 20,532 KG", encoding="utf-8")

    text = _read_txt(p)

    assert "毛重" in text
    assert "æ¯›é‡" not in text  # the mojibake pattern this bug produced


def test_read_txt_passes_explicit_utf8_encoding(tmp_path):
    """Regression test: _read_txt must pass encoding="utf-8" explicitly to
    Path.read_text, not rely on the platform locale default (which is
    cp1252 on Windows and silently mangles non-ASCII text -- see the
    email_174_BL.txt "Gross Weight毛重(KGS)" -> "Gross Weightæ¯›é‡�(KGS)"
    bug). Spies on Path.read_text to check the actual kwargs passed,
    rather than relying on this sandbox's own locale, since that default
    happens to already be UTF-8 here and wouldn't otherwise catch a
    regression.
    """
    p = tmp_path / "sample.txt"
    p.write_text("Gross Weight毛重(KGS): 20,532 KG", encoding="utf-8")

    original_read_text = Path.read_text
    calls = []

    def spy(self, *args, **kwargs):
        if self == p:
            calls.append(kwargs)
        return original_read_text(self, *args, **kwargs)

    with patch.object(Path, "read_text", spy):
        _read_txt(p)

    assert calls, "Path.read_text was never called"
    assert calls[0].get("encoding") == "utf-8"


def test_read_txt_raises_on_invalid_bytes(tmp_path):
    # No errors="replace": genuinely malformed bytes must raise, so
    # read_attachment's try/except can turn this into a real read_error
    # instead of silently substituting "�" with no escalation signal.
    p = tmp_path / "bad_bytes.txt"
    p.write_bytes(b"Shipper: ACME\xff\xfeCorp")  # invalid UTF-8 sequence

    with pytest.raises(UnicodeDecodeError):
        _read_txt(p)


# ---------------------------------------------------------------------------
# detect_format
# ---------------------------------------------------------------------------

def test_detect_format_txt_has_no_magic_check(tmp_path):
    p = tmp_path / "file.txt"
    p.write_text("anything at all", encoding="utf-8")

    ext, error = detect_format(p)

    assert ext == "txt"
    assert error is None


def test_detect_format_flags_extension_mismatch(tmp_path):
    p = tmp_path / "fake.pdf"
    p.write_bytes(b"this is not a real pdf")  # missing %PDF magic bytes

    ext, error = detect_format(p)

    assert ext == "pdf"
    assert error == "extension_mismatch"


def test_detect_format_accepts_genuine_pdf_magic_bytes(tmp_path):
    p = tmp_path / "real.pdf"
    p.write_bytes(b"%PDF-1.4\n...")

    ext, error = detect_format(p)

    assert ext == "pdf"
    assert error is None


# ---------------------------------------------------------------------------
# read_attachment -- top-level orchestration, error paths
# ---------------------------------------------------------------------------

def test_read_attachment_success_roundtrip(tmp_path):
    p = tmp_path / "si.txt"
    p.write_text("Shipper: ACME PTE LTD\nPort of Loading: Singapore", encoding="utf-8")

    text, error = read_attachment(p)

    assert error is None
    assert "ACME PTE LTD" in text


def test_read_attachment_missing_file():
    text, error = read_attachment(Path("/nonexistent/path/does_not_exist.txt"))

    assert text is None
    assert error == "file_not_found"


def test_read_attachment_unsupported_extension(tmp_path):
    p = tmp_path / "file.xyz"
    p.write_text("content", encoding="utf-8")

    text, error = read_attachment(p)

    assert text is None
    assert error == "unsupported_extension"


def test_read_attachment_extension_mismatch(tmp_path):
    p = tmp_path / "fake.docx"
    p.write_bytes(b"not actually a docx/zip file")

    text, error = read_attachment(p)

    assert text is None
    assert error == "extension_mismatch"


def test_read_attachment_empty_document(tmp_path):
    p = tmp_path / "empty.txt"
    p.write_text("   \n  \n", encoding="utf-8")  # whitespace only

    text, error = read_attachment(p)

    assert text is None
    assert error == "empty_document"


def test_read_attachment_escalates_invalid_bytes_instead_of_masking_them(tmp_path):
    # End-to-end version of test_read_txt_raises_on_invalid_bytes: confirms the
    # public entry point turns the raise into a proper read_error rather than
    # either propagating it or (the old, now-removed behavior) silently
    # replacing the bad bytes with "�" and reporting success.
    p = tmp_path / "bad_bytes.txt"
    p.write_bytes(b"Shipper: ACME\xff\xfeCorp")

    text, error = read_attachment(p)

    assert text is None
    assert error is not None and error.startswith("UnicodeDecodeError")


def test_read_attachment_never_raises_on_reader_exception(tmp_path, monkeypatch):
    p = tmp_path / "si.txt"
    p.write_text("some content", encoding="utf-8")

    def boom(path):
        raise RuntimeError("simulated parser crash")

    monkeypatch.setitem(__import__("backend.readers", fromlist=["_READERS"])._READERS, "txt", boom)

    text, error = read_attachment(p)

    assert text is None
    assert error == "RuntimeError: simulated parser crash"


def test_read_pdf_repairs_broken_xref_via_pikepdf(tmp_path, monkeypatch):
    # pdfplumber can't even open the file (e.g. a startxref pointer that's off
    # by a few bytes) -- pikepdf's repair should rebuild it and pdfplumber
    # should then succeed on the repaired bytes.
    p = tmp_path / "broken_xref.pdf"
    p.write_bytes(b"%PDF-1.4\nnot actually parseable")

    import pdfplumber

    real_open = pdfplumber.open
    calls = []

    def fake_pdfplumber_open(target):
        calls.append(target)
        if target is p or target == p:
            raise Exception("Unexpected EOF")
        return _FakePdfWithText()

    class _FakeRepairedPdf:
        def save(self, buf):
            buf.write(b"repaired bytes")

    monkeypatch.setattr(pdfplumber, "open", fake_pdfplumber_open)
    monkeypatch.setattr("pikepdf.open", lambda path: _FakeRepairedPdf())

    text, error = read_attachment(p)

    assert error is None
    assert text == "recovered text"


def test_read_pdf_propagates_original_error_when_repair_also_fails(tmp_path, monkeypatch):
    # A genuinely gutted PDF (missing trailer, e.g. email_511/515_BL.pdf) --
    # pikepdf can't repair it either, so the original pdfplumber error should
    # surface, not a pikepdf-specific one.
    p = tmp_path / "unrecoverable.pdf"
    p.write_bytes(b"%PDF-1.4\nnot actually parseable")

    import pdfplumber

    def raise_open_error(path):
        raise Exception("No /Root object! - Is this really a PDF?")

    def raise_repair_error(path):
        raise Exception("unable to find trailer dictionary while recovering damaged file")

    monkeypatch.setattr(pdfplumber, "open", raise_open_error)
    monkeypatch.setattr("pikepdf.open", raise_repair_error)

    text, error = read_attachment(p)

    assert text is None
    assert error == "Exception: No /Root object! - Is this really a PDF?"


class _FakePdfWithText:
    class _FakePage:
        def extract_text(self):
            return "recovered text"

    pages = [_FakePage()]

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


class _FakePdfNoTextLayer:
    """Simulates pdfplumber.open() against an image-only scanned PDF."""

    class _FakePage:
        def extract_text(self):
            return None

    pages = [_FakePage()]

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


def test_read_pdf_falls_back_to_ocr_when_no_text_layer(tmp_path, monkeypatch):
    p = tmp_path / "scanned.pdf"
    p.write_bytes(b"%PDF-1.4\nfake scanned pdf, no text layer")

    import pdfplumber

    monkeypatch.setattr(pdfplumber, "open", lambda path: _FakePdfNoTextLayer())
    monkeypatch.setattr("backend.ocr.ocr_pdf", lambda path: "OCR recovered shipping text")

    text, error = read_attachment(p)

    assert error is None
    assert text == "OCR recovered shipping text"


def test_read_pdf_reports_pdf_no_text_layer_when_ocr_unconfigured(tmp_path, monkeypatch):
    p = tmp_path / "scanned.pdf"
    p.write_bytes(b"%PDF-1.4\nfake scanned pdf, no text layer")

    import pdfplumber

    from backend.ocr import OCRUnavailable
    from backend.ocr_llm import LLMOCRUnavailable

    monkeypatch.setattr(pdfplumber, "open", lambda path: _FakePdfNoTextLayer())

    def raise_unavailable(path):
        raise OCRUnavailable("not configured")

    def raise_llm_unavailable(path):
        raise LLMOCRUnavailable("not configured")

    monkeypatch.setattr("backend.ocr.ocr_pdf", raise_unavailable)
    monkeypatch.setattr("backend.ocr_llm.llm_ocr_pdf", raise_llm_unavailable)

    text, error = read_attachment(p)

    assert text is None
    assert error == "pdf_no_text_layer"


def test_read_pdf_propagates_real_ocr_failures_as_read_error(tmp_path, monkeypatch):
    # Document AI is configured but genuinely fails, and the LLM fallback
    # isn't configured either -- the original, more specific Document AI
    # error should surface, not get masked by the fallback being unavailable.
    p = tmp_path / "scanned.pdf"
    p.write_bytes(b"%PDF-1.4\nfake scanned pdf, no text layer")

    import pdfplumber

    from backend.ocr_llm import LLMOCRUnavailable

    monkeypatch.setattr(pdfplumber, "open", lambda path: _FakePdfNoTextLayer())

    def raise_real_error(path):
        raise RuntimeError("Document AI quota exceeded")

    def raise_llm_unavailable(path):
        raise LLMOCRUnavailable("not configured")

    monkeypatch.setattr("backend.ocr.ocr_pdf", raise_real_error)
    monkeypatch.setattr("backend.ocr_llm.llm_ocr_pdf", raise_llm_unavailable)

    text, error = read_attachment(p)

    assert text is None
    assert error == "RuntimeError: Document AI quota exceeded"


def test_read_pdf_falls_back_to_llm_vision_when_ocr_unconfigured(tmp_path, monkeypatch):
    # Document AI isn't configured at all -- the LLM vision fallback should
    # still be tried before giving up as pdf_no_text_layer.
    p = tmp_path / "scanned.pdf"
    p.write_bytes(b"%PDF-1.4\nfake scanned pdf, no text layer")

    import pdfplumber

    from backend.ocr import OCRUnavailable

    monkeypatch.setattr(pdfplumber, "open", lambda path: _FakePdfNoTextLayer())

    def raise_unavailable(path):
        raise OCRUnavailable("not configured")

    monkeypatch.setattr("backend.ocr.ocr_pdf", raise_unavailable)
    monkeypatch.setattr("backend.ocr_llm.llm_ocr_pdf", lambda path: "LLM-transcribed shipping text")

    text, error = read_attachment(p)

    assert error is None
    assert text == "LLM-transcribed shipping text"


def test_read_pdf_falls_back_to_llm_vision_when_ocr_fails_for_real(tmp_path, monkeypatch):
    # Document AI is configured but genuinely fails (not just unconfigured)
    # -- the LLM fallback should still get a shot, as the true last resort.
    p = tmp_path / "scanned.pdf"
    p.write_bytes(b"%PDF-1.4\nfake scanned pdf, no text layer")

    import pdfplumber

    monkeypatch.setattr(pdfplumber, "open", lambda path: _FakePdfNoTextLayer())

    def raise_real_error(path):
        raise RuntimeError("Document AI quota exceeded")

    monkeypatch.setattr("backend.ocr.ocr_pdf", raise_real_error)
    monkeypatch.setattr("backend.ocr_llm.llm_ocr_pdf", lambda path: "LLM-transcribed shipping text")

    text, error = read_attachment(p)

    assert error is None
    assert text == "LLM-transcribed shipping text"


def test_read_pdf_propagates_real_llm_vision_failures_as_read_error(tmp_path, monkeypatch):
    # Both fallbacks are configured; Document AI isn't, but the LLM vision
    # call itself genuinely fails -- that should surface, not get swallowed.
    p = tmp_path / "scanned.pdf"
    p.write_bytes(b"%PDF-1.4\nfake scanned pdf, no text layer")

    import pdfplumber

    from backend.ocr import OCRUnavailable

    monkeypatch.setattr(pdfplumber, "open", lambda path: _FakePdfNoTextLayer())

    def raise_unavailable(path):
        raise OCRUnavailable("not configured")

    def raise_llm_real_error(path):
        raise RuntimeError("Gateway 500")

    monkeypatch.setattr("backend.ocr.ocr_pdf", raise_unavailable)
    monkeypatch.setattr("backend.ocr_llm.llm_ocr_pdf", raise_llm_real_error)

    text, error = read_attachment(p)

    assert text is None
    assert error == "RuntimeError: Gateway 500"


def test_read_attachment_non_ascii_content_end_to_end(tmp_path):
    # Full regression test through the public entry point, not just _read_txt.
    p = tmp_path / "email_174_BL.txt"
    p.write_text(
        "BILL OF LADING (DRAFT)\nGross Weight毛重(KGS): 20,532 KG",
        encoding="utf-8",
    )

    text, error = read_attachment(p)

    assert error is None
    assert "毛重" in text
    assert "æ¯›é‡" not in text