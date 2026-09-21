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