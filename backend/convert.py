"""Attachment -> plain-text conversion with on-disk storage.

Converts every attachment into a .txt file (same base name) so downstream
LLM stages only ever read clean text. Failures are recorded, never raised.

Usage:
    python -m backend.convert [attachments_dir] [out_dir]
    defaults: attachments/ -> output/converted_text/
"""

import json
import sys
from collections import Counter
from pathlib import Path

from pydantic import BaseModel

from .readers import read_attachment

REPORT_NAME = "_report.json"


class ConversionResult(BaseModel):
    source: str
    ext: str
    output_path: str | None = None
    read_error: str | None = None
    chars: int = 0

    @property
    def ok(self) -> bool:
        return self.output_path is not None


def converted_path(src: Path, out_dir: Path) -> Path:
    return out_dir / f"{src.stem}.txt"


def convert_attachment(src: Path, out_dir: Path) -> ConversionResult:
    ext = src.suffix.lstrip(".").lower()
    text, read_error = read_attachment(src)
    if text is None:
        return ConversionResult(source=str(src), ext=ext, read_error=read_error)

    out_dir.mkdir(parents=True, exist_ok=True)
    out = converted_path(src, out_dir)
    out.write_text(text, encoding="utf-8")
    return ConversionResult(source=str(src), ext=ext, output_path=str(out), chars=len(text))


def convert_folder(src_dir: Path, out_dir: Path) -> list[ConversionResult]:
    sources = sorted(p for p in src_dir.iterdir() if p.is_file() and not p.name.startswith("."))
    results = [convert_attachment(p, out_dir) for p in sources]

    out_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "converted": sum(r.ok for r in results),
        "failed": sum(not r.ok for r in results),
        "results": [r.model_dump() for r in results],
    }
    (out_dir / REPORT_NAME).write_text(json.dumps(report, indent=2))
    return results


def summarize(results: list[ConversionResult]) -> str:
    by_ext: Counter[str] = Counter(r.ext for r in results)
    ok_by_ext: Counter[str] = Counter(r.ext for r in results if r.ok)
    lines = [f"attachments: {len(results)}"]
    lines += [f"  {ext}: {ok_by_ext[ext]}/{n} converted" for ext, n in sorted(by_ext.items())]
    failures = [r for r in results if not r.ok]
    lines.append(f"failed: {len(failures)}")
    lines += [f"  {Path(r.source).name}: {r.read_error}" for r in failures]
    return "\n".join(lines)


def main(argv: list[str]) -> None:
    root = Path(__file__).resolve().parent.parent
    src_dir = Path(argv[1]) if len(argv) > 1 else root / "attachments"
    out_dir = Path(argv[2]) if len(argv) > 2 else root / "output" / "converted_text"
    results = convert_folder(src_dir, out_dir)
    print(summarize(results))
    print(f"\nwrote {out_dir}/ and {out_dir / REPORT_NAME}")


if __name__ == "__main__":
    main(sys.argv)
