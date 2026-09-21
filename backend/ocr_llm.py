"""backend/ocr_llm.py

Last-resort OCR fallback: when Document AI OCR (backend/ocr.py) is either
unavailable or itself fails, render the scanned PDF's pages to images and
ask a vision-capable model (via the Vercel AI Gateway) to transcribe the
text instead.

Deliberately never tried first. readers.py::_read_pdf's order is:
pdfplumber text layer -> Document AI OCR -> this module -> give up
(pdf_no_text_layer). This exists so a machine with no GCP Application
Default Credentials configured (see HANDOVER.md's "Known issues") still has
a shot at recovering text from a scanned document, not to replace Document
AI as the primary OCR path -- a dedicated OCR processor is more accurate
than asking a general chat model to transcribe an image, so this only fires
once that option is exhausted.

Not yet live-verified against a real scanned document (email_512-514) --
see HANDOVER.md.

Gated behind ENABLE_LLM_OCR_FALLBACK=1, deliberately separate from just
having AI_GATEWAY_API_KEY set. AI_GATEWAY_API_KEY is already configured on
any machine that runs classification/extraction -- if this fallback only
checked that, every plain `pytest tests/` or `backend.convert` run would
silently make real, billed vision-LLM calls the moment it touched a scanned
PDF (found live during development: test_ingest.py::test_full_inbox_shape
reads the real attachments/ folder unmocked and hit exactly this). Same
reasoning as RUN_LIVE_DB_TESTS=1 for tests/test_db.py's live Mongo test --
an env var already being set for other legitimate reasons shouldn't
silently enable a new expensive side effect.
"""

from __future__ import annotations

import base64
import io
import os
from pathlib import Path

from pydantic import BaseModel

from .llm import gateway_configured, vision_structured_completion

ENABLE_ENV_VAR = "ENABLE_LLM_OCR_FALLBACK"
MAX_PAGES = 5  # bound cost/time per call -- SI/BL documents in this dataset are 1-3 pages

SYSTEM_PROMPT = (
    "You are transcribing a scanned shipping-document page for a document-processing "
    "pipeline. Reply with the raw text visible on the page, verbatim, preserving line "
    "breaks where they separate distinct fields or table rows. Do not summarize, "
    "translate, paraphrase, or add commentary -- output only the transcription."
)


class LLMOCRUnavailable(Exception):
    """ENABLE_LLM_OCR_FALLBACK=1 isn't set, or no AI Gateway token is configured --
    either way there's no vision-capable provider to fall back to. Distinct from a
    real failure (bad response, rate limit, network) of a configured call, which
    propagates instead -- same convention as backend/ocr.py::OCRUnavailable vs. a
    genuine Document AI failure."""


class _PageTranscription(BaseModel):
    text: str


def _render_page_png_b64(page) -> str:
    image = page.to_image(resolution=200)
    buf = io.BytesIO()
    image.original.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def llm_ocr_pdf(path: Path, max_pages: int = MAX_PAGES) -> str:
    """Render up to `max_pages` pages of `path` to PNG images and transcribe each
    with one vision LLM call, joined with blank lines.

    Raises LLMOCRUnavailable immediately (no image rendering, no network call) if
    ENABLE_LLM_OCR_FALLBACK=1 isn't set, or if no Gateway token is configured.
    Any other failure -- rate limit, bad response, transport error -- propagates
    so the caller (readers.py::_read_pdf) can turn it into a real read_error
    instead of silently masking it as "no text layer".
    """
    if os.environ.get(ENABLE_ENV_VAR) != "1":
        raise LLMOCRUnavailable(
            f"{ENABLE_ENV_VAR}=1 is not set -- this fallback makes real, billed vision-LLM "
            "calls, so it's opt-in even when AI_GATEWAY_API_KEY is already configured for "
            "other pipeline stages"
        )
    if not gateway_configured():
        raise LLMOCRUnavailable("AI_GATEWAY_API_KEY is not set -- no vision-capable provider configured")

    import pdfplumber

    texts: list[str] = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages[:max_pages]:
            image_b64 = _render_page_png_b64(page)
            result = vision_structured_completion(
                SYSTEM_PROMPT,
                "Transcribe this page.",
                image_b64,
                _PageTranscription,
            )
            texts.append(result.text)
    return "\n\n".join(t for t in texts if t.strip())
