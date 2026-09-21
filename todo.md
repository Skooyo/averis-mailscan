# TODO

_Last updated: 2026-09-22 (fifth pass same day). Fourth pass implemented
HANDOVER.md's plan item #5 (§9 below): `backend/db.py` (pymongo, opt-in
`--write-db` on `backend/pipeline.py`) plus `frontend/src/models/Result.ts`
and `frontend/src/lib/results.ts`, wiring `/comparison/[emailId]` and
`/review` to real MongoDB `Result` docs instead of `data/averis-data.ts`'s
mock. This is exactly what `clanker-food/claudes-plan.md` (the original
architecture doc, written before the pipeline existed) called for under
"Add a Python Mongo client (`backend/db.py` with pymongo, `MONGODB_URI`
from `.env`) so the pipeline stages write to the same collections the
frontend reads" — see "Known issues (fixed)" at the bottom for what's
newly done and what's still open within each. This (fifth) pass live-
verified the write path for the first time: `python -m backend.pipeline .
5 --write-db` produced 5 real `Result` docs in Atlas, confirmed in Compass
(§9). It also found the frontend read side can't actually be exercised
yet — `frontend/.env` doesn't exist, only `.env.example` — so the read
path is code-complete but still visually unconfirmed._

## 🔴 Blocking — do these two first

- [x] ~~Resolve `backend/comparison.py`'s fate.~~ There is no separate
      `backend/compare.py` file — the deterministic comparator (case/port/
      container/weight normalization, `compare_documents`) lives directly in
      `backend/comparison.py`; its own module docstring still says
      "backend/compare.py", a leftover from a rename that was never
      corrected. `compare_documents_with_fallback`'s
      `from backend.comparison import compare_jsons` was a **self-import**
      referencing a function that didn't exist anywhere — confirmed live:
      calling it with `use_llm_fallback=True` raised
      `ImportError: cannot import name 'compare_jsons'`. All 20
      `test_compare.py` tests still passed because they monkeypatch
      `sys.modules["backend.comparison"]` with a stub that *does* define
      `compare_jsons`, masking the real gap. **Fixed:** implemented a real
      `compare_jsons(json_a, json_b)` in `backend/comparison.py` that asks
      the LLM to double-check only the fields the deterministic pass flagged;
      verified live against a genuine mismatch and confirmed it no longer
      crashes and returns a sane verdict.
- [ ] **Share `sample_submission.json` and `loader.py`.** Still not present
      anywhere in the repo (checked exhaustively — not just misplaced).
      Blocks confirming the submission schema (§1) and writing
      `build_submission()` (§8) — can't be done from the problem statement
      alone.

## 1. Dataset and output contract

- [x] `inbox/` present (520 emails)
- [x] `attachments/` present (250 files: txt/pdf/xlsx/docx)
- [ ] `sample_submission.json` — not yet shared
- [ ] `loader.py` — not yet shared
- [ ] Confirm the required submission schema
- [x] Ensure every `email_id` is included in the final output — **fixed**:
      `process_comparison_requests` now writes an entry for every email
      regardless of category (`status="skipped"` with the category named,
      or `status="unclassified"` if classification is missing); only
      `comparison_request` emails still go through `compare_si_vs_bl`.
      Live-verified against `email_004`/`email_507` (see bottom of file).

## 2. Email classification

- [x] Load inbox records (`ingest.load_inbox`)
- [x] Classify emails into the 5 categories (`classify.classify_all`)
- [x] Run classification across the full inbox — **done**: 520/520 cached in
      `data/classifications.json` (general 151, comparison_request 129,
      new_si_request 125, invoice_query 75, spam 40), 0 below the 0.6
      confidence floor. Confirmed against the labelled sample
      (`tests/labels_sample.json`, 45 emails) via `test_live_gateway_classification`.
