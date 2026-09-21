# Handover — Averis x Monash Hackathon 2026

_Last updated: 2026-09-21. Classification run complete: 520/520, 100% on the 45-email labelled sample._

_2026-09-22 amendment: `backend/llm.py` was switched from Groq to the Vercel
AI Gateway (`AI_GATEWAY_API_KEY`, default model `alibaba/qwen3.8-omni-flash`)
— the same provider `frontend/src/lib/classify.ts` already used, so both
classifiers now share one key. `cp .env.example .env` now needs
`AI_GATEWAY_API_KEY`, not `GROQ_API_KEY`. The Groq-specific numbers below
(free-tier limits, `openai/gpt-oss-120b`, `reasoning_effort`) describe the
original design and no longer reflect the running code._

## What we're building

An inbox-processing pipeline for a shipping-documentation team:

```
Ingestion → Classification → (comparison requests: Extraction → Comparison | others: skip)
  → Escalation check (uncertain → human review queue)
  → Result per email → stream to FE  /  output JSON → self-eval loop
```

Full problem statement + rubrics: `clanker-food/`. Condensed brief: `clanker-food/CLAUDE.md`.

## Current state

| Stage | Status | Where |
|---|---|---|
| Attachment → text | **done** | `backend/readers.py`, `backend/convert.py` |
| Ingestion | **done** | `backend/ingest.py`, `backend/models.py` |
| Classification | **done** — 520/520 cached in `data/classifications.json`; 45/45 on labelled sample. Counts: general 151, comparison_request 129, new_si_request 125, invoice_query 75, spam 40 | `backend/classify.py`, `backend/llm.py`, `backend/cli.py` |
| Extraction | not started | — |
| Comparison | not started | — |
| Escalation | not started | — |
| Output JSON + self-eval | not started (self-eval server files `loader.py` / `sample_submission.json` / docker still need copying in from the hackathon ZIP) | — |
| API + frontend + deploy | not started | — |
| DB (Postgres) | not started — everything is pydantic objects + JSON files for now | — |

