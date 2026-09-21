# Handover — Averis x Monash Hackathon 2026

_Last updated: 2026-09-22, after a full status audit + fix session. This
replaces the 2026-09-21 version of this doc, which had drifted from the
actual code (it said Extraction/Comparison/Escalation were "not started" —
Extraction and Comparison are done; only Escalation genuinely isn't). If you
are a new agent picking this up: read this whole file before touching code —
several things below correct assumptions a previous session made._

## What we're building

An inbox-processing pipeline for a shipping-documentation team:

```
Ingestion → Classification → (comparison requests: Extraction → Comparison | others: skip)
  → Escalation check (uncertain → human review queue)
  → Result per email → stream to FE  /  output JSON → self-eval loop
```

Full problem statement + rubrics: `clanker-food/`. Condensed brief: `clanker-food/CLAUDE.md`.
Granular checklist (kept current): `todo.md`.

## Current state

| Stage | Status | Where |
|---|---|---|
| Attachment → text | **done** — txt/pdf/xlsx/docx all supported | `backend/readers.py`, `backend/convert.py` |
| Ingestion | **done** | `backend/ingest.py`, `backend/models.py` |
| Classification | **done** — 520/520 cached in `data/classifications.json`; 45/45 on labelled sample. Counts: general 151, comparison_request 129, new_si_request 125, invoice_query 75, spam 40 | `backend/classify.py`, `backend/llm.py`, `backend/cli.py` |
| Extraction | **done** (built + tested + live-verified), but only ever run in small batches — `data/extractions.json` doesn't exist yet | `backend/extract.py` |
| Comparison | **done** — deterministic normalizer + LLM fallback, both live-verified | `backend/comparison.py` |
| Escalation | **not started — biggest real gap.** `backend/escalate.py` doesn't exist | — |
| Output JSON + self-eval | **blocked** — `sample_submission.json` / `loader.py` / self-eval docker still not in the repo | — |
| Frontend | mock data only, not wired to backend — correctly deferred | `frontend/` |
| OCR for scanned docs | not started — advanced-stage item, deferred by design | `OCRApi.py` (unwired experiment) |

Tests: `pytest tests/` → 120 tests (117 offline, 3 live — gated on `AI_GATEWAY_API_KEY`, hit the real Gateway).

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # add AI_GATEWAY_API_KEY (and optionally GROQ_API_KEY, see below)
python -m backend.convert       # attachments/ -> output/converted_text/
python -m backend.ingest        # sanity: 520 emails, 126 with attachments
python -m backend.cli classify  # classify inbox (resumable) -- already done, cached in data/classifications.json
python -m backend.cli eval-classify
pytest tests/
```

### LLM provider

**Primary: Vercel AI Gateway** (`AI_GATEWAY_API_KEY`, default model
`alibaba/qwen3.8-omni-flash`) — the same provider and key
`frontend/src/lib/classify.ts` uses, so the Python and TypeScript
classifiers are on one provider instead of two.

**Fallback: Groq** (`GROQ_API_KEY`, default model `openai/gpt-oss-120b`) —
automatic. If the Gateway call fails for any reason (rate limit, 5xx, bad/
missing key, network error), `backend/llm.py` retries the same request
against Groq instead of raising, and prints `[llm] AI Gateway failed (...);
falling back to Groq` to stderr when it does. Leave `GROQ_API_KEY` unset to
disable the fallback (a Gateway failure then just raises, as it did before
the fallback was added).

Neither key set → everything that touches an LLM raises `GatewayAuthError`
immediately.

## Module map

| File | Purpose | Key functions |
|---|---|---|
| `backend/models.py` | Shared pydantic models; every stage adds its own here | `Attachment`, `Email`, `Classification`, `ClassificationBatch` |
| `backend/readers.py` | Format-specific text extraction, never raises | `read_attachment(path) -> (text, read_error)`, `detect_format()` |
| `backend/convert.py` | Batch-convert `attachments/` to `output/converted_text/*.txt` + `_report.json` | `convert_folder()`, `convert_attachment()` |
| `backend/ingest.py` | `inbox/*.json` → `Email` objects; uses converted text store if present | `load_inbox(data_dir, text_store)`, `load_email()` |
| `backend/llm.py` | **Only file that knows about either LLM provider.** Gateway-first, Groq-fallback structured (JSON-schema) completions, with retry/backoff and response-shape coercion for models that don't follow the schema exactly | `structured_completion()`, `astructured_completion()`, `strict_schema()` |
| `backend/classify.py` | Prompt, email rendering, batching, result cache | `classify_all()`, `render_batch()`, `clean_body()`, `SYSTEM_PROMPT` |
| `backend/extract.py` | Per-attachment extraction of the 7 canonical fields + `doc_type_detected` | `extract_all()`, `extract_attachment()`, `Extraction` |
| `backend/comparison.py` | Deterministic SI-vs-BL comparator (no LLM calls in the default path) **plus** the LLM-fallback second-opinion checker. There is no separate `compare.py` — this file's own docstring header saying "backend/compare.py" is a stale leftover from a rename, harmless but worth fixing someday | `compare_documents()`, `compare_documents_with_fallback()`, `compare_jsons()`, `flatten_extraction()` |
| `backend/pipeline.py` | Glue: `ingest → classify → identify SI/BL → extract → compare` | `run_pipeline()`, `compare_si_vs_bl()`, `process_comparison_requests()` |
| `backend/cli.py` | `classify [--force] [--limit N]`, `eval-classify` | |
| `tests/labels_sample.json` | 45 hand-labelled emails (acceptance bar for the classifier) | |
| `data/classifications.json` | Cached classifier output, keyed by email_id, **committed** so teammates without a key can build downstream | |
| `data/extractions.json` | Cached extraction output — **doesn't exist yet**, only small test batches have run | |

## Design decisions (and why)

- **Attachments become text once, on disk.** `output/converted_text/<basename>.txt` is the single source of truth; LLM stages never see raw files. `output/` is gitignored (regenerable in seconds). `convert.py` writes with `newline=""` — a Windows-only bug where `Path.write_text()`'s default newline translation (`\n`→`\r\n`) was silently inflating every converted file's character count was found and fixed this session.
- **Readers never raise... except when they should.** Failures become `read_error` (`file_not_found`, `unsupported_extension`, `extension_mismatch`, `pdf_no_text_layer`, or the exception name) — that string is the escalation signal downstream. `_read_txt` used to pass `errors="replace"`, which silently substituted `�` for genuinely malformed bytes instead of raising — meaning real corruption produced no `read_error` and never reached escalation. Fixed this session: it's strict now, so `read_attachment`'s existing try/except turns that into a proper `read_error`. Checked against all 192 real `.txt` attachments — none are actually malformed, so this only tightens behavior for hypothetical bad input.
- **Category = sender's intent in the body.** Attachment presence/readability is *not* a category signal — escalation handles it. So `email_507` ("compare SI and draft BL … the draft BL is still missing") is still `comparison_request`.
- **Gateway-first, Groq-fallback, strict JSON-schema, temperature 0.** Schema is generated from the pydantic model (`strict_schema()` adds `additionalProperties:false` + all-required). Not every model behind the Gateway honors `response_format` reliably — `backend/llm.py::_coerce_to_schema_shape()` adapts a bare array (or an object holding exactly one array) into the expected wrapper shape before validating; this was a real, live-reproduced failure (a classification call for `email_072` came back as a bare array instead of `{"results": [...]}`), not a theoretical one.
- **Batching 10 emails per call for classification.** Keeps well inside provider rate limits; the system prompt is paid once per batch.
- **Resumable caches.** `classify_all`/`extract_all` write their cache after every batch/item and skip cached ids on rerun. `--force` re-classifies everything (costs a fresh full run — check rate limits first).
- **`compare_documents_with_fallback`'s LLM second opinion never turns a match into a mismatch** — it can only resolve a deterministic mismatch that turns out to be a false positive (wording the normalizers don't cover). `compare_jsons()` (the actual LLM call) was missing entirely until this session — it existed only as a self-import (`from backend.comparison import compare_jsons`) with no matching definition anywhere, so `use_llm_fallback=True` crashed with `ImportError`. All 20 `test_compare.py` tests still passed because they stub out the whole module via `sys.modules`, which is why this went unnoticed. Now implemented and live-verified in both directions (keeps a genuine mismatch flagged; resolves a deterministic false positive).
- **No DB yet.** Pure pydantic + JSON keeps the stages testable.

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
- Confirmed real, correct mismatch caught: `email_004` — SI names one consignee/notify party, BL names a different one entirely. Not a normalization false positive.

## Known issues / gotchas

- **Rate limits, twice over.** The Gateway can rate-limit; Groq (its fallback) has its own free-tier limits too (~1 batch per 30–40s historically). A full extraction run over ~250 attachments will take real time and consume real quota on whichever provider ends up serving it — don't run it repeatedly without reason.
- **The 3 live tests in `tests/test_classify.py` cost real API calls** every time they run (they're not mocked) — they're gated on `AI_GATEWAY_API_KEY` being set, so they'll run on every `pytest tests/` in a fully-configured environment. Fine for occasional verification; don't loop on them.
- `GmailAPI.py` / `OCRApi.py` at repo root are standalone experiments (Gmail label listing, Document AI on one hard-coded PDF). Not wired in. `GmailAPI.py:17-19` has a path bug (checks `attachments/token.json`, loads `token.json`).
- `.gitignore` had literal unresolved merge-conflict markers checked into it (`<<<<<<< HEAD` / `=======` / `>>>>>>>`) from a merge that was never cleanly finished — fixed this session, now one deduplicated file covering `.env`, `apiDetails.env`, `.venv/`, `credentials.json`, `token.json`, `__pycache__/`, `.pytest_cache/`, `output/`, `.DS_Store`.
- Missing from repo: `loader.py`, `sample_submission.json`, docker-compose for the self-eval server (there IS a `docker-compose.yml` at repo root, but it's for local MongoDB per `README.md`, not the hackathon self-eval server — don't confuse the two). Get the real ones from the hackathon ZIP or its Docker option — `sample_submission.json` is the output contract that must be matched.
- No caller anywhere passes an explicit `model=` to `structured_completion`/`astructured_completion` — if you add one, note that `backend/llm.py`'s `model: str | None = None` default resolves to `GATEWAY_MODEL` or `GROQ_MODEL` depending on which provider actually ends up serving the call, not a single shared default.

## Plan for what's still open

Ordered by dependency, not just severity — some of this only makes sense in
this order.

**1. Fix `run_pipeline`'s output to include every email — small, do first.**
`process_comparison_requests` currently only writes a result for
`comparison_request`-classified emails; every other category (`general`,
`invoice_query`, `new_si_request`, `spam`) silently vanishes from the result
dict. The submission format needs every `email_id` present (§1/§7 in
`todo.md`). Do this before escalate.py so escalation has one output shape to
slot into, not two.

**2. Build `backend/escalate.py` — the biggest real gap.**
Rules-based, per the problem statement's "ask for help" capability:
- Attachments missing or unreadable (`read_error` set)
- Classification confidence low
- Extracted field null or low-confidence
- SI/BL ambiguous (`compare_si_vs_bl`'s `ValueError` when it can't uniquely
  identify one of each)
- Processing failed outright (replace today's bare
  `{"status": "error", "message": str(exc)}` catch in
  `process_comparison_requests` with a real escalation record)

Each escalation needs: email ID, evidence, extracted values, and a reason.
Per the advanced-stage rubric, ideally also a retry/correction hook. This
slots into the pipeline right after comparison, before final output.

**3. Run extraction over the full inbox.**
`data/extractions.json` doesn't exist yet — only ever run in small batches.
Deliberately sequenced *after* #2, so a bad email during the full run
produces a proper escalation record instead of a raw exception that has to
be re-run from scratch. Will make real LLM calls across ~250 attachments —
budget real time and quota for this, and lean on the Gateway→Groq fallback
so a mid-run rate limit doesn't stall it outright.

**4. Get `sample_submission.json` + `loader.py`.**
Not something an agent can generate — needs the original hackathon ZIP or
its Docker-server option. Blocks confirming the output schema and writing
`build_submission()`. Worth chasing early since it might reshape what #1/#2's
output needs to look like — don't over-invest in a guessed schema before
this lands.

**5. Generate and self-evaluate a submission.**
Once #4 unblocks the schema: fold classify+compare+escalate output into that
shape, call `/submit` or `inbox.submit(...)`, iterate on the score.

**6. Connect the frontend to real backend data.**
Correctly deferred until the above is solid — no point building UI around a
pipeline still missing escalation and full-dataset coverage. `frontend/`
already has MongoDB wiring (`frontend/src/lib/mongodb.ts`) and its own
parallel AI-Gateway-based classifier (`frontend/src/lib/classify.ts`) for a
separate Gmail-sync feature — keep that prompt in sync with
`backend/classify.py`'s if either changes, per that file's own comment.

**7. OCR for scanned documents (`email_512`–`514`).**
Explicitly the "advanced stage" per the problem statement. `OCRApi.py` is an
unwired Document AI experiment on one hard-coded file — needs generalizing
and wiring into `readers.py`'s `pdf_no_text_layer` path. Lowest priority of
the functional gaps.

**8. Docs/logging cleanup.**
Structured logging doesn't exist yet (error handling does — try/except per
email, `read_error` convention throughout). Keep this file and `todo.md` in
sync as the above lands; they drifted from the code before and caused real
confusion this session — don't let that happen again.