- [x] Add regression tests for representative examples — **done**, and
      offline (reads `data/classifications.json`, zero LLM calls, so these
      run on every `pytest tests/`, not just when `AI_GATEWAY_API_KEY` is
      set). `tests/test_classify.py` now has:
  - `test_full_labelled_sample_matches_cached_classification` — turns the
    manual `cli eval-classify` report into a real assertion (all 45/45,
    still passing).
  - `test_representative_classification_examples` — 6 parametrized cases,
    each naming *why* it's tricky, referencing HANDOVER.md's own dataset
    findings (shuffled subjects, RPA no-action notices, "assist to send"
    vs. comparison, "revert with draft BL" closings, spam domains, missing
    attachments not changing category).
  - `test_no_attachment_assist_send_draft_emails_are_classified_general`,
    `test_inline_si_request_emails_are_classified_new_si_request`,
    `test_rpa_billing_no_action_notices_are_classified_general` — each
    scans the **full inbox** (not just the labelled 45) for its pattern via
    regex and checks every match against the cache, so these three
    documented gotchas are now regression-tested at their real scale
    (~90, ~70, and 15 matching emails respectively), not just the 1-2
    examples that happened to make the labelled sample.
- [x] Review classification errors against the problem statement —
      **done for this pass**: confirmed all 21 edge-case emails
      (`email_500`-`520`) classify consistently (500 → `invoice_query`,
      501-520 → `comparison_request`, 0.92-0.99 confidence) and locked
      that in as `test_edge_case_emails_500_to_520_land_in_documented_categories`.
      Also spot-checked the 8 lowest-confidence classifications *outside*
      the labelled sample (all still 0.92+, e.g. `email_080`/`email_220` —
      "asks to send the draft BL for checking, not a comparison request")
      — reasoning holds up against the category definitions, no
      misclassification pattern found. Not exhaustive: the other ~470
      un-labelled emails still haven't been individually hand-checked,
      just pattern-matched and confidence-scanned.

## 3. Attachment handling

- [x] Resolve attachments using `path` and `text`
- [x] Identify the SI and draft BL for comparison requests —
      `compare_si_vs_bl` auto-detects via `Extraction.doc_type_detected`,
      raises loudly on ambiguity instead of guessing
- [x] Handle missing, duplicated, or ambiguous attachments — **done**. An
      ambiguous SI/BL `ValueError` becomes a proper
      `escalation.reasons[].code == "ambiguous_si_bl"` entry instead of a
      bare caught exception (see §6) — live-verified on `email_507`.
      Duplicate handling: `backend.pipeline.dedupe_attachments()` collapses
      attachments with byte-identical text (the same document attached
      twice under different filenames, or the same path listed twice)
      down to one representative *before* extraction runs — avoids a
      wasted extraction call, and avoids a false `ambiguous_si_bl`
      escalation when it's actually one document, not two. Dropped
      duplicates are recorded as evidence in the result's
      `duplicate_attachments` key (`{kept_key: [dropped_key, ...]}`), not
      silently discarded. 6 tests. Not done on this dataset's real 520
      emails specifically because none of them actually contain a
      duplicate attachment (checked) — this is defensive, matching the
      project's existing pattern of building for the general case even
      when today's data doesn't exercise it (see `_read_txt`'s strict
      UTF-8 handling in HANDOVER.md).
- [x] Add clear errors for unreadable attachments — `read_error` is
      captured by `readers.py`/`ingest.py`, including genuinely malformed
      `.txt` bytes (fixed: `_read_txt` no longer silently substitutes
      `�` via `errors="replace"`; it now raises so `read_attachment`
      turns it into a proper `read_error`, tested, and confirmed against
      all 192 real `.txt` attachments — none are actually malformed, so
      this only tightens behavior for hypothetical bad input). Still needs
      wiring into escalation once `escalate.py` exists.

## 4. Data extraction

- [x] Use `backend/extract.py` for the seven canonical fields
- [x] Capture confidence and evidence (`ExtractedField`)
- [ ] Run extraction across the complete dataset — only 5 sample emails
      run so far (`python -m backend.pipeline . 5`), not the full inbox
- [ ] Save and validate `data/extractions.json` — file is being written
      correctly (confirmed via manual inspection of `email_004`), but not
      validated against the full dataset yet