Tests: `pytest tests/` → 28 tests (25 offline, 3 live Groq tests that skip without a key).

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # add GROQ_API_KEY
python -m backend.convert       # attachments/ -> output/converted_text/
python -m backend.ingest        # sanity: 520 emails, 126 with attachments
python -m backend.cli classify  # classify inbox (resumable)
python -m backend.cli eval-classify
pytest tests/
```

## Module map

| File | Purpose | Key functions |
|---|---|---|
| `backend/models.py` | Shared pydantic models; every stage adds its own here | `Attachment`, `Email`, `Classification`, `ClassificationBatch` |
| `backend/readers.py` | Format-specific text extraction, never raises | `read_attachment(path) -> (text, read_error)`, `detect_format()` |
| `backend/convert.py` | Batch-convert `attachments/` to `output/converted_text/*.txt` + `_report.json` | `convert_folder()`, `convert_attachment()` |
| `backend/ingest.py` | `inbox/*.json` → `Email` objects; uses converted text store if present | `load_inbox(data_dir, text_store)`, `load_email()` |
| `backend/llm.py` | **Only file that knows about Groq.** Structured (JSON-schema) completions with rate-limit backoff | `structured_completion()`, `astructured_completion()`, `strict_schema()` |
| `backend/classify.py` | Prompt, email rendering, batching, result cache | `classify_all()`, `render_batch()`, `clean_body()`, `SYSTEM_PROMPT` |
| `backend/cli.py` | `classify [--force] [--limit N]`, `eval-classify` | |
| `tests/labels_sample.json` | 44 hand-labelled emails (acceptance bar for the classifier) | |
| `data/classifications.json` | Cached classifier output, keyed by email_id — **commit it** so teammates without a key can build downstream | |

## Design decisions (and why)

- **Attachments become text once, on disk.** `output/converted_text/<basename>.txt` is the single source of truth; LLM stages never see raw files. `output/` is gitignored (regenerable in seconds).
- **Readers never raise.** Failures become `read_error` (`file_not_found`, `unsupported_extension`, `extension_mismatch`, `pdf_no_text_layer`, or the exception name). That string is the escalation signal downstream.
- **Category = sender's intent in the body.** Attachment presence/readability is *not* a category signal — escalation handles it. So `email_507` ("compare SI and draft BL … the draft BL is still missing") is still `comparison_request`.
- **Groq `openai/gpt-oss-120b`, strict JSON-schema, temperature 0, `reasoning_effort=low`.** Schema is generated from the pydantic model (`strict_schema()` adds `additionalProperties:false` + all-required as Groq requires).
- **Batching 10 emails per call.** Groq free tier is 8K tokens/min **and 200K tokens/day** per model. One-email-per-call would be ~490K/day (over cap); batching + stripping signatures/banners brings a full run to ~120K.
- **Resumable cache.** `classify_all` writes `data/classifications.json` after every batch and skips cached ids on rerun. `--force` re-classifies everything (costs a fresh ~120K tokens — check the daily budget first).
- **Retry loop in `llm.py`** waits out 429s using Groq's `retry-after`, retries transient connection errors (up to 30 waits), and retries once on Groq's server-side `json_validate_failed` 400 (model occasionally wraps output in an array). All three happened in practice; SDK-level retries alone gave up too early.
- **No DB yet.** Pure pydantic + JSON keeps the stages testable; Postgres persistence is its own step (rubric wants an audit trail, so it's still planned).

## Dataset findings (important for whoever does the next stages)

- 520 emails, 126 with attachments (124 have SI+BL pairs, `email_507`/`email_509` have SI only). 250 attachments: 192 txt, 28 pdf, 22 xlsx, 8 docx.
- **Subjects are shuffled relative to bodies** (e.g. `email_021`: RPA-billing subject, "submit SI reminder" body). Trust the body.
- **Emails 500–520 are the deliberate edge cases**:
  - 501–505: second attachment is a Packing List / Commercial Invoice / Certificate of Origin, *named* `_BL` — extraction must notice it isn't a BL.
  - 506, 508, 510: "attachments appear to have been dropped" (none attached).
  - 507, 509: BL missing.
  - 511, 515: `_BL.pdf` is corrupt (770 bytes) → `PdfminerException`.
  - 512–514: image-only scanned PDFs → `pdf_no_text_layer` → needs OCR (Document AI experiment in `OCRApi.py`).
  - 516–520: "Some SI fields were left blank by the customer".
- ~90 emails say "Please assist to send the draft BL for X for checking" with no attachments. Labelled **general** (asks us to *send* a document, not compare two). If the self-eval disagrees, it's a one-line prompt change in `SYSTEM_PROMPT`.
- ~70 emails have SI details written inline in the body ("Please find Shipping instruction for … POL/POD/Shipper/Consignee") → `new_si_request`, even when they close with "revert with draft BL once available".
- Automated "billing process completed, no action required" RPA notices → `general`, not `invoice_query`.
- Spam domains: `webmail-verify.co`, `prize-claims.info`, `secure-mailbox.org`, `parcel-track.co`.

## Known issues / gotchas

- Groq free tier: ~1 batch per 30–40 s. A full classify run is ~20–25 min. Upgrade to Dev Tier if we need several full reruns in one day.
- `GmailAPI.py` / `OCRApi.py` at repo root are standalone experiments (Gmail label listing, Document AI on one hard-coded PDF). Not wired in. `GmailAPI.py:17-19` has a path bug (checks `attachments/token.json`, loads `token.json`). Plan is to move both to `backend/experiments/`.
- `.gitignore` covers `.env`, `token.json`, `credentials.json`, `output/`, `.venv/`. Never commit keys.
- Missing from repo: `loader.py`, `sample_submission.json`, docker-compose for the self-eval server. Copy from the hackathon ZIP — `sample_submission.json` is the output contract we must match.

## Next steps (in order)

1. ~~Finish classification run~~ done. To re-classify specific emails after a prompt change, delete their ids from `data/classifications.json` and rerun (cheaper than `--force`).
2. **Extraction** (`backend/extract.py`): per document (SI, BL) → 7 fields (shipper, consignee, notify party, POL, POD, container count, gross weight kg), each `{value|null, confidence, evidence}`. Reuse `llm.structured_completion`. Handle label variants ("Port of Loading" / "POL" / "Load Port"). Must also report `doc_type_detected` so 501–505 (packing list named as BL) get caught.
3. **Comparison** (`backend/compare.py`): pure Python normalisation + field diff → `{field, si_value, bl_value, match}`; "No mismatch detected." when all 7 match.
4. **Escalation** (`backend/escalate.py`): rules → `needs_review` + reasons: classification confidence < 0.7; comparison_request without SI/BL; any `read_error`; extracted field null / low confidence; second doc isn't a BL.
5. **Output JSON + self-eval** (`backend/submission.py`): fold into `sample_submission.json` shape, `POST /submit`, log score.
6. **FastAPI + SSE + Next.js + deploy** — deploy a hello-world early; rubric penalises last-minute deploys.
7. **Postgres** persistence of emails/attachments/classifications/results.
8. **OCR fallback** for 512–514 via Document AI.
