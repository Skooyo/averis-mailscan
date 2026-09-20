# Averis x Monash Hackathon 2026 — Shipping Document Verification

Classifies inbox emails and compares Shipping Instructions (SI) against draft
Bills of Lading (BL), flagging mismatches and escalating uncertain cases.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Pipeline

```
Ingestion → Classification → (comparison requests: Extraction → Comparison; others: skip straight through) → Escalation check (uncertain cases → human review queue) → Output JSON (all emails, every category) → self-eval validation loop → stream to FE
```

| Stage | Module | Status |
|---|---|---|
| Ingestion | `backend/ingest.py`, `backend/readers.py` | done |
| Classification | | todo |
| Extraction | | todo |
| Comparison | | todo |
| Escalation | | todo |
| Output JSON + self-eval | | todo |
| API + frontend | | todo |

### Ingestion

Reads `inbox/*.json` and resolves each attachment into text (txt, pdf, xlsx,
docx). Unreadable attachments never raise — they carry a `read_error`
(`file_not_found`, `unsupported_extension`, `pdf_no_text_layer`, or the
exception name) which later stages use as an escalation signal.

```bash
python -m backend.ingest          # summary + first email dump
python -m pytest tests/           # tests
```

## Experiments

`GmailAPI.py` (Gmail OAuth) and `OCRApi.py` (Google Document AI) are
standalone API smoke tests; Document AI is the planned fallback for scanned
PDFs. Both need `credentials.json` / a `.env` with `PROJECT_ID`,
`PROCESSOR_ID`, `LOCATION` — never commit these.