- [x] Add extraction unit tests — `test_extract.py`, 10 tests passing
- [x] Escalate missing or low-confidence values instead of guessing —
      **fixed**: `backend/escalate.py::evaluate_email` reads the extraction
      cache directly (independent of `flatten_extraction`'s masking) and
      raises `missing_extracted_field` / `low_confidence_extraction`
      reasons per field, with the attachment path and field name as
      evidence. See §6.

## 5. Deterministic comparison

- [x] Add the deterministic comparator — lives in `backend/comparison.py`
      (there is no separate `compare.py`; the module's own docstring header
      is just stale)
- [x] Compare SI values against BL values
- [x] Normalize:
  - [x] Case and whitespace
  - [x] Punctuation
  - [x] Company suffixes
  - [x] Equivalent port labels
  - [x] Container expressions such as `3 x 40HC`
  - [x] Weight units such as kg, MT, tonnes, and lb
- [x] Produce field-level differences with SI and BL values (`FieldDifference`)
- [x] Return `No mismatch detected` when all seven fields match
      (`NO_MISMATCH_MESSAGE`)
- [x] Add unit tests for normalization and comparison — ~20 tests,
      `test_compare.py`
- [x] ~~Decide whether `backend/comparison.py` should be replaced, renamed,
      or retained as an LLM-assisted fallback~~ — retained as the fallback;
      `compare_jsons` is now implemented (see 🔴 Blocking above)
- [x] Verified against a real mismatch (`email_004`: SI names one
      consignee/notify party, BL names a different one — correct catch,
      not a false positive)

## 6. Human escalation

- [x] Add `backend/escalate.py` — **done**. Rules-based, no LLM calls:
      `evaluate_email(email, classification, result, extraction_cache)` ->
      `EscalationReport(required, reasons=[{code, detail}, ...])`.
      `annotate_with_escalation()` adds an `"escalation"` key to every
      email's result record in `pipeline.process_comparison_requests`;
      `escalation_queue(results)` filters to the ones needing review.
      21 unit tests in `tests/test_escalate.py`.
- [x] Escalate when:
  - [x] Attachments are missing (`missing_attachment`, for
        `comparison_request`/`new_si_request` categories with zero
        attachments)
  - [x] Documents are unreadable (`unreadable_attachment`, one per
        attachment with a `read_error`)
  - [x] Required fields are missing (`missing_extracted_field`, read
        straight from the extraction cache)
  - [x] Extraction confidence is low (`low_confidence_extraction`, floor
        0.5, configurable via `field_confidence_floor`)
  - [x] Values are ambiguous (`ambiguous_si_bl` — specifically detects
        `compare_si_vs_bl`'s "Could not uniquely identify" `ValueError`
        message; live-verified on `email_507`, the missing-BL edge case)
  - [x] Processing fails — `process_comparison_requests`'s catch block now
        tags the category and feeds the error message into escalation
        (`processing_error` for anything else); the bare
        `{"status": "error", "message": ...}` shape is unchanged for
        backward-compat, `escalation` is just an added key
  - [x] Classification is missing or low-confidence (`unclassified` /
        `low_confidence_classification`, floor 0.6) — not in the original
        list but a clear gap otherwise: an unclassified email would
        silently fall into "skipped" with no signal anything was wrong
- [x] Include email ID, evidence, extracted values, and escalation reason —
      each reason's `detail` string carries the evidence (attachment path +
      read_error, field name + confidence, or the raw exception message);
      `email_id` is the result dict's key
