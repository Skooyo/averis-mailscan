import json
import os
import re
from pathlib import Path

import pytest

from backend import classify as clf
from backend.ingest import load_email
from backend.llm import strict_schema
from backend.models import ClassificationBatch, ClassificationItem, Email

ROOT = Path(__file__).resolve().parent.parent


def email(n: int) -> Email:
    return load_email(ROOT / "inbox" / f"email_{n:03}.json", ROOT)


def test_render_email_has_metadata_but_no_attachment_text():
    e = email(1)
    rendered = clf.render_email(e)
    assert e.sender in rendered and e.subject in rendered
    assert "SI: yes, BL: yes" in rendered
    assert "SHIPPING INSTRUCTION" not in rendered  # attachment body must not leak in


def test_render_email_truncates_long_body():
    e = email(2).model_copy(update={"body": "x" * 10_000})
    assert "[...truncated]" in clf.render_email(e)


def test_clean_body_strips_banner_and_signature():
    body = email(9).body
    assert body.startswith("WARNING")
    cleaned = clf.clean_body(body)
    assert not cleaned.startswith("WARNING")
    assert "Best Regards" not in cleaned and "Kindly verify" in cleaned


def test_strict_schema_is_structured_output_compatible():
    s = strict_schema(ClassificationBatch)
    assert s["additionalProperties"] is False
    item = s["$defs"]["ClassificationItem"]
    assert item["additionalProperties"] is False
    assert set(item["required"]) == {"email_id", "category", "confidence", "reasoning"}


def test_classify_email_uses_structured_completion(monkeypatch):
    seen = {}

    def fake(system, user, schema):
        seen.update(system=system, user=user, schema=schema)
        return ClassificationBatch(results=[
            ClassificationItem(email_id="email_072", category="spam", confidence=0.95, reasoning="prize scam")
        ])

    monkeypatch.setattr(clf, "structured_completion", fake)
    result = clf.classify_email(email(72))
    assert result.category == "spam"
    assert seen["schema"] is ClassificationBatch
    assert "CONGRATULATIONS" in seen["user"] and "email_id: email_072" in seen["user"]


@pytest.mark.asyncio
async def test_classify_all_caches_and_skips_done(monkeypatch, tmp_path):
    calls = []

    async def fake(system, user, schema):
        ids = re.findall(r"email_id: (email_\d+)", user)
        calls.append(ids)
        return ClassificationBatch(results=[
            ClassificationItem(email_id=i, category="general", confidence=0.8, reasoning="stub") for i in ids
        ])

    monkeypatch.setattr(clf, "astructured_completion", fake)
    cache_path = tmp_path / "c.json"
    emails = [email(1), email(2)]

    first = await clf.classify_all(emails, cache_path=cache_path, batch_size=10)
    assert set(first) == {"email_001", "email_002"} and calls == [["email_001", "email_002"]]
    assert set(json.loads(cache_path.read_text())) == {"email_001", "email_002"}

    second = await clf.classify_all(emails + [email(3)], cache_path=cache_path, batch_size=10)
    assert calls[-1] == ["email_003"] and "email_003" in second  # only the new one was sent


@pytest.mark.asyncio
async def test_batch_retries_ids_the_model_skipped(monkeypatch):
    calls = []

    async def fake(system, user, schema):
        ids = re.findall(r"email_id: (email_\d+)", user)
        calls.append(ids)
        keep = ids[:-1] if len(ids) > 1 else ids  # drop the last one on the batch call
        return ClassificationBatch(results=[
            ClassificationItem(email_id=i, category="spam", confidence=0.9, reasoning="s") for i in keep
        ])

    monkeypatch.setattr(clf, "astructured_completion", fake)
    result = await clf.aclassify_batch([email(1), email(2)])
    assert set(result) == {"email_001", "email_002"}
    assert calls == [["email_001", "email_002"], ["email_002"]]


def test_labels_sample_is_well_formed():
    labels = json.loads((ROOT / "tests" / "labels_sample.json").read_text())
    valid = {"comparison_request", "new_si_request", "invoice_query", "general", "spam"}
    assert set(labels.values()) == valid  # every category represented
    for eid in labels:
        assert (ROOT / "inbox" / f"{eid}.json").is_file()


@pytest.mark.skipif(not os.environ.get("AI_GATEWAY_API_KEY"), reason="needs AI_GATEWAY_API_KEY")
@pytest.mark.parametrize("n,expected", [(1, "comparison_request"), (2, "invoice_query"), (72, "spam")])
def test_live_gateway_classification(n, expected):
    result = clf.classify_email(email(n))
    assert result.category == expected, result
    assert result.confidence >= 0.6


# ---------------------------------------------------------------------------
# Regression tests -- read the already-computed data/classifications.json
# cache, never call the LLM. These lock in known-correct behavior so a
# future prompt/model change can't silently regress it without a test
# failing; `cli eval-classify` did the same scoring by hand, but only as a
# manually-run CLI report, not as an automated, always-run assertion.
# ---------------------------------------------------------------------------

def _cache_or_skip() -> dict:
    cache = clf.load_cache()
    if not cache:
        pytest.skip("data/classifications.json not present -- run `python -m backend.cli classify` first")
    return cache


def test_full_labelled_sample_matches_cached_classification():
    """Runs the same check as `cli eval-classify`, but as an assertion that
    fails the build instead of a report a human has to remember to read.
    """
    labels = json.loads((ROOT / "tests" / "labels_sample.json").read_text())
    cache = _cache_or_skip()

    missing = [eid for eid in labels if eid not in cache]
    assert not missing, f"{len(missing)} labelled emails not yet classified: {missing}"

    misses = {
        eid: {"expected": expected, "got": cache[eid].category}
        for eid, expected in labels.items()
        if cache[eid].category != expected
    }
    assert not misses, f"classification regressed on: {misses}"


