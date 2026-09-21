# Handover — Averis x Monash Hackathon 2026

_Last updated: 2026-09-22, after a third session the same day. The first
two sessions built and hardened the pipeline itself; this one wired the
Mongo integration the earlier plan (`clanker-food/claudes-plan.md`, written
before the pipeline existed) always called for but never implemented:
`backend/db.py` (pymongo, opt-in `--write-db` on `backend/pipeline.py`) on
the write side, and `frontend/src/models/Result.ts` +
`frontend/src/lib/results.ts` on the read side, replacing the comparison
and review pages' hardcoded `frontend/src/data/averis-data.ts` mock with
real MongoDB reads. A first pass at this was built by one agent and
reviewed by a second before being reported done -- the review caught 4 real
bugs (see "Known issues / gotchas" below), all fixed and re-verified in the
same session. If you are a new agent picking this up: read this whole
file before touching code -- the "Plan for what's still open" section at
the bottom is short now, and almost everything left is either externally
blocked or explicitly deferred._

**Start here, in order:** (1) `RUN_LIVE_DB_TESTS=1 pytest tests/test_db.py`
then `python -m backend.pipeline . 5 --write-db` then check `/review` and
`/comparison/<id>` in the frontend -- the Mongo path has never been
live-verified end-to-end, only mocked (see "Known issues"); (2) chase
`sample_submission.json`/`loader.py` -- the one real external blocker,
gating several plan items below; (3) run extraction over the full ~250
attachments -- `data/extractions.json` only has 3 real entries. Full detail
on all of this is in "Plan for what's still open" at the bottom.

## What we're building

An inbox-processing pipeline for a shipping-documentation team:

```
Ingestion → Classification → (comparison requests: Extraction → Comparison | others: skip)
  → Escalation check (uncertain → human review queue) → Retry / human correction
  → Result per email → stream to FE  /  output JSON → self-eval loop
```

Full problem statement + rubrics: `clanker-food/`. Condensed brief: `clanker-food/CLAUDE.md`.
Granular checklist (kept current): `todo.md`.

## Current state

