"""backend/db.py tests.

All mocked (a fake `collection` object, or a monkeypatched MongoClient) --
no live database or network access required, consistent with how the rest
of tests/ avoids live calls by default (see tests/test_classify.py's
AI_GATEWAY_API_KEY-gated live tests). test_live_upsert_results_roundtrip
below is gated on its own explicit RUN_LIVE_DB_TESTS=1, deliberately NOT on
MONGODB_URI being set -- unlike AI_GATEWAY_API_KEY (which only exists to
authorize spending), a real MONGODB_URI is routinely present in .env just
to run the app at all (frontend dev server, `--write-db`), so gating on it
alone means a plain `pytest tests/` silently writes to and deletes from
whatever Atlas cluster that URI points at. RUN_LIVE_DB_TESTS=1 requires a
separate, deliberate opt-in on top of having a URI configured.
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock

import pytest

from backend import db


# ---------------------------------------------------------------------------
# get_client
# ---------------------------------------------------------------------------

def test_get_client_raises_without_uri(monkeypatch):
    monkeypatch.delenv("MONGODB_URI", raising=False)
    with pytest.raises(RuntimeError, match="MONGODB_URI"):
        db.get_client()


def test_get_client_uses_explicit_uri_over_env(monkeypatch):
    monkeypatch.setenv("MONGODB_URI", "mongodb://from-env")
    created = {}

    class FakeClient:
        def __init__(self, uri):
            created["uri"] = uri

    monkeypatch.setattr(db, "MongoClient", FakeClient)
    client = db.get_client("mongodb://explicit")
    assert created["uri"] == "mongodb://explicit"
    assert isinstance(client, FakeClient)


def test_get_client_falls_back_to_env_uri(monkeypatch):
    monkeypatch.setenv("MONGODB_URI", "mongodb://from-env")
    created = {}
    monkeypatch.setattr(db, "MongoClient", lambda uri: created.setdefault("uri", uri))
    db.get_client()
    assert created["uri"] == "mongodb://from-env"


# ---------------------------------------------------------------------------
# get_results_collection
# ---------------------------------------------------------------------------

def test_get_results_collection_uses_results_name_and_default_db(monkeypatch):
    monkeypatch.setenv("MONGODB_URI", "mongodb://x")
    monkeypatch.delenv("MONGODB_DB", raising=False)

    fake_collection = object()
    fake_db = {db.RESULTS_COLLECTION: fake_collection}
    fake_client = {"jobhunters": fake_db}
    monkeypatch.setattr(db, "MongoClient", lambda uri: fake_client)

    assert db.get_results_collection() is fake_collection


def test_get_results_collection_honors_mongodb_db_env(monkeypatch):
    monkeypatch.setenv("MONGODB_URI", "mongodb://x")
    monkeypatch.setenv("MONGODB_DB", "custom_db")

    fake_collection = object()
    fake_client = {"custom_db": {db.RESULTS_COLLECTION: fake_collection}}
    monkeypatch.setattr(db, "MongoClient", lambda uri: fake_client)

    assert db.get_results_collection() is fake_collection


# ---------------------------------------------------------------------------
# upsert_results
# ---------------------------------------------------------------------------

def test_upsert_results_empty_dict_is_a_noop_and_opens_no_connection(monkeypatch):
    monkeypatch.setattr(db, "MongoClient", MagicMock(side_effect=AssertionError("should not connect")))
    n = db.upsert_results("shared", {})
    assert n == 0


def test_upsert_results_writes_one_upsert_per_email_keyed_on_owner_and_email_id():
    collection = MagicMock()
    collection.bulk_write.return_value = MagicMock(upserted_count=2, modified_count=0)

    results = {
        "email_001": {
            "status": "match",
            "category": "comparison_request",
            "escalation": {"required": False, "reasons": []},
        },
        "email_002": {"status": "skipped", "category": "general", "message": "not a comparison_request"},
    }
    n = db.upsert_results("shared", results, collection=collection)

    assert n == 2
    collection.bulk_write.assert_called_once()
    operations = collection.bulk_write.call_args[0][0]
    assert len(operations) == 2

    by_email = {op._filter["email_id"]: op for op in operations}
    assert set(by_email) == {"email_001", "email_002"}
    for email_id, op in by_email.items():
        assert op._filter == {"owner": "shared", "email_id": email_id}
        assert op._upsert is True
        assert op._doc["$set"]["email_id"] == email_id
        assert op._doc["$set"]["owner"] == "shared"

    assert by_email["email_001"]._doc["$set"]["status"] == "match"
    assert by_email["email_002"]._doc["$set"]["message"] == "not a comparison_request"


def test_upsert_results_stamps_processed_at():
    collection = MagicMock()
    collection.bulk_write.return_value = MagicMock(upserted_count=1, modified_count=0)

    db.upsert_results("shared", {"email_001": {"status": "match"}}, collection=collection)

    op = collection.bulk_write.call_args[0][0][0]
    assert "processed_at" in op._doc["$set"]


def test_upsert_results_uses_unordered_bulk_write_so_one_bad_doc_doesnt_block_the_rest():
    collection = MagicMock()
    collection.bulk_write.return_value = MagicMock(upserted_count=1, modified_count=0)

    db.upsert_results("shared", {"email_001": {"status": "match"}}, collection=collection)

    _, kwargs = collection.bulk_write.call_args
    assert kwargs.get("ordered") is False


def test_upsert_results_returns_upserted_plus_modified_count():
    collection = MagicMock()
    collection.bulk_write.return_value = MagicMock(upserted_count=1, modified_count=3)

    n = db.upsert_results("shared", {"e1": {"status": "match"}, "e2": {"status": "match"}}, collection=collection)

    assert n == 4


def test_upsert_results_with_explicit_collection_never_touches_mongoclient(monkeypatch):
    monkeypatch.setattr(db, "MongoClient", MagicMock(side_effect=AssertionError("should not connect")))
    collection = MagicMock()
    collection.bulk_write.return_value = MagicMock(upserted_count=1, modified_count=0)
    db.upsert_results("shared", {"email_001": {"status": "match"}}, collection=collection)
    collection.bulk_write.assert_called_once()


def test_upsert_results_reshapes_duplicate_attachments_dict_into_kept_dropped_array():
    """backend/pipeline.py::dedupe_attachments produces {kept_key: [dropped_key, ...]}, keyed by
    attachment path (which routinely contains dots) -- a dotted key would break a Mongoose Map, so
    this must land in Mongo as an array of {kept, dropped} subdocuments instead (see
    _reshape_document, frontend/src/models/Result.ts)."""
    collection = MagicMock()
    collection.bulk_write.return_value = MagicMock(upserted_count=1, modified_count=0)

    results = {
        "email_001": {
            "status": "match",
            "duplicate_attachments": {"attachments/email_001_SI.txt": ["attachments/email_001_SI_copy.txt"]},
        },
    }
    db.upsert_results("shared", results, collection=collection)

    doc = collection.bulk_write.call_args[0][0][0]._doc["$set"]
    assert doc["duplicate_attachments"] == [
        {"kept": "attachments/email_001_SI.txt", "dropped": ["attachments/email_001_SI_copy.txt"]}
    ]


def test_upsert_results_unsets_optional_keys_missing_from_the_new_record():
    """A field like `retried` or `details` that was true/present on an earlier write must not
    silently survive a later run whose record no longer carries it (e.g. a rerun that now errors
    out instead of mismatching shouldn't keep showing the old mismatch's `details`)."""
    collection = MagicMock()
    collection.bulk_write.return_value = MagicMock(upserted_count=1, modified_count=0)

    db.upsert_results("shared", {"email_001": {"status": "error", "message": "boom"}}, collection=collection)

    op = collection.bulk_write.call_args[0][0][0]
    assert op._doc["$unset"] == {key: "" for key in db._OPTIONAL_KEYS}
    assert "duplicate_attachments" not in op._doc["$set"]


def test_upsert_results_does_not_unset_optional_keys_present_in_the_new_record():
    collection = MagicMock()
    collection.bulk_write.return_value = MagicMock(upserted_count=1, modified_count=0)

    db.upsert_results(
        "shared",
        {"email_001": {"status": "mismatch", "incorrect_or_missing": ["shipper"], "details": {}, "retried": True}},
        collection=collection,
    )

    op = collection.bulk_write.call_args[0][0][0]
    assert op._doc["$unset"] == {"duplicate_attachments": "", "corrections": ""}
    assert op._doc["$set"]["retried"] is True


# ---------------------------------------------------------------------------
# Live roundtrip -- writes to and deletes from a real MongoDB cluster, so
# this needs BOTH a MONGODB_URI and an explicit RUN_LIVE_DB_TESTS=1 opt-in
# (see the module docstring for why MONGODB_URI alone isn't enough).
# ---------------------------------------------------------------------------

@pytest.mark.skipif(
    not (os.environ.get("MONGODB_URI") and os.environ.get("RUN_LIVE_DB_TESTS")),
    reason="needs MONGODB_URI and RUN_LIVE_DB_TESTS=1 (writes to a real cluster)",
)
def test_live_upsert_results_roundtrip():
    owner = "__backend_db_test__"
    n = db.upsert_results(owner, {"email_test": {"status": "skipped", "category": None, "message": "db.py live test"}})
    assert n == 1

    collection = db.get_results_collection()
    try:
        doc = collection.find_one({"owner": owner, "email_id": "email_test"})
        assert doc is not None
        assert doc["status"] == "skipped"
    finally:
        collection.delete_many({"owner": owner})