@pytest.mark.parametrize(
    "email_id,expected,why",
    [
        (
            "email_021",
            "general",
            "subjects are shuffled relative to bodies -- category must follow the "
            "body (an operational SI-submission reminder), not the unrelated subject",
        ),
        (
            "email_117",
            "general",
            "an automated 'billing process completed, no action required' RPA "
            "notice -- must not be misread as an invoice_query",
        ),
        (
            "email_003",
            "general",
            "'assist to send draft BL' with no attachments asks us to SEND a "
            "document, not compare two -- general, not comparison_request",
        ),
        (
            "email_007",
            "new_si_request",
            "inline SI details in the body, even though it closes with "
            "'revert with draft BL once available'",
        ),
        (
            "email_072",
            "spam",
            "prize-claim scam from a known spam domain",
        ),
        (
            "email_507",
            "comparison_request",
            "asks to compare SI vs draft BL even though the BL is missing -- "
            "attachment presence/readability is not a category signal",
        ),
    ],
)
def test_representative_classification_examples(email_id, expected, why):
    """Each case is a specific classification gotcha already found and
    written up in HANDOVER.md's "Dataset findings" section. All six are
    also in tests/labels_sample.json (so test_full_labelled_sample_* above
    already covers them); this test exists to name each one individually
    with *why* it's tricky, so a future miss is immediately legible instead
    of just one more entry in a diff of 45.
    """
    cache = _cache_or_skip()
    assert email_id in cache, f"{email_id} not in the classification cache"
    result = cache[email_id]
    assert result.category == expected, (
        f"{email_id}: expected {expected!r}, got {result.category!r} ({why}) -- "
        f"model's reasoning: {result.reasoning}"
    )


def test_no_attachment_assist_send_draft_emails_are_classified_general():
    """~90 emails ask us to SEND a document ('assist to send the draft BL
    for X for checking') with no attachments -- these must land in
    general, not comparison_request, since asking us to send isn't asking
    us to compare two. Checks every matching email in the inbox (not just
    the 45-email labelled sample) against the real cache.
    """
    cache = _cache_or_skip()
    matches = []
    for path in sorted((ROOT / "inbox").glob("email_*.json")):
        raw = json.loads(path.read_text(encoding="utf-8"))
        if raw.get("attachments"):
            continue
        if re.search(r"assist to send.*draft bl", raw.get("body", ""), re.I):
            matches.append(raw["email_id"])

    assert len(matches) >= 50, f"expected this pattern to be common; only found {len(matches)}"
    misclassified = {
        eid: cache[eid].category for eid in matches if eid in cache and cache[eid].category != "general"
    }
    assert not misclassified, f"expected 'general' for all, got: {misclassified}"


def test_inline_si_request_emails_are_classified_new_si_request():
    """~70 emails write SI details inline in the body ('Please find
    Shipping instruction for ... POL/POD/Shipper/Consignee') -- must land
    in new_si_request even when they close with 'revert with draft BL once
    available'. Checks every matching email in the inbox against the cache.
    """
    cache = _cache_or_skip()
    matches = []
    for path in sorted((ROOT / "inbox").glob("email_*.json")):
        raw = json.loads(path.read_text(encoding="utf-8"))
        body = raw.get("body", "")
        if re.search(r"shipping instruction", body, re.I) and re.search(r"port of loading|pol[:/]", body, re.I):
            matches.append(raw["email_id"])

    assert len(matches) >= 40, f"expected this pattern to be common; only found {len(matches)}"
    misclassified = {
        eid: cache[eid].category
        for eid in matches
        if eid in cache and cache[eid].category != "new_si_request"
    }
    assert not misclassified, f"expected 'new_si_request' for all, got: {misclassified}"


def test_rpa_billing_no_action_notices_are_classified_general():
    """Automated 'billing process completed, no action required' RPA
    notices must land in general, not invoice_query."""
    cache = _cache_or_skip()
    matches = []
    for path in sorted((ROOT / "inbox").glob("email_*.json")):
        raw = json.loads(path.read_text(encoding="utf-8"))
        body = raw.get("body", "")
        if re.search(r"no action required", body, re.I) and re.search(r"billing", body, re.I):
            matches.append(raw["email_id"])

    assert len(matches) >= 5, f"expected several of these; only found {len(matches)}"
    misclassified = {
        eid: cache[eid].category for eid in matches if eid in cache and cache[eid].category != "general"
    }
    assert not misclassified, f"expected 'general' for all, got: {misclassified}"


def test_edge_case_emails_500_to_520_land_in_documented_categories():
    """email_500-520 are the dataset's deliberate edge cases (HANDOVER.md's
    Dataset findings): packing lists mislabelled _BL, dropped attachments,
    missing/corrupt BLs, scanned no-text-layer PDFs, and blank SI fields.
    Every one of those is still a request to check an SI against a draft
    BL -- attachment presence/readability isn't a category signal -- so
    all of 501-520 must classify as comparison_request; only 500 (an RPA
    billing notice) is invoice_query. Verified against the real cache
    before writing this test (all 21 are currently correct, 0.92-0.99
    confidence); this locks that in against a future reclassify run.
    """
    cache = _cache_or_skip()
    expected = {f"email_{n}": "comparison_request" for n in range(501, 521)}
    expected["email_500"] = "invoice_query"

    misclassified = {
        eid: {"expected": want, "got": cache[eid].category}
        for eid, want in expected.items()
        if eid in cache and cache[eid].category != want
    }
    assert not misclassified, f"edge-case regressions: {misclassified}"
