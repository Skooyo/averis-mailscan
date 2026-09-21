# Averis x Monash Hackathon 2026 — Shipping Document Verification

## Problem
An inbox mixes document-comparison requests, new SI requests, invoice queries,
general messages, and spam. For comparison requests, compare a **Shipping
Instruction (SI)** (source of truth) against a draft **Bill of Lading (BL)**
and flag mismatches.

## Required capabilities (in order, each gates the next)
1. **Classify** every email into: comparison request / new SI request /
   invoice query / general / spam.
2. **Extract** (comparison requests only) 7 fields from SI + BL text, handling
   label variants (e.g. "Port of Loading" vs "Load Port"):
   shipper, consignee, notify party, port of loading, port of discharge,
   container count, gross weight (kg).
3. **Compare** values, report mismatches side by side (SI: X / BL: Y). If all
   7 match: "No mismatch detected."
4. **Escalate**: when uncertain (unreadable doc, missing field, low
   confidence), flag for human review with context — never guess or fail
   silently. This is an explicit required capability, not optional.

## Output contract
One JSON object keyed by `email_id`, matching `sample_submission.json`.
**Every** email in the dataset needs an entry (including spam — just tagged
`"spam"` with no comparison fields). Test against the self-eval endpoint
(`POST /submit` or `inbox.submit(...)`) frequently while building.

## Data access
`loader.py` provides `Inbox("data")` or `Inbox("http://localhost:8080")`
(via `docker compose up --build`). Iterate emails, `inbox.read_text(path)`
for attachment text.

## Tech stack
- **Backend**: Python + FastAPI (pairs with `loader.py`)
- **Classification & extraction**: LLM API with structured/JSON output —
  not regex-only (breaks on label variants by design)
- **DB**: MongoDB (mongoose, `frontend/src/models/`) — store every email +
  result, spam included, for auditability. Local: `docker compose up -d`
  (`averis-mongo` on :27017); prod: MongoDB Atlas via `MONGODB_URI`
- **Frontend**: React/Next.js on Vercel
- **Deploy**: MongoDB Atlas (DB) + Vercel (frontend) — **deploy a
  skeleton on day 1**, iterate on a live public URL. Never leave deployment
  to the last 2 hours.
- **Advanced stage only** (after basic works): `PyMuPDF` (PDF),
  `python-docx` (Word), `pytesseract` or vision-LLM (scanned docs). Avoid
  ColPali — it's a retrieval tool for finding documents, not extracting
  fields from a known document.
- Secrets via cloud env vars, never committed. `.env` in `.gitignore`,
  commit `.env.example` only.

## Scoring priorities (what actually moves the score)
100 pts: Technical 70 (End-to-End Functionality 25 | Architecture 15 |
Tech Integration 15 | Engineering Quality/Robustness 15) + Product & Impact
30. **The single biggest lever is a reliable end-to-end flow** — prioritize
a working core pipeline over polishing any one stage (e.g. don't over-invest
in classifier prompt engineering at the expense of extraction accuracy or
escalation handling).

## Mandatory submission deliverables
- Public GitHub repo + README with setup instructions
- Live deployed prototype link, functional for the entire judging period
- Slide deck / documentation link
- Demo video, **max 5 minutes** (−1 mark per 30s over), covering: intro,
  problem, tech stack, live demo, impact

## Team roles
1. Classification lead
2. Extraction engineer
3. Comparison + escalation engineer
4. Infra/DevOps (day-1 deploy owner)
5. Frontend + submission lead (README, video, slides)

Claude has also created a plan, check ```clanker-food/claudes-plan.md```