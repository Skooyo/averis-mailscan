"""Classification: Email -> Classification (category, confidence, reasoning).

Category is decided by what the sender is ASKING FOR in the body. Attachment
presence/readability is deliberately not a category signal — that is the
escalation stage's job.

Emails are classified in batches (default 10 per call) to stay inside Groq's
free-tier token budget: the system prompt is paid once per batch, and bodies
are stripped of banners/signatures before rendering.
"""

import asyncio
import json
import re
from pathlib import Path

from .llm import astructured_completion, structured_completion
from .models import Classification, ClassificationBatch, Email

CACHE_PATH = Path(__file__).resolve().parent.parent / "data" / "classifications.json"
BODY_LIMIT = 1200
BATCH_SIZE = 10

SYSTEM_PROMPT = """You classify emails in a shipping-documentation team's inbox. Decide by what the sender is ASKING FOR in the BODY. Subject lines in this inbox are unreliable thread titles — never let them override the body. Missing, dropped or broken attachments do NOT change the category.

Categories:
1. comparison_request — asks us to check / compare / verify a Shipping Instruction (SI) against a draft Bill of Lading (BL) and confirm. E.g. "Attached are the SI and draft BL ... please check and confirm", "Kindly verify the BL matches the SI", "check the draft BL against the SI ... revert with any discrepancy", "Please compare the SI and draft BL". Still this category if the BL is missing, attachments were dropped, a file won't open, copies are scanned, SI fields are blank, or the second attachment is a packing list / invoice / certificate instead of the BL.
2. new_si_request — sender supplies shipment details so a Shipping Instruction can be prepared, or asks for an SI to be raised. E.g. "Please find Shipping instruction for <ref>" followed by inline POL / POD / Shipper / Consignee / Notify blocks — even if it closes with "revert with draft BL once available".
3. invoice_query — money owed or billed: invoice questions, THC / local charge breakdowns, D&D / detention charges to confirm, missing GR blocking billing, cancel invoice / reverse PGI, freight totals.
4. general — other legitimate work email: "please send the draft BL for checking" (asks us to SEND a document, not compare two), outstanding BL lists, reminders to submit SI & AED, berthing reports, loading update summaries, automated RPA notices ("billing process completed, no action required"), greetings, office notices.
5. spam — marketing, prizes, phishing, account verification scams, crypto / investment offers, fake parcel fees, "bank officer" proposals.

Output one result per email, keeping each email_id exactly as given. confidence 0.9+ when a typical phrase matches; below 0.6 only when two categories are genuinely plausible. reasoning: one short sentence quoting the decisive phrase."""

_BANNER_RE = re.compile(r"^WARNING: This email originated outside.*?\n\n", re.S)
_SIGNOFF_RE = re.compile(r"\n\s*(Best Regards|Best regards|Kind regards|Regards|Thank you,|Thanks,|Warm regards|Best,|-- RPA Bot)\b.*", re.S)


def clean_body(body: str) -> str:
    """Drop the external-sender banner and the signature block; cap length."""
    body = _BANNER_RE.sub("", body)
    body = _SIGNOFF_RE.sub("", body).strip()
    if len(body) > BODY_LIMIT:
        body = body[:BODY_LIMIT] + "\n[...truncated]"
    return body


def render_email(email: Email) -> str:
    si = any(a.doc_type == "SI" for a in email.attachments)
    bl = any(a.doc_type == "BL" for a in email.attachments)
    unreadable = sum(1 for a in email.attachments if a.read_error)
    return (
        f"email_id: {email.email_id}\n"
        f"From: {email.sender}\n"
        f"Subject: {email.subject}\n"
        f"Attachments: {len(email.attachments)} (SI: {'yes' if si else 'no'}, BL: {'yes' if bl else 'no'}, unreadable: {unreadable})\n"
        f"Body:\n{clean_body(email.body)}"
    )


def render_batch(emails: list[Email]) -> str:
    parts = [f"Classify these {len(emails)} emails.\n"]
    parts += [f"=== EMAIL {i + 1} ===\n{render_email(e)}" for i, e in enumerate(emails)]
    return "\n\n".join(parts)


def _unpack(batch: ClassificationBatch, emails: list[Email]) -> dict[str, Classification]:
    wanted = {e.email_id for e in emails}
    out: dict[str, Classification] = {}
    for item in batch.results:
        if item.email_id in wanted:
            out[item.email_id] = Classification(
                category=item.category, confidence=item.confidence, reasoning=item.reasoning
            )
    return out


def classify_email(email: Email) -> Classification:
    batch = structured_completion(SYSTEM_PROMPT, render_batch([email]), ClassificationBatch)
    result = _unpack(batch, [email])
    if email.email_id not in result:
        raise ValueError(f"model returned no result for {email.email_id}")
    return result[email.email_id]


async def aclassify_batch(emails: list[Email]) -> dict[str, Classification]:
    batch = await astructured_completion(SYSTEM_PROMPT, render_batch(emails), ClassificationBatch)
    result = _unpack(batch, emails)
    # Anything the model skipped or mislabelled gets one individual retry.
    for e in emails:
        if e.email_id not in result:
            single = await astructured_completion(SYSTEM_PROMPT, render_batch([e]), ClassificationBatch)
            result.update(_unpack(single, [e]))
    return result


# --- cache ------------------------------------------------------------------

def load_cache(path: Path = CACHE_PATH) -> dict[str, Classification]:
    if not path.is_file():
        return {}
    raw = json.loads(path.read_text())
    return {k: Classification.model_validate(v) for k, v in raw.items()}


def save_cache(cache: dict[str, Classification], path: Path = CACHE_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ordered = {k: cache[k].model_dump() for k in sorted(cache)}
    path.write_text(json.dumps(ordered, indent=2))


async def classify_all(
    emails: list[Email],
    concurrency: int = 1,
    force: bool = False,
    batch_size: int = BATCH_SIZE,
    cache_path: Path = CACHE_PATH,
    progress: bool = False,
) -> dict[str, Classification]:
    """Classify every email in batches, skipping ids already cached unless force=True.
    Cache is written after every batch so an interrupted run resumes where it stopped."""
    cache = {} if force else load_cache(cache_path)
    todo = [e for e in emails if e.email_id not in cache]
    batches = [todo[i : i + batch_size] for i in range(0, len(todo), batch_size)]
    sem = asyncio.Semaphore(concurrency)
    lock = asyncio.Lock()
    done = 0

    async def run(batch: list[Email]) -> None:
        nonlocal done
        async with sem:
            result = await aclassify_batch(batch)
        async with lock:
            cache.update(result)
            save_cache(cache, cache_path)
            done += len(result)
            if progress:
                print(f"  {done}/{len(todo)} classified", flush=True)

    await asyncio.gather(*(run(b) for b in batches))
    return cache
