# Averis x Monash Hackathon 2026 — Shipping Document Verification

Classifies inbox emails and compares Shipping Instructions (SI) against draft
Bills of Lading (BL), flagging mismatches and escalating uncertain cases.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Database (MongoDB) + frontend

```bash
docker compose up -d                     # local MongoDB on :27017 (container: averis-mongo)
cd frontend
cp .env.example .env                     # MONGODB_URI=mongodb://localhost:27017, MONGODB_DB=averis
npm install
npm run ingest                           # inbox/ + data/classifications.json -> emails / attachments collections
npm run dev                              # http://localhost:3000
```

`npm run ingest -- --dry-run` prints the summary without writing. Ingest is
re-runnable (emails are upserted on `(owner, id)`). Expected: 520 emails,
250 attachments.

## Pipeline

```
Ingestion → Classification → (comparison requests: Extraction → Comparison; others: skip straight through) → Escalation check (uncertain cases → human review queue) → Output JSON (all emails, every category) → self-eval validation loop → stream to FE
```

| Stage | Module | Status |
|---|---|---|
| Attachment → text | `backend/readers.py`, `backend/convert.py` | done |
| Ingestion | `backend/ingest.py` | done |
| Classification | `backend/classify.py`, `backend/llm.py` (Groq) | done |
| Extraction | | todo |
| Comparison | | todo |
| Escalation | | todo |
| Output JSON + self-eval | | todo |
| API + frontend | | todo |

### Attachment → text conversion

Each attachment is converted to plain text with a format-specific library
(`pdfplumber` for PDF, `openpyxl` for xlsx, `python-docx` for docx) and
stored as `output/converted_text/<same-basename>.txt`, so the LLM stages
only ever read clean text. Failures never raise — they're recorded in
`output/converted_text/_report.json` with a reason (`file_not_found`,
`unsupported_extension`, `extension_mismatch`, `pdf_no_text_layer`, or the
exception name) and become escalation signals downstream.

```bash
python -m backend.convert         # attachments/ -> output/converted_text/
```

Expected on the hackathon dataset: 242/250 converted. The 8 failures are
intentional test cases (emails 511–515: two corrupted PDFs, six image-only
scanned PDFs needing OCR).

### Ingestion

Reads `inbox/*.json` into typed `Email` objects with attachment text
attached. Uses `output/converted_text/` when it exists, otherwise converts
on the fly.

```bash
python -m backend.ingest          # summary + first email dump
python -m pytest tests/           # tests
```

### Classification

One Groq call per email (`openai/gpt-oss-120b`, strict JSON-schema output,
temperature 0) → `category`, `confidence`, `reasoning`. Category is decided
by the sender's intent in the body; subjects in this dataset are unreliable
and attachment presence is left to the escalation stage. Results are cached
in `data/classifications.json` so teammates without a key can build on them.

```bash
cp .env.example .env                    # then fill in GROQ_API_KEY
python -m backend.cli classify --limit 10
python -m backend.cli classify          # all 520, resumable
python -m backend.cli eval-classify     # accuracy vs tests/labels_sample.json
```

`backend/llm.py` is the only file that knows about Groq — swap provider or
model (`GROQ_MODEL` env var) there.

## Experiments

`GmailAPI.py` (Gmail OAuth) and `OCRApi.py` (Google Document AI) are
standalone API smoke tests; Document AI is the planned fallback for scanned
PDFs. Both need `credentials.json` / a `.env` with `PROJECT_ID`,
`PROCESSOR_ID`, `LOCATION` — never commit these.
