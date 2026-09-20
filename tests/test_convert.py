import json
from pathlib import Path

import pytest

from backend.convert import REPORT_NAME, convert_attachment, convert_folder
from backend.readers import detect_format, read_attachment

ATTACHMENTS = Path(__file__).resolve().parent.parent / "attachments"
KEYWORDS = ("shipper", "consignee", "port")


@pytest.mark.parametrize(
    "name",
    ["email_001_SI.txt", "email_059_SI.pdf", "email_005_SI.xlsx", "email_055_BL.docx"],
)
def test_each_format_converts_to_readable_text(name, tmp_path):
    result = convert_attachment(ATTACHMENTS / name, tmp_path)
    assert result.ok, result.read_error
    out = tmp_path / f"{Path(name).stem}.txt"
    assert out.is_file()
    text = out.read_bytes().decode("utf-8")  # raises if not valid UTF-8
    assert text.strip()
    assert any(k in text.lower() for k in KEYWORDS), text[:200]
    assert result.chars == len(text)


def test_corrupt_pdf_fails_cleanly(tmp_path):
    result = convert_attachment(ATTACHMENTS / "email_511_BL.pdf", tmp_path)
    assert not result.ok
    assert result.read_error
    assert not list(tmp_path.iterdir())


def test_convert_folder_writes_report(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    for name in ["email_001_SI.txt", "email_511_BL.pdf"]:
        (src / name).write_bytes((ATTACHMENTS / name).read_bytes())
    out = tmp_path / "out"

    results = convert_folder(src, out)

    assert len(results) == 2
    report = json.loads((out / REPORT_NAME).read_text())
    assert report["converted"] == 1 and report["failed"] == 1
    assert (out / "email_001_SI.txt").is_file()
    assert not (out / "email_511_BL.txt").exists()


def test_extension_mismatch_detected(tmp_path):
    fake = tmp_path / "fake.pdf"
    fake.write_bytes(b"just some text pretending to be a pdf")
    assert detect_format(fake) == ("pdf", "extension_mismatch")
    assert read_attachment(fake) == (None, "extension_mismatch")


def test_ingest_prefers_text_store(tmp_path):
    from backend.ingest import load_attachment

    store = tmp_path / "store"
    store.mkdir()
    (store / "email_001_SI.txt").write_text("FROM STORE")
    att = load_attachment("attachments/email_001_SI.txt", ATTACHMENTS.parent, store)
    assert att.text == "FROM STORE" and att.read_error is None
