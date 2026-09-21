# Averis Hackathon — Implementation Status & Next Steps

_Last updated: 2026-09-21. Detailed module docs, setup and gotchas live in
`HANDOVER.md` at the repo root; this file is the higher-level plan._

## Context
The team's intended data flow is:

```
ingestion + classification -> extraction + db schema -> comparison json of SI and BL
  -> output pattern matching (case scenarios) => stream to FE
```

An extra **attachment → text conversion** step was inserted between ingestion
and classification so that every downstream stage works on plain text
regardless of the original file type (txt / pdf / xlsx / docx).

## Stage-by-stage status

| Stage | Status | Where | Notes |
|---|---|---|---|
| 0. Skeleton | **done** | `requirements.txt`, `pyproject.toml`, `.gitignore` | `.gitignore` now covers `token.json`, `credentials.json`, `.env`, `output/`. `GmailAPI.py` / `OCRApi.py` still sit at repo root as side experiments — not wired in. |
| 1a. Ingestion | **done** | `backend/ingest.py`, `backend/models.py` | Reads `inbox/*.json` (520 emails, 126 with attachments) into pydantic `Email` models and resolves attachment text from the converted-text store. |
| 1b. Attachment → text | **done** | `backend/readers.py`, `backend/convert.py` | 250 attachments → `output/converted_text/`. 242 OK (192 txt, 22 xlsx, 20 pdf, 8 docx). 8 fail: 6 image-only PDFs (`pdf_no_text_layer`), 2 corrupt PDFs. Failures are recorded as `read_error`, never raised. |
| 1c. Classification | **done** | `backend/classify.py`, `backend/llm.py`, `backend/cli.py` | Groq (`llama-3.3-70b-versatile`), strict JSON schema, 10 emails/call, retry/backoff for 429s + schema-validation 400s. 520/520 cached in `data/classifications.json`; 45/45 on the hand-labelled sample. Counts: general 151, comparison_request 129, new_si_request 125, invoice_query 75, spam 40. |
| 2a. Extraction | **not started** | `backend/extract.py` (planned) | Design agreed — see below. |
| 2b. DB schema | **not started** | — | Everything is pydantic + JSON files for now. Deferred until the pipeline is end-to-end. |
| 3. Comparison JSON | **not started** | `backend/compare.py` (planned) | Design agreed — see below. |
| 4. Escalation / case scenarios | **not started** | `backend/escalate.py` (planned) | |
| 4b. Output JSON + self-eval | **not started** | `backend/submission.py` (planned) | `loader.py`, `sample_submission.json`, docker self-eval server **still need to be copied in** from the hackathon ZIP. |
| 5. API + FE + deploy | **not started** | — | |

Tests: `pytest tests/` → 28 tests (25 offline, 3 live Groq tests that skip
without `GROQ_API_KEY`).

**Overall: ~35% — the first three stages are done and exercised on the full
dataset; nothing from extraction onward exists yet.**

## Extraction + comparison design (agreed, not yet built)

### The 7 canonical fields
Both the SI and the BL are extracted into the **same** schema so that
comparison is a like-for-like diff:

| Canonical key | Type | Label variants seen / expected |
|---|---|---|
| `shipper` | str | Shipper, Shipper/Exporter, Consignor |
| `consignee` | str | Consignee, Consigned To |
| `notify_party` | str | Notify Party, Notify, Notify Address |
| `port_of_loading` | str | Port of Loading, POL, Load Port, Loading Port |
| `port_of_discharge` | str | Port of Discharge, POD, Discharge Port, Destination Port |
| `container_count` | int | Container Count, No. of Containers, "3 x 40HC" |
| `gross_weight_kg` | float | Gross Weight, G.W., Cargo Weight (kg / t / MT / lbs) |

Label normalisation happens **at extraction time**, not at comparison time:
the LLM is told the canonical keys and the known variants and must map any
equivalent label onto the canonical key. `compare.py` therefore only ever sees
two identically-shaped objects and never touches raw labels. Do not assume the
SI and BL use the same wording for a field — they deliberately don't.

### `backend/extract.py`
- One `llm.structured_completion` call per document (SI, then BL), strict
  JSON schema keyed by the 7 canonical names.
- Each field returns `{value | null, confidence, evidence}` where `evidence`
  is the verbatim source line — used for the side-by-side report and for
  human review.
- `null` + reason when a field is genuinely absent; **never guess**.
- Also returns `doc_type_detected` (`SI | BL | packing_list | other`) so that
  emails 501–505 (packing list mislabelled as BL) are caught before comparison.
- Cache results in `data/extractions.json` keyed by attachment path, same
  pattern as classification, so re-runs are cheap under Groq's free-tier
  limits.
- Only runs for `comparison_request` emails (129) that have readable SI + BL
  text; everything else is routed straight to escalation or skipped.

### `backend/compare.py` — pure Python, no LLM
Value normalisation on top of label normalisation, because the same field is
also *formatted* differently across the two docs:
- **Strings** (parties, ports): casefold, collapse whitespace and punctuation,
  strip company suffixes (`Ltd`, `Pte Ltd`, `Co.`, `Inc`) before equality.
  Raw text is preserved for the report.
- **`container_count`**: parse to int (`"3 x 40HC"` → 3).
- **`gross_weight_kg`**: parse to float, convert units (`t` / `MT` → ×1000,
  `lbs` → ×0.4536), compare with a small relative tolerance.
- Output per field: `{field, si_value, bl_value, match: bool}`; report
  mismatches as `SI: X / BL: Y`; `"No mismatch detected."` when all 7 match.

### `backend/escalate.py`
Rules producing `status: ok | mismatch | needs_review` plus a human-readable
`reason`, triggered by:
- classification confidence < 0.7
- `comparison_request` with a missing SI or BL attachment
- any `read_error` on either attachment (covers the 8 failing PDFs)
- `doc_type_detected` ≠ expected (501–505)
- any field `null` or confidence below threshold on either side

Escalation is a required capability, not a fallback — it must produce useful
context for a human, never a silent failure.

## Next steps (in order)

1. **Copy in the self-eval bundle** (`loader.py`, `sample_submission.json`,
   docker files) so the output contract is known before writing
   `submission.py`.
2. **`backend/extract.py`** per the design above; run on the 129
   comparison-request emails; spot-check ~10 against the raw text.
3. **`backend/compare.py`** + tests for the normalisation helpers.
4. **`backend/escalate.py`** + tests for each rule.
5. **`backend/submission.py`**: fold classification + comparison + escalation
   into the `sample_submission.json` shape for **all 520 emails** (spam
   included), `POST /submit`, record the score, iterate.
6. **FastAPI + SSE + Next.js + deploy** — deploy a hello-world as soon as
   `main.py` exists; the rubric penalises last-minute deploys.
7. **Postgres** persistence of emails / attachments / classifications / results.
8. **OCR fallback** for the 6 image-only PDFs (512–514) via Document AI
   (`OCRApi.py` is the starting point).

## Verification
- Extraction: run on the 129 comparison requests; every doc yields 7 keys;
  `null` rate per field logged; 501–505 flagged as `packing_list`.
- Comparison: unit tests for each normaliser (case, suffixes, "3 x 40HC",
  tonnes → kg); known-good pairs return "No mismatch detected.".
- Escalation: the 8 unreadable PDFs and 501–505 all land in `needs_review`
  with a reason.
- Submission: `POST /submit` against the local self-eval server; score
  recorded in `HANDOVER.md` after each run.
- Stage 5: `curl` the SSE endpoint while `/process` runs; FE shows results
  appearing live; public URL loads.
