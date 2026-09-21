"""LLM-based extraction of canonical SI/BL fields."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from .llm import astructured_completion, structured_completion

CACHE_PATH = Path(__file__).resolve().parent.parent / "data" / "extractions.json"

CanonicalField = Literal[
    "shipper",
    "consignee",
    "notify_party",
    "port_of_loading",
    "port_of_discharge",
    "container_count",
    "gross_weight_kg",
]

DocumentType = Literal["SI", "BL", "packing_list", "other"]


class ExtractedField(BaseModel):
    value: str | None = Field(
        description=(
            "Extracted value. Use null when the field is absent. "
            "For gross_weight_kg, convert the value to kilograms."
        )
    )
    confidence: float = Field(ge=0, le=1)
    evidence: str | None = Field(
        description="Verbatim source line supporting the value, or null."
    )


class Extraction(BaseModel):
    doc_type_detected: DocumentType
    shipper: ExtractedField
    consignee: ExtractedField
    notify_party: ExtractedField
    port_of_loading: ExtractedField
    port_of_discharge: ExtractedField
    container_count: ExtractedField
    gross_weight_kg: ExtractedField


SYSTEM_PROMPT = """You extract structured shipping data from documents.

Identify the document type as exactly one of:
SI, BL, packing_list, other.

Extract these canonical fields:
- shipper
- consignee
- notify_party
- port_of_loading
- port_of_discharge
- container_count
- gross_weight_kg

Known label variants:
- shipper: Shipper, Shipper/Exporter, Consignor
- consignee: Consignee, Consigned To
- notify_party: Notify Party, Notify, Notify Address
- port_of_loading: Port of Loading, POL, Load Port, Loading Port
- port_of_discharge: Port of Discharge, POD, Discharge Port, Destination Port
- container_count: Container Count, No. of Containers, container quantities such as 3 x 40HC
- gross_weight_kg: Gross Weight, G.W., Cargo Weight, Weight

Rules:
1. Never guess missing values. Use null and confidence 0.
2. Evidence must be the exact source line containing the value.
3. Convert tonnes, metric tonnes, and MT to kilograms.
4. Convert pounds or lbs to kilograms using 0.4536.
5. For container formats such as "3 x 40HC", extract 3.
6. Preserve the original company, person, and port names in value.
7. Return all seven fields, even when they are null.
8. Confidence must be between 0 and 1.
"""


def _document_text(attachment) -> str:
    """Read text from an attachment using the repository's common attributes."""

    for attribute in ("text", "converted_text", "content"):
        value = getattr(attachment, attribute, None)
        if isinstance(value, str) and value.strip():
            return value

    for attribute in ("text_path", "converted_path", "path"):
        value = getattr(attachment, attribute, None)
        if value:
            path = Path(value)
            if path.is_file():
                return path.read_text(encoding="utf-8", errors="replace")

    return ""


def _attachment_key(attachment) -> str:
    for attribute in ("path", "text_path", "converted_path", "filename", "name"):
        value = getattr(attachment, attribute, None)
        if value:
            return str(value)

    raise ValueError("Attachment has no usable cache key")


def _build_prompt(attachment) -> str:
    filename = (
        getattr(attachment, "filename", None)
        or getattr(attachment, "name", None)
        or _attachment_key(attachment)
    )
    text = _document_text(attachment)

    return (
        f"Filename: {filename}\n"
        f"Declared document type: {getattr(attachment, 'doc_type', 'unknown')}\n\n"
        "DOCUMENT TEXT:\n"
        f"{text}"
    )


def extract_attachment(attachment) -> Extraction:
    """Extract canonical fields from one readable attachment."""

    if getattr(attachment, "read_error", None):
        raise ValueError(f"Attachment is unreadable: {attachment.read_error}")

    text = _document_text(attachment)
    if not text.strip():
        raise ValueError("Attachment contains no readable text")

    return structured_completion(
        SYSTEM_PROMPT,
        _build_prompt(attachment),
        Extraction,
    )


async def aextract_attachment(attachment) -> Extraction:
    """Async version of extract_attachment."""

    if getattr(attachment, "read_error", None):
        raise ValueError(f"Attachment is unreadable: {attachment.read_error}")

    text = _document_text(attachment)
    if not text.strip():
        raise ValueError("Attachment contains no readable text")

    return await astructured_completion(
        SYSTEM_PROMPT,
        _build_prompt(attachment),
        Extraction,
    )


def load_cache(path: Path = CACHE_PATH) -> dict[str, Extraction]:
    if not path.is_file():
        return {}

    raw = json.loads(path.read_text(encoding="utf-8"))
    return {key: Extraction.model_validate(value) for key, value in raw.items()}


def save_cache(cache: dict[str, Extraction], path: Path = CACHE_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    output = {
        key: cache[key].model_dump()
        for key in sorted(cache)
    }
    path.write_text(
        json.dumps(output, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


async def extract_all(
    attachments: list,
    concurrency: int = 1,
    force: bool = False,
    cache_path: Path = CACHE_PATH,
    progress: bool = False,
) -> dict[str, Extraction]:
    """Extract all readable attachments and cache each completed result."""

    cache = {} if force else load_cache(cache_path)
    todo = []

    for attachment in attachments:
        key = _attachment_key(attachment)

        if key in cache:
            continue

        if getattr(attachment, "read_error", None):
            continue

        if not _document_text(attachment).strip():
            continue

        todo.append((key, attachment))

    semaphore = asyncio.Semaphore(concurrency)
    lock = asyncio.Lock()
    completed = 0

    async def process(key: str, attachment) -> None:
        nonlocal completed

        async with semaphore:
            result = await aextract_attachment(attachment)

        async with lock:
            cache[key] = result
            save_cache(cache, cache_path)
            completed += 1

            if progress:
                print(f"  {completed}/{len(todo)} extracted", flush=True)

    await asyncio.gather(
        *(process(key, attachment) for key, attachment in todo)
    )

    return cache