| Stage | Status | Where |
|---|---|---|
| Attachment → text | **done** — txt/pdf/xlsx/docx all supported | `backend/readers.py`, `backend/convert.py` |
| Ingestion | **done** | `backend/ingest.py`, `backend/models.py` |
| Classification | **done** — 520/520 cached in `data/classifications.json`; 45/45 on labelled sample, plus offline regression tests covering ~90/~70-email patterns and all 21 edge cases beyond the labelled sample. Counts: general 151, comparison_request 129, new_si_request 125, invoice_query 75, spam 40 | `backend/classify.py`, `backend/llm.py`, `backend/cli.py` |
| Attachment dedup | **done** — same document attached twice under different names is collapsed before extraction, evidence kept in `duplicate_attachments` | `backend/pipeline.py::dedupe_attachments()` |
| Extraction | **done** (built + tested + live-verified), but only ever run in small batches — `data/extractions.json` has 3 real entries from live checks, not the full ~250 | `backend/extract.py` |
| Comparison | **done** — deterministic normalizer + LLM fallback, both live-verified | `backend/comparison.py` |
| Escalation | **done** — rules-based, no LLM calls, wired into every email's result | `backend/escalate.py` |
| Retry / human correction | **library-level done**, no CLI/API surface yet (blocked on the submission schema below) | `backend/review.py` |
| OCR for scanned docs | **wired, not live-verified** — reaches real Document AI, but this machine has no GCP Application Default Credentials configured | `backend/ocr.py`, `backend/readers.py::_read_pdf` |
| Output JSON + self-eval | **blocked** — `sample_submission.json` / `loader.py` / self-eval docker still not in the repo | — |
| MongoDB integration | **done** — `backend/db.py` (pymongo, opt-in `--write-db`), `frontend/src/models/Result.ts`, `frontend/src/lib/results.ts`. Not yet run live against a real Atlas cluster (see Known issues) | `backend/db.py`, `frontend/src/models/Result.ts`, `frontend/src/lib/results.ts` |
| Frontend | comparison + review pages now read real MongoDB `Result` docs (`getComparisonResult`/`getReviewQueue`), not the `averis-data.ts` mock. `data/averis-data.ts` is still in the repo (its `categoryLabels`/`reviewQueue` mock export is still used by `inbox-screen.tsx`'s label lookup) but no longer drives the comparison/review pages | `frontend/src/app/comparison/[emailId]/page.tsx`, `frontend/src/app/review/page.tsx` |

Tests: `pytest tests/` → 191 tests (187 offline, 4 live — 3 gated on `AI_GATEWAY_API_KEY`, which this machine has configured, so those 3 actually run against the real Gateway on every `pytest tests/` here (pre-existing, documented trade-off, see "Known issues"); 1 gated on **both** `MONGODB_URI` **and** `RUN_LIVE_DB_TESTS=1`, which correctly skips on a plain `pytest tests/` even though `MONGODB_URI` is also configured here — see "Known issues" for why that test needs its own separate opt-in instead of just `MONGODB_URI`).

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
| `backend/pipeline.py` | Glue: `ingest → classify → identify SI/BL → dedupe → extract → compare → escalate`. Every email gets a result now, not just `comparison_request` ones | `run_pipeline()`, `compare_si_vs_bl()`, `process_comparison_requests()`, `dedupe_attachments()` |
| `backend/escalate.py` | Rules-based escalation, no LLM calls. Reads classification confidence, attachment `read_error`s, the comparison result, and the extraction cache's per-field confidence; produces `{required, reasons: [{code, detail}], resolved, resolved_by, resolution_note}` per email | `evaluate_email()`, `annotate_with_escalation()`, `escalation_queue()` |
| `backend/review.py` | The human side of escalation: retry a failed/stale email, or record a correction and have it resolve the mismatch. No CLI/API wired to these yet (see Plan below) | `retry_email()`, `retry_and_reannotate()`, `record_correction()`, `apply_corrections()`, `mark_resolved()` |
| `backend/ocr.py` | Document AI OCR fallback for scanned PDFs, generalized from the one-off `OCRApi.py` experiment. `readers.py::_read_pdf` calls it automatically when pdfplumber finds no text | `ocr_pdf()`, `OCRUnavailable` |
| `backend/db.py` | Sync pymongo client that upserts `process_comparison_requests()`'s per-email results into MongoDB Atlas's `results` collection, keyed on `(owner, email_id)` — the same join key `frontend/src/models/Email.ts` uses on `(owner, id)`. `MONGODB_URI`/`MONGODB_DB` env vars, same names as `frontend/.env.example`. This is the **only** integration point between the Python backend and the Next.js frontend — see "MongoDB is the integration boundary" below | `get_client()`, `upsert_results()` |
| `backend/cli.py` | `classify [--force] [--limit N]`, `eval-classify` | |
| `tests/labels_sample.json` | 45 hand-labelled emails (acceptance bar for the classifier) | |
| `data/classifications.json` | Cached classifier output, keyed by email_id, **committed** so teammates without a key can build downstream | |
| `data/extractions.json` | Cached extraction output — 3 real entries so far (`email_004_SI/BL`, `email_507_SI`) from live sanity checks, not the full ~250 | |
| `data/corrections.json` | Human correction ledger written by `backend/review.py::record_correction()` — doesn't exist yet, created on first use | |

## Design decisions (and why)

- **Attachments become text once, on disk.** `output/converted_text/<basename>.txt` is the single source of truth; LLM stages never see raw files. `output/` is gitignored (regenerable in seconds). `convert.py` writes with `newline=""` — a Windows-only bug where `Path.write_text()`'s default newline translation (`\n`→`\r\n`) was silently inflating every converted file's character count was found and fixed this session.
- **Readers never raise... except when they should.** Failures become `read_error` (`file_not_found`, `unsupported_extension`, `extension_mismatch`, `pdf_no_text_layer`, or the exception name) — that string is the escalation signal downstream. `_read_txt` used to pass `errors="replace"`, which silently substituted `�` for genuinely malformed bytes instead of raising — meaning real corruption produced no `read_error` and never reached escalation. Fixed this session: it's strict now, so `read_attachment`'s existing try/except turns that into a proper `read_error`. Checked against all 192 real `.txt` attachments — none are actually malformed, so this only tightens behavior for hypothetical bad input.
- **Category = sender's intent in the body.** Attachment presence/readability is *not* a category signal — escalation handles it. So `email_507` ("compare SI and draft BL … the draft BL is still missing") is still `comparison_request`.
- **Gateway-first, Groq-fallback, strict JSON-schema, temperature 0.** Schema is generated from the pydantic model (`strict_schema()` adds `additionalProperties:false` + all-required). Not every model behind the Gateway honors `response_format` reliably — `backend/llm.py::_coerce_to_schema_shape()` adapts a bare array (or an object holding exactly one array) into the expected wrapper shape before validating; this was a real, live-reproduced failure (a classification call for `email_072` came back as a bare array instead of `{"results": [...]}`), not a theoretical one.
- **Batching 10 emails per call for classification.** Keeps well inside provider rate limits; the system prompt is paid once per batch.
- **Resumable caches.** `classify_all`/`extract_all` write their cache after every batch/item and skip cached ids on rerun. `--force` re-classifies everything (costs a fresh full run — check rate limits first).
- **`compare_documents_with_fallback`'s LLM second opinion never turns a match into a mismatch** — it can only resolve a deterministic mismatch that turns out to be a false positive (wording the normalizers don't cover). `compare_jsons()` (the actual LLM call) was missing entirely until this session — it existed only as a self-import (`from backend.comparison import compare_jsons`) with no matching definition anywhere, so `use_llm_fallback=True` crashed with `ImportError`. All 20 `test_compare.py` tests still passed because they stub out the whole module via `sys.modules`, which is why this went unnoticed. Now implemented and live-verified in both directions (keeps a genuine mismatch flagged; resolves a deterministic false positive).
- **No DB during development; MongoDB is the integration boundary once results need to leave the batch job.** The pipeline itself stays pure pydantic + JSON (`data/classifications.json`/`extractions.json`/`corrections.json`) — that's what kept every stage testable without a live database. `backend/db.py` only exists to hand the *finished* per-email results dict to Mongo, once, at the end of a run (`--write-db`), matching `clanker-food/claudes-plan.md`'s original plan (written before any of this pipeline existed) for a `backend/db.py` + `results` collection. **Vercel hosts the frontend only.** The pipeline is a batch job with real wall-clock cost (LLM rate limits) — it is not, and will never be, deployed as a Vercel function; it runs out-of-band (a developer's machine, CI, or a small separate worker, not decided/needed for the hackathon) and writes into the same MongoDB Atlas cluster the Vercel-hosted Next.js app reads from via `frontend/src/lib/results.ts`. Frontend and backend never call each other directly.
- **`Result` is keyed `(owner, email_id)`, mirroring `Email`'s `(owner, id)`.** `owner` is `"shared"` (the demo dataset, `backend/pipeline.py::DEFAULT_RESULT_OWNER`, matching `frontend/src/lib/constants.ts`'s `SHARED_OWNER`) unless a real signed-in user's synced inbox is being processed. Both collections' Mongoose schemas set an **explicit** `collection` name (`"results"`) rather than relying on Mongoose's pluralization guess, and `backend/db.py::RESULTS_COLLECTION` is hardcoded to the same literal string — the two sides agree by being told to, not by coincidence.
- **A `Result` document only ever records what `backend/comparison.py`'s `CompareResult` actually produces — a pre-existing information-loss characteristic of `compare_documents()`'s own output shape, not something the Mongo integration introduced.** `compare_documents()` only records SI/BL *values* (`details[field] = {si, bl}`) for a field it flagged as mismatched or missing; a matched field's value is never persisted anywhere, only the fact that it matched. This was already true of `CompareResult` before `backend/db.py`/`Result.ts` existed — writing results into Mongo just makes the gap visible in the UI, it doesn't create it. So the comparison table the frontend renders can show every one of the 7 canonical fields' match/mismatch status, but the actual SI/BL text for a *matched* field is not recoverable from `Result` alone — `frontend/src/lib/results.ts::toFields()` deliberately returns `null` for a matched field's `siValue`/`blValue` rather than fabricating something. Fixing this for real (if a judge wants a full always-both-values table) means changing `backend/comparison.py`'s `CompareResult` shape to also carry matched-field values, which this session deliberately did not do — it would touch the 20 `test_compare.py` tests and the core comparator contract, out of scope for a Mongo-plumbing task.
- **Escalation is pure rules, no LLM calls.** `evaluate_email()` checks: missing/low-confidence classification, unreadable/missing attachments, ambiguous SI/BL detection (specifically named `ambiguous_si_bl`, distinct from a generic `processing_error`), and missing/low-confidence extracted fields read straight from the extraction cache — not from the already-masked `flatten_extraction()` output, so a low-confidence value can still be surfaced as a reason even though comparison itself treats it as absent. A confident `mismatch` result is deliberately **not** an escalation reason — that's a real finding for a human to act on, not uncertainty about the pipeline's own output.
- **Duplicate attachments are deduped by content hash, before extraction.** `dedupe_attachments()` collapses byte-identical `.text` across attachments (same document, different filename, or the same path listed twice) down to one representative, so it's extracted once instead of twice, and doesn't masquerade as "2 SI-typed" during auto-detection. Unreadable attachments (`text=None`) are never deduped against each other. Verified none of the real 520 emails actually hit this case (hashed every attachment file, no collisions) — this is defensive, same as `_read_txt`'s strict-UTF-8 fix above.
- **Retry evicts only the retried email's own cached attachments**, not `extract_all(force=True)`'s entire cache — `backend/review.py::retry_email()` pops just those keys from `data/extractions.json` before re-running, so retrying one bad email doesn't force every other already-cached email to be re-extracted (and re-billed) too.
- **A correction resolves a result; it doesn't just log a wish.** `apply_corrections()` actually removes the corrected field from `incorrect_or_missing`/`details` and flips `status` back to `"match"` once nothing's left outstanding — a human's correction has to change the same shape a fresh comparison would have produced, not sit next to it as an ignored annotation.
- **OCR fallback only fires when pdfplumber's own pass finds no text**, and only replaces `pdf_no_text_layer` with real text on success. If Document AI isn't configured (`PROJECT_ID`/`PROCESSOR_ID`/`LOCATION` env vars unset), it falls through to the old behavior unchanged (`OCRUnavailable`). Any other OCR failure (bad credentials, quota, network) is left to propagate and becomes its own `read_error` string — never silently remapped back to `pdf_no_text_layer`, since that would hide a real, different problem.

