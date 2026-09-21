"""Extract plain text from attachment files.

Every reader is error-safe: failures are returned as a read_error string,
never raised. Downstream stages use read_error as an escalation signal.
"""

from pathlib import Path

ReadResult = tuple[str | None, str | None]  # (text, read_error)


def _read_txt(path: Path) -> str:
    # No errors="replace": genuinely malformed bytes must raise (caught by
    # read_attachment below and turned into a read_error) rather than silently
    # becoming "�" placeholders with no escalation signal.
    return path.read_text(encoding="utf-8")


def _read_pdf(path: Path) -> str:
    import pdfplumber

    with pdfplumber.open(path) as pdf:
        pages = [page.extract_text() or "" for page in pdf.pages]
    return "\n\n".join(pages)


def _read_xlsx(path: Path) -> str:
    import openpyxl

    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    lines: list[str] = []
    for ws in wb.worksheets:
        lines.append(f"## Sheet: {ws.title}")
        for row in ws.iter_rows(values_only=True):
            cells = ["" if c is None else str(c) for c in row]
            if any(cells):
                lines.append(" | ".join(cells))
    return "\n".join(lines)


def _read_docx(path: Path) -> str:
    import docx

    doc = docx.Document(path)
    lines = [p.text for p in doc.paragraphs if p.text.strip()]
    for table in doc.tables:
        for row in table.rows:
            lines.append(" | ".join(cell.text.strip() for cell in row.cells))
    return "\n".join(lines)


_READERS = {
    "txt": _read_txt,
    "pdf": _read_pdf,
    "xlsx": _read_xlsx,
    "docx": _read_docx,
}

# Leading bytes each binary format must start with. xlsx/docx are zip containers.
_MAGIC = {
    "pdf": (b"%PDF",),
    "xlsx": (b"PK\x03\x04",),
    "docx": (b"PK\x03\x04",),
}


def detect_format(path: Path) -> tuple[str, str | None]:
    """Return (ext, error). Error is set when the file's magic bytes contradict its extension."""
    ext = path.suffix.lstrip(".").lower()
    expected = _MAGIC.get(ext)
    if expected:
        with path.open("rb") as f:
            head = f.read(8)
        if not head.startswith(expected):
            return ext, "extension_mismatch"
    return ext, None


def read_attachment(path: Path) -> ReadResult:
    """Return (text, None) on success or (None, reason) on failure. Never raises."""
    if not path.is_file():
        return None, "file_not_found"

    ext, detect_error = detect_format(path)
    reader = _READERS.get(ext)
    if reader is None:
        return None, "unsupported_extension"
    if detect_error:
        return None, detect_error

    try:
        text = reader(path)
    except Exception as e:  # noqa: BLE001 - any failure becomes a read_error
        return None, f"{type(e).__name__}: {e}"

    if not text.strip():
        return None, "pdf_no_text_layer" if ext == "pdf" else "empty_document"
    return text, None