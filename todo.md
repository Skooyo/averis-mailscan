# TODO

_Last updated: 2026-09-22, after a full status audit against the actual
codebase. Classification has been run on the full 520-email inbox (not just
5), PDF/XLSX/DOCX reading was already implemented (contrary to what this file
previously said), and the `compare_jsons` ImportError below has been fixed.
Also: `backend/llm.py` no longer uses Groq — it now calls the Vercel AI
Gateway (`AI_GATEWAY_API_KEY`), the same provider the frontend's Gmail-sync
classifier already used, so the whole app is on one key/provider._

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
- [ ] Ensure every `email_id` is included in the final output — **currently
      NOT true**: `run_pipeline`/`process_comparison_requests` only return
      entries for emails classified `comparison_request`; every other
      category is silently absent from the result dict.

## 2. Email classification

- [x] Load inbox records (`ingest.load_inbox`)
- [x] Classify emails into the 5 categories (`classify.classify_all`)
- [x] Run classification across the full inbox — **done**: 520/520 cached in
      `data/classifications.json` (general 151, comparison_request 129,
      new_si_request 125, invoice_query 75, spam 40), 0 below the 0.6
      confidence floor. Confirmed against the labelled sample
      (`tests/labels_sample.json`, 45 emails) via `test_live_gateway_classification`.
- [ ] Add regression tests for representative examples — none yet, only
      mocked unit tests of the dispatcher logic exist (the one live test,
      `test_live_gateway_classification`, checks 3 emails and is skipped
      without an `AI_GATEWAY_API_KEY`)
- [ ] Review classification errors against the problem statement — not done
      beyond the 45-email labelled sample

## 3. Attachment handling

- [x] Resolve attachments using `path` and `text`
- [x] Identify the SI and draft BL for comparison requests —
      `compare_si_vs_bl` auto-detects via `Extraction.doc_type_detected`,
      raises loudly on ambiguity instead of guessing
- [ ] Handle missing, duplicated, or ambiguous attachments — **detected**
      (raises `ValueError`), not yet **handled**: no dedup logic, and a
      raised error still needs to become a proper escalation (§6) rather
      than a bare caught exception
- [ ] Add clear errors for unreadable attachments — `read_error` is
      already captured by `readers.py`/`ingest.py`; still needs wiring
      into escalation once `escalate.py` exists

## 4. Data extraction

- [x] Use `backend/extract.py` for the seven canonical fields
- [x] Capture confidence and evidence (`ExtractedField`)
- [ ] Run extraction across the complete dataset — only 5 sample emails
      run so far (`python -m backend.pipeline . 5`), not the full inbox
- [ ] Save and validate `data/extractions.json` — file is being written
      correctly (confirmed via manual inspection of `email_004`), but not
      validated against the full dataset yet
- [x] Add extraction unit tests — `test_extract.py`, 10 tests passing
- [ ] Escalate missing or low-confidence values instead of guessing —
      **partial**: `flatten_extraction(confidence_threshold=...)` can mask
      a low-confidence value to `None`, but that's not escalation — it
      just makes the field look like an ordinary missing value, with no
      reason recorded and no path to a human. Real fix is §6.

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

- [ ] Add `backend/escalate.py` — **does not exist yet; biggest real gap
      in the pipeline right now**
- [ ] Escalate when:
  - [ ] Attachments are missing
  - [ ] Documents are unreadable
  - [ ] Required fields are missing
  - [ ] Extraction confidence is low
  - [ ] Values are ambiguous
  - [ ] Processing fails — currently `process_comparison_requests` catches
        this as `{"status": "error", "message": str(exc)}`, which needs to
        become a real escalation record, not just a caught exception
- [ ] Include email ID, evidence, extracted values, and escalation reason
- [ ] Support retry and human correction workflows

## 7. End-to-end pipeline

- [x] Implement `inbox → classify → identify attachments → extract → compare`
      (`run_pipeline` in `pipeline.py`)
- [ ] Extend to the full `... → escalate → report` — escalate step missing
      (§6); report currently omits non-comparison_request emails (§1)
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

## 8. Submission and evaluation

- [ ] Generate the required submission JSON — blocked on
      `sample_submission.json` (see 🔴 Blocking)
- [ ] Validate the output schema before submission
- [ ] Submit results through `/submit` or `inbox.submit(...)`
- [ ] Review classification and mismatch errors
- [ ] Iterate using the self-evaluation score

## 9. Frontend and API

- [ ] Add backend/API endpoints
- [ ] Connect the frontend to real backend or MongoDB data
- [ ] Replace mock fields with the seven canonical fields
- [ ] Display:
  - [ ] Email ID
  - [ ] Category
  - [ ] Match/mismatch status
  - [ ] SI value
  - [ ] BL value
  - [ ] Escalation reason
- [ ] Add retry and human-review actions

_Not started — correctly deferred; no point building UI around a pipeline
still missing escalation and full-dataset coverage._

## 10. Advanced document support

- [x] Add PDF support — `backend/readers.py::_read_pdf` (pdfplumber), magic-byte
      validated, tested in `test_readers.py`/`test_convert.py`
- [x] Add Word document support — `_read_docx` (python-docx), paragraphs +
      tables, same tests
- [x] Add table/table-layout handling — `_read_xlsx` (openpyxl) and the
      table-row extraction in `_read_docx` already flatten tables to text
- [ ] Add OCR or vision-based extraction for scanned documents — **not
      started**. `email_512`–`514` are image-only scanned PDFs that hit
      `pdf_no_text_layer`; `OCRApi.py` at repo root is an unwired Document AI
      experiment on one hard-coded file, not integrated into `readers.py`
- [ ] Test misleading subjects and missing-attachment edge cases end-to-end —
      `email_500`–`520` are the dataset's deliberate edge cases (dropped
      attachments, corrupt PDFs, blank SI fields, packing list mislabelled
      as BL) but nothing has run extraction/comparison against them yet
      (§4 — no full extraction run)

_Partially done — PDF/DOCX/XLSX reading was already built (contrary to what
this file previously said); OCR for scanned documents is the real remaining
gap._

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
5. [ ] Build `backend/escalate.py` (§6) — biggest remaining piece of real work
6. [ ] Run extraction over the full inbox — still only ever run in small
       batches; `data/extractions.json` doesn't exist yet (§4)
7. [ ] Extend `run_pipeline` to include every email (not just
       `comparison_request`) in its output, plus the escalate step (§1, §7)
8. [ ] Generate and evaluate submissions (§8, once #2 is answered)
9. [ ] Connect the frontend (§9)
10. [ ] Add OCR for scanned documents (§10) — the rest of §10 is done