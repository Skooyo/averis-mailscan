"""
backend/compare.py

Deterministic comparison of Shipping Instruction (SI) values against
Bill of Lading (BL) values.

This module contains no LLM calls. Every normalization rule from the
project checklist -- case/whitespace, punctuation, company suffixes,
port label equivalence, container expressions, weight units -- is
implemented as a small, independently testable function, so results are
reproducible and auditable (same input always gives the same output).

backend/comparison.py (the LLM-based comparator) is kept, but demoted to
an optional fallback: `compare_documents` always decides "match" on its
own, and `compare_documents_with_fallback` only consults the LLM to
double-check the specific fields this module flagged as mismatched, in
case of unusual free-text wording the deterministic rules don't cover.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Canonical field list (must match backend/extract.py's output keys)
# ---------------------------------------------------------------------------

FIELDS: Tuple[str, ...] = (
    "shipper",
    "consignee",
    "notify_party",
    "port_of_loading",
    "port_of_discharge",
    "container_count",
    "gross_weight_kg",
)

NO_MISMATCH_MESSAGE = "No mismatch detected"

_TEXT_FIELDS = {"shipper", "consignee", "notify_party"}
_PORT_FIELDS = {"port_of_loading", "port_of_discharge"}


# ---------------------------------------------------------------------------
# Generic text normalization (case, whitespace, punctuation)
# ---------------------------------------------------------------------------

_WHITESPACE_RE = re.compile(r"\s+")
_PUNCT_RE = re.compile(r"[.,;:!?'\"()\[\]{}/\\]")


def _strip_accents(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in normalized if not unicodedata.combining(ch))


def normalize_text(value: Any) -> str:
    """Lowercase, strip accents/punctuation, collapse whitespace."""
    if value is None:
        return ""
    text = _strip_accents(str(value))
    text = text.lower()
    text = _PUNCT_RE.sub(" ", text)
    text = _WHITESPACE_RE.sub(" ", text).strip()
    return text


# ---------------------------------------------------------------------------
# Company suffix normalization (shipper / consignee / notify_party)
# ---------------------------------------------------------------------------

# Longest/most-specific phrases first. Matched after normalize_text has
# already lowercased and stripped punctuation, so entries here have no
# periods (e.g. "pte ltd" catches "Pte. Ltd." and "PTE LTD").
_COMPANY_SUFFIXES = [
    "public limited company",
    "private limited",
    "limited liability company",
    "sendirian berhad",
    "sdn bhd",
    "pte ltd",
    "pte limited",
    "co ltd",
    "company limited",
    "corporation",
    "incorporated",
    "limited",
    "gmbh",
    "l l c",
    "llc",
    "inc",
    "ltd",
    "corp",
    "plc",
    "co",
    "sa",
    "nv",
    "bv",
    "ag",
]

_COMPANY_SUFFIX_RE = re.compile(
    r"\b(" + "|".join(re.escape(s) for s in _COMPANY_SUFFIXES) + r")\s*$"
)


def normalize_company_name(value: Any) -> str:
    """Normalize a company name for comparison: fold case/punctuation and
    strip trailing legal-entity suffixes so 'ACME PTE LTD' == 'Acme Pte. Ltd.'
    """
    text = normalize_text(value)
    prev = None
    while prev != text:
        prev = text
        text = _COMPANY_SUFFIX_RE.sub("", text).strip()
    return text


# ---------------------------------------------------------------------------
# Port label normalization
# ---------------------------------------------------------------------------

_PORT_FILLER_WORDS = {"port", "of", "the", "harbor", "harbour", "terminal"}

# Small, easily-extended alias table for common short forms / codes.
# In production this should be backed by a real UN/LOCODE reference file;
# this inline table just covers the equivalences seen in practice so far.
_PORT_ALIASES: Dict[str, str] = {
    "spore": "singapore",
    "sg": "singapore",
    "sgsin": "singapore",
    "pelabuhan klang": "klang",
    "hk": "hong kong",
    "hongkong": "hong kong",
    "hkhkg": "hong kong",
    "ny": "new york",
    "nyc": "new york",
    "la": "los angeles",
    "lax": "los angeles",
}


_PORT_CODE_RE = re.compile(r"\(([A-Za-z]{2}[A-Za-z0-9]{3})\)")


def _extract_port_code(value: Any) -> Optional[str]:
    """Pull a bracketed UN/LOCODE-style code out of a port string, e.g.
    "Ho Chi Minh City, Vietnam (VNSGN)" -> "VNSGN". Returns None if no such
    code is present.
    """
    if value is None:
        return None
    match = _PORT_CODE_RE.search(str(value))
    return match.group(1).upper() if match else None


def normalize_port(value: Any) -> str:
    """Normalize a port name: drop a bracketed UN/LOCODE-style code if
    present (e.g. "(SGSIN)"), strip filler words ('port of ...'), then
    resolve known short forms/aliases to a canonical name.
    """
    if value is None:
        return ""
    text = _PORT_CODE_RE.sub("", str(value))
    text = normalize_text(text)
    tokens = [t for t in text.split(" ") if t and t not in _PORT_FILLER_WORDS]
    text = " ".join(tokens)
    return _PORT_ALIASES.get(text, text)


def ports_equal(a: Any, b: Any) -> bool:
    """Compare two port fields. When BOTH sides carry a bracketed
    UN/LOCODE-style code (e.g. "(SGSIN)"), the code is treated as
    authoritative and compared directly -- it's immune to spelling or
    spacing differences in the place name itself (e.g. the source data
    has been seen writing the same city as both "Ho Chi Minh City" and
    the concatenated "HOCHIMINH", which would otherwise normalize to two
    different strings and falsely flag as a mismatch). Falls back to the
    text-based normalize_port comparison whenever either side lacks a
    code (normalize_port itself also strips a lone code before comparing,
    so a coded value still matches an equivalent uncoded one). A code
    mismatch is NOT overridden by matching text -- if the codes disagree,
    that's flagged even if the place names look similar, since a wrong
    code is exactly the kind of discrepancy this tool exists to catch,
    not silently ignore.
    """
    code_a, code_b = _extract_port_code(a), _extract_port_code(b)
    if code_a and code_b:
        return code_a == code_b
    return normalize_port(a) == normalize_port(b)


# ---------------------------------------------------------------------------
# Container expression normalization, e.g. "3 x 40HC", "2X20GP + 1X40HC"
# ---------------------------------------------------------------------------

_CONTAINER_TYPE_ALIASES = {
    "gp": "GP",
    "general purpose": "GP",
    "dry": "GP",
    "dc": "GP",
    "hc": "HC",
    "high cube": "HC",
    "hq": "HC",
    "rf": "RF",
    "reefer": "RF",
    "refrigerated": "RF",
    "ot": "OT",
    "open top": "OT",
    "fr": "FR",
    "flat rack": "FR",
    "tk": "TK",
    "tank": "TK",
}

_CONTAINER_ITEM_RE = re.compile(
    r"(?P<count>\d+)\s*[x×]\s*(?P<size>\d{2,3})\s*(?:'|ft|feet)?\s*"
    r"(?P<type>[a-zA-Z ]*)",
    re.IGNORECASE,
)

_NUMBER_RE = re.compile(r"\d+(?:\.\d+)?")


@dataclass(frozen=True)
class ContainerItem:
    count: int
    size: str
    type: str


def parse_container_expression(value: Any) -> Optional[List[ContainerItem]]:
    """Parse strings like "3 x 40HC" or "2X20GP + 1X40HC" into an
    order-independent list of ContainerItem. Returns None if no
    "count x size" pattern is found, so the caller can fall back to a
    plain numeric or text comparison.
    """
    if value is None:
        return None
    items: List[ContainerItem] = []
    for match in _CONTAINER_ITEM_RE.finditer(str(value)):
        count = int(match.group("count"))
        size = match.group("size")
        raw_type = normalize_text(match.group("type"))
        ctype = _CONTAINER_TYPE_ALIASES.get(raw_type)
        if ctype is None:
            collapsed = raw_type.upper().replace(" ", "")
            ctype = collapsed or "GP"
        items.append(ContainerItem(count=count, size=size, type=ctype))
    return items or None


def _extract_number(value: Any) -> Optional[float]:
    if value is None:
        return None
    match = _NUMBER_RE.search(str(value))
    return float(match.group()) if match else None


def containers_equal(a: Any, b: Any) -> bool:
    parsed_a = parse_container_expression(a)
    parsed_b = parse_container_expression(b)
    if parsed_a is not None and parsed_b is not None:
        key = lambda i: (i.size, i.type, i.count)
        return sorted(parsed_a, key=key) == sorted(parsed_b, key=key)

    # Fall back to comparing bare numbers (e.g. "3" vs "3 containers")
    num_a, num_b = _extract_number(a), _extract_number(b)
    if num_a is not None and num_b is not None:
        return num_a == num_b

    return normalize_text(a) == normalize_text(b)


# ---------------------------------------------------------------------------
# Weight unit normalization (kg, MT, tonnes, lb, ...)
# ---------------------------------------------------------------------------

_WEIGHT_UNIT_TO_KG = {
    "kg": 1.0,
    "kgs": 1.0,
    "kilogram": 1.0,
    "kilograms": 1.0,
    "mt": 1000.0,
    "ton": 1000.0,          # assumes metric ton unless "short"/"long" is specified
    "tons": 1000.0,
    "tonne": 1000.0,
    "tonnes": 1000.0,
    "metricton": 1000.0,
    "metrictons": 1000.0,
    "lb": 0.45359237,
    "lbs": 0.45359237,
    "pound": 0.45359237,
    "pounds": 0.45359237,
}

_WEIGHT_RE = re.compile(
    r"(?P<value>\d+(?:\.\d+)?)\s*(?P<unit>kgs?|kilograms?|mt|metric\s*tons?|tonnes?|tons?|lbs?|pounds?)?",
    re.IGNORECASE,
)

WEIGHT_TOLERANCE_KG = 1.0  # absorbs rounding differences between source docs


def parse_weight_kg(value: Any) -> Optional[float]:
    """Parse a weight expression (e.g. "12.5 MT", "12,500 kg", "27558 lb")
    into kilograms. Unit defaults to kg if omitted. Returns None if no
    numeric value can be found.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).replace(",", "")
    match = _WEIGHT_RE.search(text)
    if not match or not match.group("value"):
        return None
    amount = float(match.group("value"))
    unit_raw = _WHITESPACE_RE.sub("", (match.group("unit") or "kg").lower())
    factor = _WEIGHT_UNIT_TO_KG.get(unit_raw) or _WEIGHT_UNIT_TO_KG.get(unit_raw.rstrip("s"))
    if factor is None:
        return None
    return amount * factor


