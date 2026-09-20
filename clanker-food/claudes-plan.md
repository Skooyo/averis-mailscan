# Averis Hackathon — Implementation Status & Next Steps

## Context
The team's intended data flow is:

```
ingestion + classification -> extraction + db schema -> comparison json of SI and BL
  -> output pattern matching (case scenarios) => stream to FE
```

This plan answers "how far along are we?" against that flow and proposes the
next concrete steps. Everything below was verified by reading every non-data
file in the repo (there are only two Python scripts).

## Current state: what exists

| File | What it does | Pipeline stage it serves |
|---|---|---|
| `GmailAPI.py` | OAuth2 login to Gmail, lists label names. Top-level script, no functions. Has a bug: checks `attachments/token.json` exists but then loads `token.json` from CWD (`GmailAPI.py:17-19`). | Proto for **ingestion** (live Gmail), but the hackathon dataset is local JSON — Gmail is not needed for the core flow. |
| `OCRApi.py` | Google Document AI: sends one hard-coded PDF (`email_059_SI.pdf`) to a processor, prints entities. Top-level script, no functions. | Proto for **extraction** on scanned/PDF attachments (advanced stage only). |
| `README.md` | One pip install line. | — |
| `inbox/email_001..520.json` | 520 emails: `email_id, from, subject, body, attachments[]`. 126 have attachments. | Dataset (ingestion input) |
| `attachments/` | 250 files: 192 txt, 28 pdf, 22 xlsx, 8 docx. Pairs `email_NNN_SI.*` + `email_NNN_BL.*`. | Dataset |
| `clanker-food/*.md` | Problem statement, rubrics, rules. `CLAUDE.md` (untracked) is a good condensed brief. | Docs |

**Missing from the hackathon bundle** (referenced in the problem statement but
not in repo): `loader.py`, `sample_submission.json`, `docker-compose` for the
self-eval server (`POST /submit`). These need to be copied in from the ZIP —
`sample_submission.json` defines the output contract we must match.

## Stage-by-stage status

| Stage | Status | Notes |
|---|---|---|
| 1. Ingestion | **0%** | No code reads `inbox/*.json` or resolves `attachments[]`. Gmail script is a side experiment, not wired to the dataset. |
| 1. Classification | **0%** | No classifier (5 classes: comparison / new SI / invoice query / general / spam). No LLM client code at all. |
| 2. Extraction | **~5%** | Only the Document AI smoke test for one PDF. Nothing for txt (77% of attachments), xlsx, docx. No 7-field schema (shipper, consignee, notify party, POL, POD, container count, gross weight). |
| 2. DB schema | **0%** | No Postgres, no ORM, no models. |
| 3. Comparison JSON | **0%** | No SI-vs-BL diff logic. |
| 4. Output pattern matching / case scenarios | **0%** | No escalation logic (unreadable doc, missing field, low confidence). |
| 5. Stream to FE | **0%** | No FastAPI backend, no frontend, no deploy. |
| Infra | **0%** | No `requirements.txt`/`pyproject`, no `.env.example`, no Dockerfile, no deploy. `.gitignore` covers `apiDetails.env` and `.venv/` only — `token.json`/`credentials.json` are **not** ignored (risk of committing secrets). |

**Overall: ~2% — prototypes of two external APIs, zero pipeline code.**

## Recommended next steps (in priority order)

Per the rubric, end-to-end functionality (25 pts) is the biggest lever, so
build a thin vertical slice on txt attachments first, then widen.

### Step 0 — Project skeleton (½ day)
- Copy `loader.py`, `sample_submission.json`, docker files from the hackathon ZIP into repo.
- Create `backend/` package: `pyproject.toml` or `requirements.txt`, `.env.example`, add `token.json`, `credentials.json`, `.env` to `.gitignore`.
- Move `GmailAPI.py` / `OCRApi.py` into `backend/experiments/` (keep, don't wire in yet).

### Step 1 — Ingestion + classification
- `backend/ingest.py`: iterate `inbox/*.json` (or via `loader.Inbox`), yield `Email` pydantic model, read attachment text for `.txt` via `inbox.read_text`.
- `backend/classify.py`: single LLM call with structured JSON output → one of 5 categories + confidence. Use Claude Messages API with a tool/JSON schema (see `claude-api` skill before writing).
- Store result in DB (Step 2 schema).

### Step 2 — Extraction + DB schema
- `backend/models.py` (SQLAlchemy/Postgres): tables `emails`, `classifications`, `extractions` (one row per doc: email_id, doc_type SI|BL, 7 fields, per-field confidence, raw_text), `comparisons`, `escalations`.
- `backend/extract.py`: LLM structured extraction of 7 fields from document text, with `null` + reason when a field is missing. Start with txt; add `pdfplumber` / `openpyxl` / `python-docx` readers after the vertical slice works; keep Document AI (`OCRApi.py`) as fallback for scanned PDFs.

### Step 3 — Comparison JSON
- `backend/compare.py`: pure Python, no LLM. Normalise (case, whitespace, unit for kg, numeric for containers) then diff field-by-field → `{field, si_value, bl_value, match: bool}`. Output "No mismatch detected." when all 7 match.

### Step 4 — Output pattern matching (case scenarios)
- `backend/escalate.py`: rules producing `status: ok | mismatch | needs_review` — e.g. missing SI or BL attachment, unreadable file type, extraction confidence < threshold, field null on either side. Always attach a human-readable `reason`.
- `backend/submission.py`: fold everything into the `sample_submission.json` shape; run against `POST /submit` early and often.

### Step 5 — Stream to FE
- `backend/main.py` FastAPI: `POST /process` (runs pipeline), `GET /results`, `GET /results/{email_id}`, SSE endpoint `GET /stream` that emits per-email results as they finish.
- `frontend/` Next.js: inbox table with category badges, per-email side-by-side SI/BL diff, escalation queue.
- Deploy skeleton (Render/Cloud Run + Vercel) as soon as `main.py` returns a hello-world — rubric explicitly penalises last-minute deploys.

## Verification
- Step 1: `python -m backend.ingest` prints 520 emails, 126 with attachments; classify a 20-email sample and eyeball against subjects (e.g. `email_001` → comparison, `email_002` → invoice query).
- Steps 2–4: run pipeline on the 96 txt-pair emails, build submission JSON, `POST /submit` to the local self-eval server and record the score; iterate.
- Step 5: `curl` the SSE endpoint while `/process` runs; FE shows results appearing live; public URL loads.
