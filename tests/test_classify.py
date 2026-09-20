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


def test_strict_schema_is_groq_compatible():
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


@pytest.mark.skipif(not os.environ.get("GROQ_API_KEY"), reason="needs GROQ_API_KEY")
@pytest.mark.parametrize("n,expected", [(1, "comparison_request"), (2, "invoice_query"), (72, "spam")])
def test_live_groq_classification(n, expected):
    result = clf.classify_email(email(n))
    assert result.category == expected, result
    assert result.confidence >= 0.6