## Dataset findings (important for whoever does the next stages)

- 520 emails, 126 with attachments (124 have SI+BL pairs, `email_507`/`email_509` have SI only). 250 attachments: 192 txt, 28 pdf, 22 xlsx, 8 docx.
- **Subjects are shuffled relative to bodies** (e.g. `email_021`: RPA-billing subject, "submit SI reminder" body). Trust the body.
- **Emails 500–520 are the deliberate edge cases**:
  - 501–505: second attachment is a Packing List / Commercial Invoice / Certificate of Origin, *named* `_BL` — extraction must notice it isn't a BL.
  - 506, 508, 510: "attachments appear to have been dropped" (none attached).
  - 507, 509: BL missing.
  - 511, 515: `_BL.pdf` is corrupt (770 bytes) → `PdfminerException`.
  - 512–514: image-only scanned PDFs → `pdf_no_text_layer` unless `backend/ocr.py`'s Document AI fallback is configured and credentialed (see "Known issues" — not live-verified on this machine yet).
  - 516–520: "Some SI fields were left blank by the customer".
- ~90 emails say "Please assist to send the draft BL for X for checking" with no attachments. Labelled **general** (asks us to *send* a document, not compare two). If the self-eval disagrees, it's a one-line prompt change in `SYSTEM_PROMPT`.
- ~70 emails have SI details written inline in the body ("Please find Shipping instruction for … POL/POD/Shipper/Consignee") → `new_si_request`, even when they close with "revert with draft BL once available".
- Automated "billing process completed, no action required" RPA notices → `general`, not `invoice_query`.
- Spam domains: `webmail-verify.co`, `prize-claims.info`, `secure-mailbox.org`, `parcel-track.co`.
- Confirmed real, correct mismatch caught: `email_004` — SI names one consignee/notify party, BL names a different one entirely. Not a normalization false positive.