- [x] Support retry and human correction workflows — **library-level done**
      in new `backend/review.py` (12 tests, `tests/test_review.py`):
  - `retry_email(email, classification, ...)` — re-runs comparison for one
    email, evicting only *that email's* attachments from the extraction
    cache first (not `extract_all(force=True)`, which would blow away
    every other email's cached extraction too). Rejects non-
    `comparison_request` categories loudly rather than silently no-op'ing.
  - `retry_and_reannotate(...)` — the single call a review UI/CLI would
    make: retries, then re-runs `escalate.evaluate_email` so the result
    and its escalation verdict never drift out of sync.
  - `record_correction(email_id, field, value, note=...)` /
    `load_corrections()` — a persisted ledger (`data/corrections.json`,
    same cache-file pattern as classifications/extractions) of human
    overrides, each with who/why/when.
  - `apply_corrections(results, corrections)` — overlays a correction onto
    a result: a `category` correction overrides it directly; a field
    correction resolves it out of `incorrect_or_missing`/`details` and
    flips `status` back to `match` once nothing's left outstanding.
    Always logged to `result["corrections"]` and marks
    `escalation.resolved = True` — the original `reasons` stay as a
    historical record of what was originally wrong.
  - `mark_resolved(...)` for the "human looked at it, it's fine as-is, no
    value needs changing" case.
  - **Still open**: no CLI or API surface calls these yet. Deliberately
    not built this pass — a reviewer needs to look up a *persisted*
    `email_id -> result` store to know what to retry/correct, and that
    store's shape depends on the still-missing `sample_submission.json`
    schema (the 🔴 blocking item). Building a CLI against a guessed shape
    risked having to redo it once the real schema lands. These functions
    are the primitives that CLI/API will call once #4 in the plan is
    unblocked.

## 7. End-to-end pipeline

- [x] Implement `inbox → classify → identify attachments → extract → compare`
      (`run_pipeline` in `pipeline.py`)
- [x] Extend to the full `... → escalate → report` — **done**: escalate step
      (§6) now runs inside `process_comparison_requests` after the base
      result is built for every email; report no longer omits
      non-comparison_request emails (§1)
- [x] Process non-comparison emails without unnecessary extraction —
      `process_comparison_requests` filters by category before calling
      `extract_all`
- [ ] Add integration tests — `test_pipeline.py` exists (17 tests) but
      every layer is mocked; nothing has run against real ingest/classify/
      extract end-to-end except the one manual 5-email run
- [ ] Add structured logging and error handling — error handling exists
      (try/except per email, `read_error` convention throughout); no
      structured logging yet

### Known issues (fixed)

- **Cache-scoping bug in `compare_si_vs_bl` (fixed).** `extract_all`
  returns its *entire* accumulated cache from `data/extractions.json`, not
  just the attachments passed to it. `compare_si_vs_bl` was treating the
  return value as scoped to the current call, so once more than one email
  had been processed in a run, prior emails' SI/BL leaked into the current
  email's auto-detection (symptom: "found 2 SI-typed" instead of 1).
  Fixed by filtering to `{_attachment_key(a) for a in attachments}` before
  matching. Also closed the same hole for explicit
  `si_attachment_key`/`bl_attachment_key`, which now must name an
  attachment actually passed in for that call.
- **`compare_jsons` self-import crash (fixed).** See 🔴 Blocking above —
  `compare_documents_with_fallback` crashed with `ImportError` whenever
  `use_llm_fallback=True`, masked by tests that stub out the whole module.
  Implemented the real function; verified live.
- **`.gitignore` had literal unresolved merge-conflict markers (fixed).**
  `<<<<<<< HEAD` / `=======` / `>>>>>>> 60d3...` were checked into the file
  from a merge that was never cleanly finished, with duplicated entries on
  each side. Replaced with one deduplicated file.
- **Windows newline corruption in `convert.py` (fixed).** `Path.write_text()`
  with no `newline=` argument translates `\n` → `\r\n` on Windows, so every
  converted `.txt` file had more bytes than `ConversionResult.chars`
  recorded — caught live by 4 failing `test_convert.py` cases (txt, pdf,
  xlsx, docx all affected). Fixed by writing with `newline=""`; all 8
  `test_convert.py` tests now pass.
- **`process_comparison_requests` silently dropping every non-
  `comparison_request` email (fixed).** Every email now gets a result
  entry: `comparison_request` emails still go through `compare_si_vs_bl`;
  everything else gets `status="skipped"` (with its category) or
  `status="unclassified"` (no classification at all). 2 new
  `test_pipeline.py` cases cover this; 2 existing ones updated. Live-
  verified: running the real pipeline on `email_004` + `email_507`
  reproduced the documented `email_004` mismatch (`consignee`/
  `notify_party`) and the documented `email_507` missing-BL ambiguity,
  both correctly landing in the output with no dropped emails.
- **`compare_si_vs_bl`'s ambiguous-SI/BL `ValueError` and other processing
  failures were bare caught exceptions with no path to a human (fixed).**
  `backend/escalate.py` now classifies them: "Could not uniquely identify"
  becomes `ambiguous_si_bl`, anything else becomes `processing_error`.
  Confirmed live on `email_507`.
- **Scanned PDFs (`email_512`–`514`) had no OCR path (fixed in code; not
  yet live-verified end-to-end).** `readers.py::_read_pdf` now calls
  `backend/ocr.py::ocr_pdf` whenever pdfplumber's own pass finds no text.
  Live-checked against `attachments/email_512_SI.pdf`: the Document AI
  config (`PROJECT_ID`/`PROCESSOR_ID`/`LOCATION`) is present and the code
  reaches the real API, but this machine has no GCP Application Default
  Credentials, so it currently fails with `DefaultCredentialsError` —
  correctly surfaced as a `read_error` string rather than crashing or
  silently masking as `pdf_no_text_layer`, but real OCR text hasn't
  actually been produced from a live call yet. Whoever owns the GCP
  project needs to run `gcloud auth application-default login` (or set
  `GOOGLE_APPLICATION_CREDENTIALS` to a service account key) before this
  can be confirmed working end-to-end.
- **Duplicate attachments weren't handled (fixed).** Same document
  attached twice under different filenames would have been extracted
  twice (wasted LLM calls) and could trip a false `ambiguous_si_bl`
  escalation (looks like "2 SI-typed attachments" when it's actually one).
  `backend.pipeline.dedupe_attachments()` collapses by content hash before
  extraction runs; dropped duplicates are recorded in the result's
  `duplicate_attachments` key. Confirmed none of the real 520 emails
  actually contain a duplicate attachment (hashed every attachment file
  and checked for collisions within each email) — this fix is defensive
  for input this specific dataset doesn't happen to exercise.
- **Escalation was read-only, with no way for a human to act on it
  (fixed).** New `backend/review.py`: `retry_email`/`retry_and_reannotate`
  re-run comparison for one email (evicting only its own cached
  attachments, not the whole extraction cache); `record_correction` /
  `apply_corrections` let a human override a value and have it resolve the
  mismatch and flip status back to match; `mark_resolved` acknowledges an
  escalation without changing anything. No CLI/API wired up yet — see §6
  for why that's deliberately deferred.
- **No automated regression coverage for classification beyond the
  45-email labelled sample (fixed).** Added offline tests (read
  `data/classifications.json`, zero LLM cost) covering the full labelled
  sample as a real assertion, 6 individually-named tricky cases from
  HANDOVER's dataset findings, three inbox-wide pattern checks (~90 "send
  draft BL" emails, ~70 inline-SI emails, RPA no-action notices), and all
  21 of the `email_500`–`520` edge cases. Also spot-checked the 8
  lowest-confidence classifications outside the labelled sample by hand —
  all correctly reasoned, no misclassification pattern found (see §2).

## 8. Submission and evaluation

- [ ] Generate the required submission JSON — blocked on
      `sample_submission.json` (see 🔴 Blocking)
- [ ] Validate the output schema before submission
- [ ] Submit results through `/submit` or `inbox.submit(...)`
- [ ] Review classification and mismatch errors
- [ ] Iterate using the self-evaluation score

## 9. Frontend and API

- [x] Add a backend->MongoDB write path — `backend/db.py` (pymongo,
      `MONGODB_URI`/`MONGODB_DB` env vars, same names as
      `frontend/.env.example`), `upsert_results(owner, results)` keyed on
      `(owner, email_id)`, wired opt-in via `--write-db` on
      `backend/pipeline.py`'s `main()`. 14 mocked tests
      (`tests/test_db.py`) + 1 live test gated on **both** `MONGODB_URI`
      **and** `RUN_LIVE_DB_TESTS=1` -- NOT on `MONGODB_URI` alone like
      `test_classify.py`'s `AI_GATEWAY_API_KEY`-gated tests, because this
      machine's `.env` has a real `MONGODB_URI` for the app to run at all;
      gating on that alone meant a plain `pytest tests/` silently wrote to
      and deleted from the real Atlas cluster every run (caught by review,
      fixed same session -- see HANDOVER.md's "Known issues").
      No REST/API endpoints were added — the pipeline writes directly to
      Mongo, the frontend reads directly from Mongo via Mongoose; there is
      no HTTP boundary between them by design (see HANDOVER.md's
      "MongoDB is the integration boundary").
      **Live-verified 2026-09-22 (fifth pass):** ran
      `python -m backend.pipeline . 5 --write-db` against real emails
      (`email_001`-`005`), confirmed 5 documents landed in Atlas's
      `jobhunters.results` collection via MongoDB Compass (owner=`shared`,
      correct `email_id`/`status`/`escalation` shape). This was a real
      pipeline run, not the synthetic `test_live_upsert_results_roundtrip`
      doc — first actual proof the write path works end-to-end against
      production-shaped data. Still open: the full 520-email run (§4/§9
      below), and confirming the frontend actually renders these 5 docs
      (see the `frontend/.env` gap noted just below — that was still
      missing as of this check, so the read side hasn't been visually
      confirmed yet even though the data is there to read).
- [x] Connect the frontend to real MongoDB data — `frontend/src/models/
      Result.ts` (schema) + `frontend/src/lib/results.ts`
      (`getComparisonResult`, `getReviewQueue`). `/comparison/[emailId]`
      and `/review` now read these instead of `data/averis-data.ts`'s
      mock; `data/averis-data.ts` itself is untouched and still in the
      repo (its `categoryLabels` export is still used by
      `inbox-screen.tsx`).
- [ ] **`frontend/.env` doesn't exist yet (only `frontend/.env.example`),
      found 2026-09-22.** Without it `npm run dev` has no `MONGODB_URI`, so
      `/review`/`/comparison/[emailId]` can't read anything back even
      though real `Result` docs now exist in Atlas (see the live-write
      note above). Fix: `cd frontend && cp .env.example .env`, paste in
      the same `MONGODB_URI` as the root `.env`. Not yet done as of this
      pass — the read side is code-complete but still visually
      unconfirmed against real data.
- [x] Replace mock fields with the seven canonical fields —
      `ComparisonFieldResult`/`CANONICAL_FIELDS` in
      `frontend/src/types/averis.ts` / `frontend/src/lib/results.ts` use
      `shipper`/`consignee`/`notify_party`/`port_of_loading`/
      `port_of_discharge`/`container_count`/`gross_weight_kg` — not the
      mock's `bl_number`/`vessel_name`/`tax_id`/etc, which don't exist in
      the real backend output.
- [x] Display:
  - [x] Email ID
  - [x] Category
  - [x] Match/mismatch status
  - [x] SI value — **only for a mismatched/missing field**; see the
        `CompareResult` gap noted in HANDOVER.md's design decisions —
        `backend/comparison.py` never persists a *matched* field's value,
        so the comparison table honestly shows "matched" with no value
        rather than fabricating one for those rows.
  - [x] BL value — same caveat as SI value above.
  - [x] Escalation reason — full `reasons[]` array (code + detail), not
        just one, on both `/review` and `/comparison/[emailId]`.
- [ ] Add retry and human-review actions — **still not built**, same
      reasoning as §6's "still open" note: `backend/review.py`'s
      `retry_email`/`record_correction`/`apply_corrections`/
      `mark_resolved` are library-level only, callable from Python, not
      exposed as a mutation the frontend can trigger. The `Result` schema
      was designed to represent a corrected/resolved state
      (`corrections[]`, `escalation.resolved`/`resolved_by`/
      `resolution_note`) so adding that surface later doesn't need a
      schema change, but no write API or UI action was built this pass —
      explicitly out of scope per this session's brief.

_Read side code-complete and now live-verified on the write side: 5 real
`Result` docs exist in Atlas (`email_001`-`005`, owner=`shared`) from a
real `--write-db` pipeline run, confirmed in Compass. Not yet confirmed:
that the frontend actually renders them — blocked on the missing
`frontend/.env` noted above, and on the full 520-email run still being
outstanding (§4). Write/mutation side (retry, correct, resolve from the
UI) is still not built — deliberately deferred, see above._

## 10. Advanced document support

- [x] Add PDF support — `backend/readers.py::_read_pdf` (pdfplumber), magic-byte
      validated, tested in `test_readers.py`/`test_convert.py`
- [x] Add Word document support — `_read_docx` (python-docx), paragraphs +
      tables, same tests
- [x] Add table/table-layout handling — `_read_xlsx` (openpyxl) and the
      table-row extraction in `_read_docx` already flatten tables to text
- [x] Add OCR or vision-based extraction for scanned documents — **wired,
      but unverified end-to-end in this environment.** `backend/ocr.py`
      generalizes `OCRApi.py`'s one-off experiment (which hard-coded one
      file and read `.entities` off a form-parser processor) into
      `ocr_pdf(path)`, using `Document.text` instead so it works as a
      generic fallback for any scanned PDF. `readers.py::_read_pdf` calls
      it automatically whenever pdfplumber's own pass comes back empty;
      `OCRUnavailable` (env vars unset) falls through to the old
      `pdf_no_text_layer` behavior unchanged, any other failure (bad
      creds, quota, network) becomes its own `read_error` instead of being
      masked. 9 mocked tests (`tests/test_ocr.py`, `tests/test_readers.py`).
      **Live-checked against `attachments/email_512_SI.pdf`: `PROJECT_ID`/
      `PROCESSOR_ID`/`LOCATION` are set in `.env` and the code path reaches
      Document AI correctly, but this machine has no Google Application
      Default Credentials configured, so the live call fails with
      `DefaultCredentialsError` (surfaced correctly as a `read_error`, not
      a crash — but real OCR text was never actually produced here).
      Whoever has the GCP service account for this project needs to set
      `GOOGLE_APPLICATION_CREDENTIALS` (or run `gcloud auth application-
      default login`) before `email_512`–`514` will actually OCR.**
- [ ] Test misleading subjects and missing-attachment edge cases end-to-end —
      `email_500`–`520` are the dataset's deliberate edge cases (dropped
      attachments, corrupt PDFs, blank SI fields, packing list mislabelled
      as BL) but nothing has run extraction/comparison against them yet
      (§4 — no full extraction run)

_Mostly done — PDF/DOCX/XLSX reading was already built, and the OCR fallback
is now wired end-to-end in code. The remaining gap is environmental, not
code: this machine has no GCP Application Default Credentials, so
`email_512`–`514` can't be live-verified as actually OCR'd yet (see above)._

## 11. Documentation and cleanup

- [ ] Update `HANDOVER.md`
- [ ] Update the README with setup and execution instructions
- [ ] Document environment variables and LLM requirements
- [ ] Remove stale TODO items
- [ ] Add a complete test command — currently `python -m pytest` from repo
      root runs everything (compare/extract/pipeline suites)
- [ ] Record known limitations and evaluation results

## Suggested implementation order

1. [x] ~~Resolve the `backend/comparison.py` fallback question~~ — done,
       `compare_jsons` implemented and verified live
2. [ ] Share `sample_submission.json` + `loader.py` (🔴 blocking §1/§8)
3. [x] ~~Implement deterministic comparison~~ — done
4. [x] ~~Add comparison tests~~ — done
5. [x] ~~Build `backend/escalate.py`~~ (§6) — done, rules-based, no LLM
       calls, wired into the pipeline
6. [ ] Run extraction over the full inbox — still only ever run in small
       batches (now 3 real attachments cached from this session's live
       checks: `email_004_SI/BL`, `email_507_SI`); `data/extractions.json`
       still needs the other ~247 attachments (§4)
7. [x] ~~Extend `run_pipeline` to include every email (not just
       `comparison_request`) in its output, plus the escalate step~~
       (§1, §7) — done
8. [ ] Generate and evaluate submissions (§8, once #2 is answered)
9. [x] ~~Connect the frontend (§9)~~ — read side done (`backend/db.py`,
       `frontend/src/models/Result.ts`, `frontend/src/lib/results.ts`);
       retry/correction UI still not built, see §9
10. [x] ~~Add OCR for scanned documents~~ (§10) — wired and tested (mocked);
       live end-to-end use blocked on GCP Application Default Credentials
       not being set up on this machine, see §10 above
11. [x] ~~Dedup logic for duplicated attachments~~ (§3) — done
12. [x] ~~Retry and human correction workflows~~ (§6) — library-level
       primitives done in `backend/review.py`; CLI/API surface still
       needs the persisted results store #4/#8 unblocks
13. [x] ~~Classification regression tests + review beyond the labelled
       sample~~ (§2) — done, all offline/zero-cost