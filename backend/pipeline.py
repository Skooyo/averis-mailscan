"""backend/pipeline.py

Glue between backend/extract.py and backend/compare.py.

extract.py produces one Extraction per attachment (nested
value/confidence/evidence per field), keyed by attachment identity.
compare.py expects two flat {field: value} dicts, explicitly SI and BL.

This module bridges that gap: extract every attachment, identify which
one is the SI and which is the BL (via the LLM's own doc_type_detected,
unless the caller already knows and passes the keys explicitly), flatten
each to plain values, and hand them to the deterministic comparator.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .classify import classify_all
from .comparison import compare_documents_with_fallback, flatten_extraction
from .escalate import annotate_with_escalation
from .extract import CACHE_PATH as EXTRACTION_CACHE_PATH
from .extract import _attachment_key, extract_all
from .extract import load_cache as load_extraction_cache
from .ingest import load_inbox
from .models import Classification, Email


def _content_key(attachment: Any) -> Optional[str]:
    """Hash of an attachment's text, for spotting the same document attached
    twice under different filenames. None for unreadable attachments (no
    text) -- two unreadable attachments aren't necessarily the same document,
    so they're never treated as duplicates of each other.
    """
    text = getattr(attachment, "text", None)
    if not text:
        return None
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def dedupe_attachments(attachments: list) -> Tuple[list, Dict[str, List[str]]]:
    """Collapse attachments with byte-identical text content down to one
    representative each (first occurrence, by input order).

    Without this, the same document attached twice under different names
    (or the same path listed twice) gets extracted twice -- wasted LLM
    calls -- and, worse, can make compare_si_vs_bl's SI/BL auto-detection
    see "2 SI-typed attachments" and raise an ambiguous_si_bl escalation
    for what's actually one document, not a real ambiguity.

    Returns (kept_attachments, duplicate_groups) where duplicate_groups
    maps each kept attachment's key to the keys of the attachments dropped
    as its duplicates -- evidence, not a silent drop.
    """
    seen_content: Dict[str, str] = {}  # content hash -> kept attachment's key
    kept: list = []
    duplicate_groups: Dict[str, List[str]] = {}

    for attachment in attachments:
        content_key = _content_key(attachment)
        own_key = _attachment_key(attachment)
        if content_key is None:
            kept.append(attachment)
            continue
        if content_key not in seen_content:
            seen_content[content_key] = own_key
            kept.append(attachment)
        else:
            duplicate_groups.setdefault(seen_content[content_key], []).append(own_key)

    return kept, duplicate_groups


async def compare_si_vs_bl(
    attachments: list,
    si_attachment_key: Optional[str] = None,
    bl_attachment_key: Optional[str] = None,
    use_llm_fallback: bool = False,
    confidence_threshold: float = 0.0,
    **extract_kwargs: Any,
) -> Dict[str, Any]:
    """Extract every attachment and deterministically compare the SI
    against the BL.

    If si_attachment_key / bl_attachment_key are given, those attachment
    keys (as produced by extract._attachment_key -- typically the file
    path) are used directly -- note they must name a *kept* attachment,
    not one collapsed as a duplicate of another (see dedupe_attachments).
    Otherwise the SI and BL are auto-detected from each Extraction's
    doc_type_detected field, and this raises ValueError unless exactly one
    of each is found -- silently guessing among multiple SI-looking or
    BL-looking attachments would be worse than failing loudly.

    extract_kwargs (concurrency, force, cache_path, progress) are passed
    straight through to extract_all.
    """
    attachments, duplicate_groups = dedupe_attachments(attachments)

    extractions = await extract_all(attachments, **extract_kwargs)

    # extract_all's cache is persistent and shared across every call that
    # uses the same cache_path (its default is one module-level file) --
    # it returns the WHOLE accumulated cache, not just entries for the
    # attachments passed here. Scope down to this call's own attachments
    # first, or a previously-cached SI/BL from a *different* email leaks
    # into this one's auto-detection (and would also let an explicit
    # si_attachment_key/bl_attachment_key silently resolve to some other
    # email's stale cached attachment).
    wanted_keys = {_attachment_key(a) for a in attachments}
    extractions = {k: e for k, e in extractions.items() if k in wanted_keys}

    if si_attachment_key is not None and bl_attachment_key is not None:
        if si_attachment_key not in extractions:
            raise ValueError(f"si_attachment_key {si_attachment_key!r} was not extracted")
        if bl_attachment_key not in extractions:
            raise ValueError(f"bl_attachment_key {bl_attachment_key!r} was not extracted")
        si_extraction = extractions[si_attachment_key]
        bl_extraction = extractions[bl_attachment_key]
    else:
        si_matches = {
            key: e for key, e in extractions.items() if e.doc_type_detected == "SI"
        }
        bl_matches = {
            key: e for key, e in extractions.items() if e.doc_type_detected == "BL"
        }
        if len(si_matches) != 1 or len(bl_matches) != 1:
            raise ValueError(
                "Could not uniquely identify an SI and a BL among the "
                f"extracted attachments (found {len(si_matches)} SI-typed: "
                f"{list(si_matches)}, {len(bl_matches)} BL-typed: "
                f"{list(bl_matches)}). Pass si_attachment_key/"
                "bl_attachment_key explicitly to bypass auto-detection."
            )
        si_extraction = next(iter(si_matches.values()))
        bl_extraction = next(iter(bl_matches.values()))

    si_fields = flatten_extraction(si_extraction, confidence_threshold=confidence_threshold)
    bl_fields = flatten_extraction(bl_extraction, confidence_threshold=confidence_threshold)

    result = await compare_documents_with_fallback(
        si_fields, bl_fields, use_llm_fallback=use_llm_fallback
    )
    if duplicate_groups:
        result["duplicate_attachments"] = duplicate_groups
    return result


async def process_comparison_requests(
    emails: List[Email],
    classifications: Dict[str, Classification],
    use_llm_fallback: bool = False,
    confidence_threshold: float = 0.0,
    **extract_kwargs: Any,
) -> Dict[str, Dict[str, Any]]:
    """The classify.py -> compare_si_vs_bl dispatcher.

    Runs compare_si_vs_bl for every email whose classification.category is
    "comparison_request". Every other email -- new_si_request, invoice_query,
    general, spam, or one with no classification at all -- still gets an
    entry in the returned dict (status="skipped"/"unclassified"), since the
    submission format needs every email_id present, not just the ones that
    went through comparison.

    Per classify.py's own docstring, a comparison_request email can still be
    missing its BL, have unreadable attachments, or carry a packing list /
    invoice / certificate instead of the BL -- none of that changes the
    category. So rather than letting compare_si_vs_bl's ValueError (or an
    extraction/LLM failure) halt the whole batch, each email's outcome is
    captured individually, in the same {"status": ..., ...} shape a normal
    comparison result already has, with status="error" and a message on
    failure -- matching the read_error convention the rest of this
    pipeline (readers.py) uses instead of raising.

    Every result also gets an "escalation" key (backend/escalate.py):
    {"required": bool, "reasons": [{"code", "detail"}, ...]}, computed from
    the email's classification, its attachments' read_errors, this stage's
    own outcome, and (for comparison_request emails) the extraction cache's
    per-field confidence -- so a human review queue can be built by simply
    filtering on escalation.required, without re-deriving any of this.
    """
    results: Dict[str, Dict[str, Any]] = {}

    for email in emails:
        classification = classifications.get(email.email_id)
        category = classification.category if classification else None

        if category != "comparison_request":
            results[email.email_id] = {
                "status": "unclassified" if classification is None else "skipped",
                "category": category,
                "message": (
                    "no classification available for this email"
                    if classification is None
                    else f"category '{category}' does not require SI/BL comparison"
                ),
            }
            continue

        try:
            result = await compare_si_vs_bl(
                email.attachments,
                use_llm_fallback=use_llm_fallback,
                confidence_threshold=confidence_threshold,
                **extract_kwargs,
            )
            result["category"] = category
            results[email.email_id] = result
        except Exception as exc:  # one bad email must not halt the batch
            results[email.email_id] = {"status": "error", "category": category, "message": str(exc)}

    extraction_cache_path = extract_kwargs.get("cache_path", EXTRACTION_CACHE_PATH)
    extraction_cache = load_extraction_cache(extraction_cache_path)
    annotate_with_escalation(emails, classifications, results, extraction_cache)

    return results


async def run_pipeline(
    data_dir: Path,
    text_store: Optional[Path] = None,
    limit: Optional[int] = None,
    use_llm_fallback: bool = False,
    confidence_threshold: float = 0.0,
    classify_kwargs: Optional[Dict[str, Any]] = None,
    extract_kwargs: Optional[Dict[str, Any]] = None,
) -> Dict[str, Dict[str, Any]]:
    """The full ingest -> classify -> compare loop.

    Loads every email under data_dir/inbox (ingest.load_inbox), classifies
    each one (classify.classify_all), then runs compare_si_vs_bl for every
    email classified "comparison_request" (process_comparison_requests).
    Nothing in ingest.py or classify.py needs to change for this to work --
    this function is the piece that was missing to connect them.

    limit: process only the first N loaded emails -- for a quick sanity
    check against real LLM calls before running the whole inbox. None
    (default) processes everything. The returned dict has one entry per
    loaded email regardless of category (see process_comparison_requests).

    classify_kwargs / extract_kwargs are passed straight through to
    classify_all / extract_all respectively (e.g. concurrency, force,
    cache_path) so callers can tune each stage independently.
    """
    emails = list(load_inbox(data_dir, text_store))
    if limit is not None:
        emails = emails[:limit]
    classifications = await classify_all(emails, **(classify_kwargs or {}))
    return await process_comparison_requests(
        emails,
        classifications,
        use_llm_fallback=use_llm_fallback,
        confidence_threshold=confidence_threshold,
        **(extract_kwargs or {}),
    )


def summarize_comparisons(results: Dict[str, Dict[str, Any]]) -> str:
    """Human-readable report, in the same style as ingest.summarize()."""
    counts = Counter(r.get("status", "unknown") for r in results.values())
    needs_escalation = sum(1 for r in results.values() if r.get("escalation", {}).get("required"))
    lines = [f"emails processed: {len(results)}", f"  needs escalation: {needs_escalation}"]
    lines += [f"  {status}: {n}" for status, n in sorted(counts.items())]
    for email_id, r in sorted(results.items()):
        if r.get("status") == "mismatch":
            fields = ", ".join(r.get("incorrect_or_missing", []))
            lines.append(f"  MISMATCH {email_id}: {fields}")
        elif r.get("status") == "error":
            lines.append(f"  ERROR {email_id}: {r.get('message')}")
    return "\n".join(lines)


DEFAULT_RESULT_OWNER = "shared"  # matches SHARED_OWNER in frontend/src/lib/constants.ts


def main(argv: List[str]) -> None:
    """`python -m backend.pipeline [data_dir] [limit] [--write-db] [--owner OWNER]`

    data_dir/limit stay positional (unchanged from before --write-db existed,
    so existing callers/tests keep working). --write-db is opt-in: without
    it this behaves exactly as before, no MongoDB connection is ever
    attempted.
    """
    parser = argparse.ArgumentParser(prog="python -m backend.pipeline")
    parser.add_argument("data_dir", nargs="?", default=None)
    parser.add_argument("limit", nargs="?", type=int, default=None)
    parser.add_argument(
        "--write-db",
        action="store_true",
        help="upsert results into MongoDB after the run (needs MONGODB_URI; see .env.example)",
    )
    parser.add_argument(
        "--owner",
        default=DEFAULT_RESULT_OWNER,
        help=f"Result.owner to write under (default: {DEFAULT_RESULT_OWNER!r}, the shared demo dataset)",
    )
    args = parser.parse_args(argv[1:])

    data_dir = Path(args.data_dir) if args.data_dir else Path(__file__).resolve().parent.parent
    text_store = data_dir / "output" / "converted_text"
    results = asyncio.run(
        run_pipeline(data_dir, text_store if text_store.is_dir() else None, limit=args.limit)
    )
    print(summarize_comparisons(results))

    if args.write_db:
        from .db import upsert_results  # local import: pymongo is only needed for this opt-in path

        written = upsert_results(args.owner, results)
        print(f"wrote {written} result(s) to MongoDB (owner={args.owner!r})")


if __name__ == "__main__":
    main(sys.argv)