def weights_equal(a: Any, b: Any, tolerance_kg: float = WEIGHT_TOLERANCE_KG) -> bool:
    kg_a, kg_b = parse_weight_kg(a), parse_weight_kg(b)
    if kg_a is None or kg_b is None:
        return normalize_text(a) == normalize_text(b)
    return abs(kg_a - kg_b) <= tolerance_kg


# ---------------------------------------------------------------------------
# Field dispatch + top-level comparison
# ---------------------------------------------------------------------------

def _fields_match(field_name: str, si_value: Any, bl_value: Any) -> bool:
    if field_name in _TEXT_FIELDS:
        return normalize_company_name(si_value) == normalize_company_name(bl_value)
    if field_name in _PORT_FIELDS:
        return ports_equal(si_value, bl_value)
    if field_name == "container_count":
        return containers_equal(si_value, bl_value)
    if field_name == "gross_weight_kg":
        return weights_equal(si_value, bl_value)
    return normalize_text(si_value) == normalize_text(bl_value)


class FieldDifference(BaseModel):
    si: Any = None
    bl: Any = None


class CompareResult(BaseModel):
    status: str  # "match" | "mismatch"
    message: str
    incorrect_or_missing: List[str] = Field(default_factory=list)
    # Every one of `fields` gets an entry, matched or not -- a human reviewing the comparison
    # needs to see what was actually read off each document, not just which ones disagreed.
    details: Dict[str, FieldDifference] = Field(default_factory=dict)


