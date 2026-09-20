"""Ingestion: inbox JSON + attachments -> typed Email objects.

Usage:
    python -m backend.ingest [data_dir]

data_dir must contain inbox/ and attachments/ (defaults to repo root).
"""

import json
import re
import sys
from collections import Counter
from collections.abc import Iterator
from pathlib import Path

from .models import Attachment, DocType, Email
from .readers import read_attachment

_DOC_TYPE_RE = re.compile(r"_(SI|BL)\.[^.]+$", re.IGNORECASE)


def parse_doc_type(filename: str) -> DocType:
    m = _DOC_TYPE_RE.search(filename)
    return m.group(1).upper() if m else "unknown"  # type: ignore[return-value]


def load_attachment(rel_path: str, data_dir: Path) -> Attachment:
    path = data_dir / rel_path
    text, read_error = read_attachment(path)
    return Attachment(
        path=rel_path,
        doc_type=parse_doc_type(path.name),
        ext=path.suffix.lstrip(".").lower(),
        text=text,
        read_error=read_error,
    )


def load_email(json_path: Path, data_dir: Path) -> Email:
    raw = json.loads(json_path.read_text())
    attachments = [load_attachment(p, data_dir) for p in raw.get("attachments", [])]
    return Email(
        email_id=raw["email_id"],
        sender=raw.get("from", ""),
        subject=raw.get("subject", ""),
        body=raw.get("body", ""),
        attachments=attachments,
    )


def load_inbox(data_dir: Path) -> Iterator[Email]:
    for json_path in sorted((data_dir / "inbox").glob("email_*.json")):
        yield load_email(json_path, data_dir)


def summarize(emails: list[Email]) -> str:
    by_ext: Counter[str] = Counter()
    errors: Counter[str] = Counter()
    with_attachments = 0
    for email in emails:
        if email.attachments:
            with_attachments += 1
        for att in email.attachments:
            by_ext[att.ext] += 1
            if att.read_error:
                errors[f"{att.ext}: {att.read_error}"] += 1

    lines = [
        f"emails: {len(emails)}",
        f"emails with attachments: {with_attachments}",
        f"attachments: {sum(by_ext.values())}",
    ]
    lines += [f"  {ext}: {n}" for ext, n in sorted(by_ext.items())]
    lines.append(f"read errors: {sum(errors.values())}")
    lines += [f"  {reason}: {n}" for reason, n in sorted(errors.items())]
    return "\n".join(lines)


def main(argv: list[str]) -> None:
    data_dir = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parent.parent
    emails = list(load_inbox(data_dir))
    print(summarize(emails))
    if emails:
        print("\n--- first email ---")
        first = emails[0].model_dump(by_alias=True)
        for att in first["attachments"]:
            if att["text"]:
                att["text"] = att["text"][:200] + "..."
        print(json.dumps(first, indent=2))


if __name__ == "__main__":
    main(sys.argv)
