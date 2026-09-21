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

import asyncio
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional

from .classify import classify_all
from .comparison import compare_documents_with_fallback, flatten_extraction
from .extract import _attachment_key, extract_all
from .ingest import load_inbox
from .models import Classification, Email


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
    path) are used directly. Otherwise the SI and BL are auto-detected
    from each Extraction's doc_type_detected field, and this raises
    ValueError unless exactly one of each is found -- silently guessing
    among multiple SI-looking or BL-looking attachments would be worse
    than failing loudly.

    extract_kwargs (concurrency, force, cache_path, progress) are passed
    straight through to extract_all.
    """
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

    return await compare_documents_with_fallback(
        si_fields, bl_fields, use_llm_fallback=use_llm_fallback
    )


async def process_comparison_requests(
    emails: List[Email],
    classifications: Dict[str, Classification],
    use_llm_fallback: bool = False,
    confidence_threshold: float = 0.0,
    **extract_kwargs: Any,
) -> Dict[str, Dict[str, Any]]:
    """The classify.py -> compare_si_vs_bl dispatcher.

    Runs compare_si_vs_bl for every email whose classification.category is
    "comparison_request"; everything else (new_si_request, invoice_query,
    general, spam, or an email with no classification at all) is skipped.

    Per classify.py's own docstring, a comparison_request email can still be
    missing its BL, have unreadable attachments, or carry a packing list /
    invoice / certificate instead of the BL -- none of that changes the
    category. So rather than letting compare_si_vs_bl's ValueError (or an
    extraction/LLM failure) halt the whole batch, each email's outcome is
    captured individually, in the same {"status": ..., ...} shape a normal
    comparison result already has, with status="error" and a message on
    failure -- matching the read_error convention the rest of this
    pipeline (readers.py) uses instead of raising.
    """
    results: Dict[str, Dict[str, Any]] = {}

    for email in emails:
        classification = classifications.get(email.email_id)
        if classification is None or classification.category != "comparison_request":
            continue

        try:
            results[email.email_id] = await compare_si_vs_bl(
                email.attachments,
                use_llm_fallback=use_llm_fallback,
                confidence_threshold=confidence_threshold,
                **extract_kwargs,
            )
        except Exception as exc:  # one bad email must not halt the batch
            results[email.email_id] = {"status": "error", "message": str(exc)}

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
    (default) processes everything. Note the returned dict only contains
    comparison_request-classified emails, so with a small limit it may
    come back empty even when classification worked fine; inspect
    classify_all's output directly if you need to see every email's
    category, not just the comparison results.

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
    lines = [f"comparison_request emails processed: {len(results)}"]
    lines += [f"  {status}: {n}" for status, n in sorted(counts.items())]
    for email_id, r in sorted(results.items()):
        if r.get("status") == "mismatch":
            fields = ", ".join(r.get("incorrect_or_missing", []))
            lines.append(f"  MISMATCH {email_id}: {fields}")
        elif r.get("status") == "error":
            lines.append(f"  ERROR {email_id}: {r.get('message')}")
    return "\n".join(lines)


def main(argv: List[str]) -> None:
    data_dir = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parent.parent
    limit = int(argv[2]) if len(argv) > 2 else None
    text_store = data_dir / "output" / "converted_text"
    results = asyncio.run(
        run_pipeline(data_dir, text_store if text_store.is_dir() else None, limit=limit)
    )
    print(summarize_comparisons(results))


if __name__ == "__main__":
    main(sys.argv)