## Known issues / gotchas

- **Rate limits, twice over.** The Gateway can rate-limit; Groq (its fallback) has its own free-tier limits too (~1 batch per 30–40s historically). A full extraction run over ~250 attachments will take real time and consume real quota on whichever provider ends up serving it — don't run it repeatedly without reason.
- **The 3 live tests in `tests/test_classify.py` cost real API calls** every time they run (they're not mocked) — they're gated on `AI_GATEWAY_API_KEY` being set, so they'll run on every `pytest tests/` in a fully-configured environment. Fine for occasional verification; don't loop on them.
- `GmailAPI.py` at repo root is a standalone experiment (Gmail label listing), not wired in, with a path bug at `GmailAPI.py:17-19` (checks `attachments/token.json`, loads `token.json`). `OCRApi.py` is the same kind of one-off experiment, but its Document AI logic is now generalized into `backend/ocr.py` and actually wired into `readers.py` — `OCRApi.py` itself is unchanged and still hard-codes one test file.
- **This machine has no GCP Application Default Credentials.** `PROJECT_ID`/`PROCESSOR_ID`/`LOCATION` are set in `.env` and `backend/ocr.py` correctly reaches the real Document AI API, but every live call fails with `DefaultCredentialsError` (surfaced as a clean `read_error`, not a crash). Run `gcloud auth application-default login`, or set `GOOGLE_APPLICATION_CREDENTIALS` to a service account key, before trying to actually OCR `email_512`–`514`.
- `.gitignore` had literal unresolved merge-conflict markers checked into it (`<<<<<<< HEAD` / `=======` / `>>>>>>>`) from a merge that was never cleanly finished — fixed this session, now one deduplicated file covering `.env`, `apiDetails.env`, `.venv/`, `credentials.json`, `token.json`, `__pycache__/`, `.pytest_cache/`, `output/`, `.DS_Store`.
- Missing from repo: `loader.py`, `sample_submission.json`, docker-compose for the self-eval server (there IS a `docker-compose.yml` at repo root, but it's for local MongoDB per `README.md`, not the hackathon self-eval server — don't confuse the two). Get the real ones from the hackathon ZIP or its Docker option — `sample_submission.json` is the output contract that must be matched, and it also blocks giving `backend/review.py`'s retry/correction primitives a CLI or API (they need a persisted `email_id -> result` store, whose shape follows the submission schema).
- No caller anywhere passes an explicit `model=` to `structured_completion`/`astructured_completion` — if you add one, note that `backend/llm.py`'s `model: str | None = None` default resolves to `GATEWAY_MODEL` or `GROQ_MODEL` depending on which provider actually ends up serving the call, not a single shared default.
- **This machine *does* have a real `MONGODB_URI` configured in `.env`, pointing at a live Atlas cluster** — it's needed for the frontend dev server / `--write-db` to work at all, and `backend/llm.py` calls `load_dotenv()` at import time, so `MONGODB_URI` ends up in `os.environ` for basically any `pytest tests/` run in this environment, not just ones that deliberately opt into hitting Mongo. That's exactly why `tests/test_db.py::test_live_upsert_results_roundtrip` is gated on **both** `MONGODB_URI` **and** a separate `RUN_LIVE_DB_TESTS=1` — gating on `MONGODB_URI` alone (the original version of this test, fixed after a review caught it) meant a plain `pytest tests/` in this environment silently wrote to and deleted from the real cluster under owner `__backend_db_test__` every time, which is not something a test suite should do implicitly. Run `RUN_LIVE_DB_TESTS=1 pytest tests/test_db.py` deliberately when you want that live check; otherwise it's skipped.
- **Four real bugs an Opus review caught in this session's first pass at the Mongo integration, all fixed:** (1) the live-DB test gating leak described above; (2) `duplicate_attachments` was originally a Mongoose `Map` keyed by attachment *path* (`backend/extract.py::_attachment_key`), which routinely contains dots — a dotted Map key throws on hydration and needs Mongo ≥5.0 even at the driver level, so it's now an array of `{kept, dropped}` subdocuments instead (`backend/db.py::_reshape_document`, `Result.ts`'s `duplicateAttachmentGroupSchema`); (3) `upsert_results` used bare `$set`, so an optional field present on an earlier write (e.g. `retried: true`, or a mismatch's `details`) would survive forever on a later rerun whose new record no longer has it — fixed with an explicit `$unset` for any of `_OPTIONAL_KEYS` missing from the new record; (4) `getReviewQueue` was missing the same `(email_id, owner)` collision tie-break `getComparisonResult` already had, so a collision could render two rows for one email and collide on `review-screen.tsx`'s React `key`.
- **The MongoDB read/write path is code-complete and unit-tested (mocked), but has not been live-verified end-to-end by this session** (the fix above was applied *instead* of running the live test, specifically to avoid another unintended live write while wrapping this up). `backend/db.py`'s non-live tests (`tests/test_db.py`) all mock the collection/client — real correctness (the two sides' `results` collection name actually agreeing, the `(owner, email_id)` upsert key actually working against a real Atlas cluster) has mostly been checked by careful reading, not a live round-trip. Whoever picks this up next should run `RUN_LIVE_DB_TESTS=1 pytest tests/test_db.py`, then `python -m backend.pipeline . 5 --write-db`, then load `/review` and `/comparison/<an email_id from that run>` in the frontend, before trusting this in front of judges.
- **No `Result` documents exist yet for the real 520-email dataset.** `--write-db` is opt-in and has never been run against production data (no full extraction run has happened either — see plan item #2) — until someone runs the pipeline with `--write-db`, `/review` and `/comparison/<id>` will correctly show their "nothing needs review" / "not yet processed" empty states, not an error.

## Plan for what's still open

Most of the functional pipeline is done now. What's left is either
externally blocked or deliberately deferred — ordered by dependency.

**1. Get `sample_submission.json` + `loader.py` — the one real blocker.**
Not something an agent can generate — needs the original hackathon ZIP or
its Docker-server option. Blocks: confirming the output schema, writing
`build_submission()`, and giving `backend/review.py`'s retry/correction
primitives a CLI or API (they need a persisted `email_id -> result` store,
and that store's shape should follow the real schema, not a guessed one).
Chase this first — it's the dependency everything below sits behind.

**2. Run extraction over the full inbox.**
`data/extractions.json` has only 3 real entries (`email_004_SI/BL`,
`email_507_SI`) from this session's live sanity checks — the other ~247
attachments have never been extracted. Will make real LLM calls across
the full set — budget real time and quota, and lean on the Gateway→Groq
fallback so a mid-run rate limit doesn't stall it outright. Every email
now gets a proper escalation record instead of a raw exception if one
fails mid-run, so this is safe to run at full scale whenever it happens.

**3. Generate and self-evaluate a submission.**
Once #1 unblocks the schema: fold classify+compare+escalate output into
that shape, call `/submit` or `inbox.submit(...)`, iterate on the score.

**4. Build a CLI/API surface for `backend/review.py`.**
The retry/correction primitives (`retry_email`, `record_correction`,
`apply_corrections`, `mark_resolved`) exist and are tested, but nothing
calls them yet — deliberately deferred until #1 lands, since a reviewer
needs to look up a persisted result by `email_id`, and that store doesn't
exist until the submission schema does.

**5. Connect the frontend to real backend data — done for reads, still
needs a real data run.**
`frontend/src/lib/results.ts` (`getComparisonResult`, `getReviewQueue`) and
`frontend/src/models/Result.ts` are in; `/comparison/[emailId]` and
`/review` read Mongo instead of `data/averis-data.ts`'s mock. What's still
open: (a) nobody has actually run `python -m backend.pipeline --write-db`
against the real 520-email dataset yet (blocked behind plan item #2, the
full extraction run — no point writing partial/stale results); (b) the
Mongo round-trip itself is unverified on real Atlas, not just mocked (see
"Known issues"); (c) no write/mutation API exists yet for a reviewer to
actually resolve/correct from the UI — `backend/review.py`'s primitives
are still only called from Python, same reasoning as plan item #4.
`frontend/` already had MongoDB wiring (`frontend/src/lib/mongodb.ts`) and
its own parallel AI-Gateway-based classifier (`frontend/src/lib/
classify.ts`) for a separate Gmail-sync feature — keep that prompt in sync
with `backend/classify.py`'s if either changes, per that file's own
comment. This item was originally specified in `clanker-food/claudes-
plan.md` (written before the pipeline existed) as "add a Python Mongo
client... so the pipeline stages write to the same collections the
frontend reads" — that's exactly what `backend/db.py` now does.

**6. Live-verify OCR end-to-end.**
Code-complete (`backend/ocr.py`, wired into `readers.py`), mock-tested,
but this machine has no GCP Application Default Credentials — see "Known
issues" above. Whoever owns the GCP project needs to set those up, then
confirm `email_512`–`514` actually OCR successfully, not just that the
code path reaches the API without crashing.

**7. Hand-check classification beyond pattern-matching.**
This session added offline regression tests (§2 in `todo.md`) covering
the labelled sample, 6 named tricky cases, three inbox-wide regex-matched
patterns, and all 21 edge-case emails — plus a manual spot-check of the 8
lowest-confidence classifications outside the labelled sample (all
correct). The other ~470 un-labelled, non-edge-case emails are still only
pattern/confidence-scanned, not individually hand-checked.

**8. Docs/logging cleanup.**
Structured logging doesn't exist yet (error handling does — try/except per
email, `read_error` convention throughout). Keep this file and `todo.md` in
sync as the above lands; they drifted from the code before and caused real
confusion earlier in this project — don't let that happen again.
