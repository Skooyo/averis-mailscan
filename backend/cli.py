"""Pipeline CLI.

    python -m backend.cli classify [--force] [--limit N]   run classifier over inbox, cache to data/
    python -m backend.cli eval-classify                    score cache against tests/labels_sample.json
"""

import argparse
import asyncio
import json
from collections import Counter
from pathlib import Path

from .classify import CACHE_PATH, classify_all, load_cache
from .ingest import load_inbox

ROOT = Path(__file__).resolve().parent.parent
LABELS_PATH = ROOT / "tests" / "labels_sample.json"


def _emails(limit: int | None):
    text_store = ROOT / "output" / "converted_text"
    emails = list(load_inbox(ROOT, text_store if text_store.is_dir() else None))
    return emails[:limit] if limit else emails


def cmd_classify(args: argparse.Namespace) -> None:
    emails = _emails(args.limit)
    cache = asyncio.run(classify_all(emails, concurrency=args.concurrency, force=args.force, progress=True))
    results = [cache[e.email_id] for e in emails if e.email_id in cache]

    print(f"classified: {len(results)} (cache: {CACHE_PATH.relative_to(ROOT)})")
    for cat, n in Counter(r.category for r in results).most_common():
        print(f"  {cat}: {n}")
    low = [(e.email_id, cache[e.email_id]) for e in emails if e.email_id in cache and cache[e.email_id].confidence < 0.6]
    print(f"low confidence (<0.6): {len(low)}")
    for eid, r in low:
        print(f"  {eid} {r.category} {r.confidence:.2f} — {r.reasoning}")


def cmd_eval_classify(args: argparse.Namespace) -> None:
    labels: dict[str, str] = json.loads(LABELS_PATH.read_text())
    cache = load_cache()
    missing = [k for k in labels if k not in cache]
    if missing:
        print(f"{len(missing)} labelled emails not in cache yet: {missing[:5]}...")
    scored = {k: v for k, v in labels.items() if k in cache}
    correct = sum(cache[k].category == v for k, v in scored.items())
    print(f"accuracy: {correct}/{len(scored)} = {correct / len(scored):.1%}" if scored else "nothing to score")
    for k, expected in scored.items():
        got = cache[k]
        if got.category != expected:
            print(f"  MISS {k}: expected {expected}, got {got.category} ({got.confidence:.2f}) — {got.reasoning}")


def main() -> None:
    p = argparse.ArgumentParser(prog="python -m backend.cli")
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("classify", help="classify inbox emails via the AI Gateway")
    c.add_argument("--force", action="store_true", help="ignore cache and re-classify")
    c.add_argument("--limit", type=int, default=None, help="only the first N emails")
    c.add_argument("--concurrency", type=int, default=1)
    c.set_defaults(fn=cmd_classify)

    e = sub.add_parser("eval-classify", help="score cached classifications against hand labels")
    e.set_defaults(fn=cmd_eval_classify)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
