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

    try:
        pdf = pdfplumber.open(path)
    except Exception as open_error:
        # pdfplumber couldn't even open the file -- a broken container (bad
        # xref offset, missing trailer), not a scanned/image PDF (those open
        # fine; see the OCR fallback below, which only fires once pages are
        # already in hand). Try pikepdf's repair mode (qpdf's brute-force
        # object rescan) before giving up: it can rebuild a wrong xref table
        # (e.g. email_499_BL.pdf, where startxref pointed 50 bytes short of
        # the real xref keyword), but it can't invent a missing trailer
        # dictionary, so a genuinely gutted file (email_511/515_BL.pdf) still
        # fails here and the original pdfplumber error propagates unmasked.
        import io

        import pikepdf

        try:
            repaired = pikepdf.open(path)
            buf = io.BytesIO()
            repaired.save(buf)
            buf.seek(0)
            pdf = pdfplumber.open(buf)
        except Exception as repair_error:
            raise open_error from repair_error

    with pdf:
        pages = [page.extract_text() or "" for page in pdf.pages]
    text = "\n\n".join(pages)

    if not text.strip():
        # Image-only scanned PDF -- pdfplumber found no text layer. Try
        # Document AI OCR first; if it's not configured, or the live call
        # fails for a real reason, fall back to a vision-capable LLM
        # transcribing the page images (backend/ocr_llm.py) -- a last
        # resort only, never tried before Document AI, since a dedicated
        # OCR processor is more accurate than a general chat model. The LLM
        # fallback itself is further gated on ENABLE_LLM_OCR_FALLBACK=1 (see
        # backend/ocr_llm.py's docstring) so it never fires just because
        # AI_GATEWAY_API_KEY happens to be configured for other stages. If
        # neither is available, fall through to pdf_no_text_layer as before.
        from .ocr import OCRUnavailable, ocr_pdf

        doc_ai_error: Exception | None = None
        try:
            text = ocr_pdf(path)
        except OCRUnavailable:
            pass
        except Exception as e:
            doc_ai_error = e

        if not text.strip():
            from .ocr_llm import LLMOCRUnavailable, llm_ocr_pdf

            try:
                text = llm_ocr_pdf(path)
            except LLMOCRUnavailable:
                if doc_ai_error is not None:
                    # Document AI was configured and genuinely failed; the LLM
                    # fallback just isn't configured either -- surface the
                    # original, more specific failure rather than masking it.
                    raise doc_ai_error
                # neither fallback is configured -- pdf_no_text_layer, unchanged
            except Exception as llm_error:
                raise llm_error from doc_ai_error

    return text


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