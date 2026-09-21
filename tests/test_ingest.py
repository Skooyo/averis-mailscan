from pathlib import Path

import pytest

from backend.ingest import load_email, load_inbox, parse_doc_type
from backend.readers import read_attachment

DATA_DIR = Path(__file__).resolve().parent.parent


def test_email_with_si_and_bl_txt_attachments():
    email = load_email(DATA_DIR / "inbox" / "email_001.json", DATA_DIR)
    assert email.email_id == "email_001"
    assert email.sender == "aziztz@safqa.co.ke"
    assert len(email.attachments) == 2
    assert {a.doc_type for a in email.attachments} == {"SI", "BL"}
    for att in email.attachments:
        assert att.ext == "txt"
        assert att.read_error is None
        assert att.text and len(att.text) > 50


def test_email_without_attachments():
    email = load_email(DATA_DIR / "inbox" / "email_002.json", DATA_DIR)
    assert email.attachments == []
    assert "invoice" in email.body.lower()


def test_missing_file_becomes_read_error(tmp_path):
    text, err = read_attachment(tmp_path / "nope.txt")
    assert text is None and err == "file_not_found"


def test_unsupported_extension(tmp_path):
    p = tmp_path / "x.zip"
    p.write_bytes(b"PK")
    text, err = read_attachment(p)
    assert text is None and err == "unsupported_extension"


def test_corrupt_pdf_does_not_raise(tmp_path):
    p = tmp_path / "bad.pdf"
    p.write_bytes(b"%PDF-1.5\n garbage")
    text, err = read_attachment(p)
    assert text is None and err


@pytest.mark.parametrize(
    "name,expected",
    [("email_001_SI.txt", "SI"), ("email_055_BL.docx", "BL"), ("readme.txt", "unknown")],
)
def test_parse_doc_type(name, expected):
    assert parse_doc_type(name) == expected


def test_full_inbox_shape():
    emails = list(load_inbox(DATA_DIR))
    assert len(emails) == 520
    assert sum(1 for e in emails if e.attachments) == 126
    assert sum(len(e.attachments) for e in emails) == 250
    # Every txt attachment must be readable; failures are only expected for PDFs.
    for e in emails:
        for a in e.attachments:
            if a.read_error:
                assert a.ext == "pdf", f"{a.path}: {a.read_error}"
