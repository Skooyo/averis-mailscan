"""backend/ocr.py

Google Document AI OCR fallback for scanned (image-only) PDFs pdfplumber
can't extract a text layer from -- e.g. email_512-514 in the sample
inbox, which readers.py's read_attachment reports as pdf_no_text_layer.

Generalizes the one-off experiment in OCRApi.py (hard-coded to a single
test file, and read `.entities`, meant for a form-parser-style processor)
into a reusable function readers.py's _read_pdf calls automatically
whenever the primary pdfplumber pass comes back empty. This module reads
Document.text (the processor's full recognized text) instead, since it
needs to work as a generic fallback across arbitrary shipping documents,
not one processor/document type OCRApi.py happened to be tested against.

Configuration (env vars, see .env.example):
- PROJECT_ID    Google Cloud project id
- PROCESSOR_ID  Document AI processor id (an OCR-capable processor)
- LOCATION      Processor region, e.g. "asia-southeast1"

If any of the three is unset, OCRUnavailable is raised immediately --
readers.py catches that specifically and falls back to today's
pdf_no_text_layer behavior, so environments without Document AI configured
(a teammate's machine, CI) are unaffected. Any other failure (bad
credentials, quota, network, processor rejects the file) is left to
propagate -- that's a real error worth surfacing via read_error/escalation,
not something to silently mask as "no text layer".
"""

from __future__ import annotations

import os
from pathlib import Path

_documentai_client = None


class OCRUnavailable(Exception):
    """Document AI isn't configured (PROJECT_ID/PROCESSOR_ID/LOCATION unset)."""


def _client_config() -> tuple[str, str, str]:
    project_id = os.environ.get("PROJECT_ID")
    processor_id = os.environ.get("PROCESSOR_ID")
    location = os.environ.get("LOCATION")
    if not (project_id and processor_id and location):
        raise OCRUnavailable(
            "PROJECT_ID, PROCESSOR_ID, and LOCATION must all be set to use "
            "Document AI OCR -- see .env.example"
        )
    return project_id, processor_id, location


def _documentai_module():
    from google.cloud import documentai_v1

    return documentai_v1


def get_documentai_client(location: str):
    """Cached Document AI client, region-pinned via api_endpoint."""
    global _documentai_client
    if _documentai_client is None:
        from google.api_core.client_options import ClientOptions

        documentai_v1 = _documentai_module()
        _documentai_client = documentai_v1.DocumentProcessorServiceClient(
            client_options=ClientOptions(api_endpoint=f"{location}-documentai.googleapis.com")
        )
    return _documentai_client


def ocr_pdf(path: Path) -> str:
    """Run a scanned PDF through Document AI OCR and return its text.

    Raises OCRUnavailable if not configured; any other exception is a
    genuine Document AI failure and is left to propagate to the caller.
    """
    project_id, processor_id, location = _client_config()
    documentai_v1 = _documentai_module()
    client = get_documentai_client(location)
    processor_name = client.processor_path(project_id, location, processor_id)

    request = documentai_v1.ProcessRequest(
        name=processor_name,
        raw_document=documentai_v1.RawDocument(
            content=path.read_bytes(),
            mime_type="application/pdf",
        ),
    )
    result = client.process_document(request=request)
    return result.document.text or ""