def compare_documents(
    si: Dict[str, Any],
    bl: Dict[str, Any],
    fields: Tuple[str, ...] = FIELDS,
) -> CompareResult:
    """Deterministically compare SI-extracted values against BL-extracted
    values. Both dicts are expected to already use the canonical field
    names produced by backend/extract.py.
    """
    incorrect_or_missing: List[str] = []
    details: Dict[str, FieldDifference] = {}

    for field_name in fields:
        si_value = si.get(field_name)
        bl_value = bl.get(field_name)
        details[field_name] = FieldDifference(si=si_value, bl=bl_value)

        if si_value in (None, "") or bl_value in (None, ""):
            if si_value != bl_value:
                incorrect_or_missing.append(field_name)
            continue

        if not _fields_match(field_name, si_value, bl_value):
            incorrect_or_missing.append(field_name)

    if not incorrect_or_missing:
        return CompareResult(status="match", message=NO_MISMATCH_MESSAGE, details=details)

    return CompareResult(
        status="mismatch",
        message=f"{len(incorrect_or_missing)} field(s) mismatched: "
        f"{', '.join(incorrect_or_missing)}",
        incorrect_or_missing=incorrect_or_missing,
        details=details,
    )


def flatten_extraction(
    extraction: Any,
    confidence_threshold: float = 0.0,
) -> Dict[str, Any]:
    """Unwrap a backend.extract.Extraction (or its .model_dump()) into the
    flat {field_name: value} shape compare_documents expects.

    extraction may be an Extraction instance, a dict from
    extraction.model_dump(), or a dict loaded back via extract.load_cache
    (which also produces Extraction instances). Duck-typed on model_dump
    so this module doesn't need to import backend.extract.

    confidence_threshold: fields extracted below this confidence are
    treated as missing (None) rather than as their (unreliable) value, so
    a low-confidence OCR guess doesn't get silently compared as fact.
    Default 0.0 keeps every extracted value, matching today's behavior.
    """
    if hasattr(extraction, "model_dump"):
        extraction = extraction.model_dump()

    flat: Dict[str, Any] = {}
    for field_name in FIELDS:
        entry = extraction.get(field_name) or {}
        value = entry.get("value")
        confidence = entry.get("confidence") or 0.0
        if value is not None and confidence < confidence_threshold:
            value = None
        flat[field_name] = value
    return flat


