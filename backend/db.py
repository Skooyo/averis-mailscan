"""backend/db.py

Pymongo client for writing pipeline results into the same MongoDB Atlas
cluster the Next.js frontend reads from (frontend/src/lib/mongodb.ts) --
the sole integration boundary between the two runtimes. The pipeline is a
batch job (real wall-clock cost from LLM rate limits) that runs out-of-band
and writes here; the frontend, deployed on Vercel, only ever reads. See
HANDOVER.md's "Deployment decision" for why the pipeline itself never runs
on Vercel.

Sync pymongo, not motor/async: every pipeline entry point is already a sync
function launched via asyncio.run() (backend/pipeline.py::main), so there's
no running event loop for an async driver to share.

MONGODB_URI / MONGODB_DB are the exact env var names frontend/.env.example
documents -- reused verbatim here (see .env.example at the repo root) so
both runtimes point at the same cluster/database without a naming mismatch.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from pymongo import MongoClient, UpdateOne
from pymongo.collection import Collection

# Must match the explicit `collection: "results"` set on the Mongoose schema
# in frontend/src/models/Result.ts. Mongoose's default pluralization would
# likely also land on "results", but that's a guess this module doesn't
# rely on -- both sides name it explicitly so they can't silently drift.
RESULTS_COLLECTION = "results"

# Keys that are only sometimes present in a pipeline result record (which
# ones depend on status/history -- see _reshape_document's docstring). Any
# key in here NOT present in this run's record is explicitly $unset, not
# just left alone -- otherwise a value from an earlier run (e.g. a stale
# `retried: true`, or a mismatch's `details` surviving into a rerun that
# now errors out) would sit on the document forever, since $set only ever
# touches the keys it's given.
_OPTIONAL_KEYS = ("incorrect_or_missing", "details", "duplicate_attachments", "corrections", "retried")


def get_client(uri: Optional[str] = None) -> MongoClient:
    """A new MongoClient for `uri` (or MONGODB_URI). Raises RuntimeError if
    neither is set, matching the failure message style of
    frontend/src/lib/mongodb.ts::connectDB().

    Not cached at module level: the pipeline is a one-shot batch run, not a
    long-lived server, so there's no hot-reload connection churn to guard
    against (unlike the frontend's connectDB, which does need that cache).
    """
    uri = uri or os.environ.get("MONGODB_URI")
    if not uri:
        raise RuntimeError("MONGODB_URI is not set - copy .env.example to .env and fill it in")
    return MongoClient(uri)


def get_results_collection(uri: Optional[str] = None, db_name: Optional[str] = None) -> Collection:
    client = get_client(uri)
    db_name = db_name or os.environ.get("MONGODB_DB", "jobhunters")
    return client[db_name][RESULTS_COLLECTION]


def get_result(
    owner: str,
    email_id: str,
    *,
    collection: Optional[Collection] = None,
    uri: Optional[str] = None,
    db_name: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Fetch one Result document by its (owner, email_id) key, or None if it
    doesn't exist yet. The read counterpart to upsert_results -- previously
    missing entirely, which is what blocked backend/review.py's retry/
    correction primitives from having any CLI/API surface (they need to look
    up an email's current state before mutating it).

    `collection` lets a caller (or a test) supply the collection directly,
    same seam upsert_results uses to avoid a live database in tests.
    """
    owns_client = collection is None
    client: Optional[MongoClient] = None
    if collection is None:
        client = get_client(uri)
        collection = client[db_name or os.environ.get("MONGODB_DB", "jobhunters")][RESULTS_COLLECTION]

    try:
        return collection.find_one({"owner": owner, "email_id": email_id})
    finally:
        if owns_client and client is not None:
            client.close()


def _load_existing_corrections(
    collection: Collection, owner: str, email_ids: Any
) -> Dict[str, list]:
    """Fetch `corrections` already recorded against these (owner, email_id)
    documents, keyed by email_id -- only for ids that actually have at least
    one correction, so a plain pipeline rerun that never touches a corrected
    email stays a single cheap query with an empty result.

    This exists so upsert_results can re-apply a human's earlier correction
    on top of a freshly (re)computed record instead of silently overwriting
    it -- see upsert_results' docstring for the failure this prevents.
    """
    ids = list(email_ids)
    if not ids:
        return {}
    from .review import Correction  # local import: keeps corrections-replay logic in review.py, not duplicated here

    cursor = collection.find(
        {"owner": owner, "email_id": {"$in": ids}, "corrections": {"$exists": True, "$ne": []}},
        {"email_id": 1, "corrections": 1},
    )
    out: Dict[str, list] = {}
    for doc in cursor:
        raw = doc.get("corrections") or []
        if raw:
            out[doc["email_id"]] = [Correction.model_validate(c) for c in raw]
    return out


def _reshape_document(record: Dict[str, Any]) -> Dict[str, Any]:
    """Adapt one pipeline result record to the shape actually written to Mongo.

    `duplicate_attachments` comes out of backend/pipeline.py::dedupe_attachments
    as {kept_key: [dropped_key, ...]} -- a dict keyed by attachment *path*
    (backend/extract.py::_attachment_key), which routinely contains dots
    (e.g. "attachments/email_001_SI.txt"). A dotted key in a Mongoose Map
    throws on hydration and needs Mongo >=5.0 even at the raw driver level,
    so frontend/src/models/Result.ts does NOT store this as a Map -- it's an
    array of {kept, dropped} subdocuments instead. Reshape here, once, so
    every write already matches that schema.
    """
    doc = dict(record)
    duplicates = doc.get("duplicate_attachments")
    if isinstance(duplicates, dict):
        doc["duplicate_attachments"] = [{"kept": kept, "dropped": dropped} for kept, dropped in duplicates.items()]
    return doc


def upsert_results(
    owner: str,
    results: Dict[str, Dict[str, Any]],
    *,
    collection: Optional[Collection] = None,
    uri: Optional[str] = None,
    db_name: Optional[str] = None,
) -> int:
    """Upsert one Mongo document per email_id into the `results` collection,
    keyed on (owner, email_id) -- the same compound key
    frontend/src/models/Result.ts uniquely indexes on, so re-running the
    pipeline overwrites the same documents instead of accumulating
    duplicates.

    Each document is `results[email_id]` (reshaped by _reshape_document --
    see its docstring for `duplicate_attachments`) -- whatever
    process_comparison_requests/annotate_with_escalation put there: status,
    category, message, incorrect_or_missing, details,
    duplicate_attachments, escalation, and corrections/retried if a human
    action already touched it -- plus owner/email_id (the join key) and
    processed_at (this call's own timestamp -- distinct from whatever
    createdAt/updatedAt Mongoose's own schema timestamps add on the read
    side). Any of _OPTIONAL_KEYS missing from this run's record is
    explicitly $unset, not just left alone, so a value from an earlier run
    (e.g. `retried: true`, or a mismatch's `details`) can't survive into a
    rerun whose new record no longer carries it -- see _OPTIONAL_KEYS.

    Before writing, re-applies any corrections already recorded against an
    email_id's *existing* Mongo document (see _load_existing_corrections).
    Without this, a human correction/resolution -- however it got written,
    CLI or a frontend route -- is only as durable as the next unrelated
    pipeline rerun: process_comparison_requests recomputes each email from
    scratch and knows nothing about a prior human action, so a plain
    `--write-db` rerun would otherwise silently replace a corrected,
    resolved document with a fresh, uncorrected one. Re-applying here (via
    backend/review.py::apply_corrections, the same tested logic a CLI/API
    would call directly) means a correction survives any number of later
    reruns regardless of which one actually made it, not just the run that
    happened to include the correction step. This does NOT re-evaluate
    whether the fresh run's own escalation.required/reasons should change --
    those still reflect this run's own findings; only the historical
    correction's effects (corrections[], escalation.resolved/resolved_by/
    resolution_note) are replayed on top, same as apply_corrections always
    does when called directly.

    `collection` lets a caller (or a test) supply the collection directly,
    bypassing get_client/get_results_collection entirely -- the seam the
    tests in tests/test_db.py mock against, so they need no live database
    or network access.

    Returns the number of documents upserted or modified. A no-op (0, no
    connection even opened) for an empty `results`.
    """
    if not results:
        return 0

    owns_client = collection is None
    client: Optional[MongoClient] = None
    if collection is None:
        client = get_client(uri)
        collection = client[db_name or os.environ.get("MONGODB_DB", "jobhunters")][RESULTS_COLLECTION]

    try:
        existing_corrections = _load_existing_corrections(collection, owner, results.keys())

        processed_at = datetime.now(timezone.utc)
        operations = []
        for email_id, record in results.items():
            record = dict(record)
            corrections = existing_corrections.get(email_id)
            if corrections:
                from .review import apply_corrections  # local import: same reason as Correction above

                apply_corrections({email_id: record}, {email_id: corrections})

            doc = _reshape_document(record)
            doc.update(owner=owner, email_id=email_id, processed_at=processed_at)
            update: Dict[str, Any] = {"$set": doc}
            missing = {key: "" for key in _OPTIONAL_KEYS if key not in doc}
            if missing:
                update["$unset"] = missing
            operations.append(UpdateOne({"owner": owner, "email_id": email_id}, update, upsert=True))
        result = collection.bulk_write(operations, ordered=False)
        return result.upserted_count + result.modified_count
    finally:
        if owns_client and client is not None:
            client.close()