class _FieldVerdict(BaseModel):
    field: str = Field(description="Field name being judged")
    matches: bool = Field(
        description="True if the SI and BL values refer to the same real-world "
        "value despite wording/formatting differences"
    )
    reasoning: str = Field(description="One short sentence")


class _LLMCompareOutput(BaseModel):
    verdicts: List[_FieldVerdict]


_COMPARE_SYSTEM_PROMPT = """You are re-checking shipping document fields that a
deterministic comparator already flagged as mismatched between a Shipping
Instruction (SI) and a draft Bill of Lading (BL).

For each field, decide whether the SI and BL values actually refer to the
same real-world thing, just written differently (e.g. an address written in a
different order, a port name spelled differently with no code to disambiguate,
a company name with unusual punctuation the normalizer missed). Only mark
matches=true when you are confident despite the wording difference -- a
genuine discrepancy (different company, different port, different quantity)
must stay matches=false. Never guess a match to be lenient."""


async def compare_jsons(json_a: Dict[str, Any], json_b: Dict[str, Any]) -> Dict[str, Any]:
    """LLM-assisted second opinion on fields backend.compare's deterministic
    rules already flagged as mismatched.

    json_a / json_b are the SI / BL values for ONLY the flagged fields (the
    caller, compare_documents_with_fallback, narrows to that subset). Returns
    the same {"status", "incorrect_or_missing", "details"} shape as
    CompareResult.model_dump() so it can be consumed the same way.
    """
    from .llm import astructured_completion  # local import: optional dependency

    fields = sorted(set(json_a) | set(json_b))
    if not fields:
        return {"status": "match", "incorrect_or_missing": [], "details": {}}

    lines = [f"- {f}: SI={json_a.get(f)!r}  BL={json_b.get(f)!r}" for f in fields]
    user = "Fields to re-check:\n" + "\n".join(lines)

    output = await astructured_completion(_COMPARE_SYSTEM_PROMPT, user, _LLMCompareOutput)

    verdict_by_field = {v.field: v.matches for v in output.verdicts}
    still_mismatched = [f for f in fields if not verdict_by_field.get(f, False)]
    details = {f: FieldDifference(si=json_a.get(f), bl=json_b.get(f)).model_dump() for f in still_mismatched}

    return {
        "status": "match" if not still_mismatched else "mismatch",
        "incorrect_or_missing": still_mismatched,
        "details": details,
    }


async def compare_documents_with_fallback(
    si: Dict[str, Any],
    bl: Dict[str, Any],
    use_llm_fallback: bool = False,
) -> Dict[str, Any]:
    """Run the deterministic comparison; optionally re-check only the
    fields it flagged using the LLM-based comparator in
    backend/comparison.py, as a second opinion before surfacing them.

    Deterministic rules always decide "match" on their own -- the LLM is
    never able to turn a deterministic match into a mismatch, only to
    resolve a deterministic mismatch that turns out to be a false
    positive (e.g. address wording the normalizers don't cover).
    """
    result = compare_documents(si, bl)
    if result.status == "match" or not use_llm_fallback:
        return result.model_dump()

    from backend.comparison import compare_jsons  # local import: optional dependency

    flagged = result.incorrect_or_missing
    llm_result = await compare_jsons(
        {k: si.get(k) for k in flagged},
        {k: bl.get(k) for k in flagged},
    )

    # A field the LLM resolves is no longer "mismatched", but its details entry stays -- `details`
    # now carries every field's SI/BL value for the review table, whether or not it's flagged.
    still_mismatched = llm_result.get("incorrect_or_missing", flagged)
    result.incorrect_or_missing = still_mismatched

    if not result.incorrect_or_missing:
        result.status = "match"
        result.message = NO_MISMATCH_MESSAGE
    else:
        result.message = (
            f"{len(result.incorrect_or_missing)} field(s) mismatched: "
            f"{', '.join(result.incorrect_or_missing)}"
        )

    return result.model_dump()