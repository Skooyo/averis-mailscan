import "server-only";
import type { OAuth2Client } from "google-auth-library";
import { classifierConfigured, classifyEmails, ClassifierAuthError, type Category, type Classification } from "@/lib/classify";
import {
  contentTypeFor,
  getAttachment,
  getMessage,
  gmailClient,
  isReauthError,
  listInboxIds,
  type ParsedMessage,
} from "@/lib/gmail";
import { GMAIL_READONLY } from "@/lib/google";
import { connectDB } from "@/lib/mongodb";
import { Attachment } from "@/models/Attachment";
import { Email } from "@/models/Email";
import { User } from "@/models/User";

export const SYNC_INTERVAL_MS = 5 * 60_000; // an automatic sync (page load) runs at most this often per user
const FORCE_MIN_INTERVAL_MS = 10_000; // even a manual refresh can't sync more often than this (protects the Gmail and model quotas)
const STALE_LOCK_MS = 10 * 60_000; // a sync that started longer ago than this is assumed dead
const MAX_MESSAGES = 50; // newest inbox messages considered per sync
const FETCH_CONCURRENCY = 5;
const MAX_BODY_CHARS = 100_000;

const KNOWN_ERRORS = ["reauth_required", "classifier_key_rejected", "failed"];
type KnownError = "reauth_required" | "classifier_key_rejected" | "failed";

export type SyncResult =
  | { status: "synced"; added: number; checked: number; unclassified: number }
  | { status: "skipped"; reason: "recent" | "in_progress" }
  | { status: "error"; error: "classifier_not_configured" | "no_gmail_access" | "reauth_required" | "classifier_key_rejected" | "failed"; message?: string };

// --- storage rules (the same ones as the sample-data ingest) -------------------

/** SI requests and comparison requests are stored in full; everything else only as owner/id/category/confidence. */
export const isStoredInFull = (category: Category) => category === "new_si_request" || category === "comparison_request";

/**
 * A comparison request needs both an SI and a BL attached, otherwise there's nothing to compare:
 * it becomes `general` and its confidence is dropped (the score was for the original category).
 */
export function applyRules(c: Classification, msg: Pick<ParsedMessage, "attachments">): { category: Category; confidence?: number } {
  const types = msg.attachments.map((a) => a.docType);
  if (c.category === "comparison_request" && !(types.includes("SI") && types.includes("BL"))) {
    return { category: "general" };
  }
  return { category: c.category, confidence: c.confidence };
}

/** The email document to store. `sent_at` is stored for every email; content only for the categories kept in full. */
export function buildEmailDoc(owner: string, msg: ParsedMessage, result: { category: Category; confidence?: number }, attachmentIds: unknown[] = []) {
  return {
    owner,
    id: msg.id,
    category: result.category,
    ...(result.confidence !== undefined && { confidence: result.confidence }),
    ...(msg.sentAt && { sent_at: msg.sentAt }),
    ...(isStoredInFull(result.category) && {
      from: msg.from,
      subject: msg.subject,
      body: msg.body.slice(0, MAX_BODY_CHARS),
      ...(attachmentIds.length > 0 && { attachments: attachmentIds }), // absent, not [], when there are none
    }),
  };
}

// --- sync ---------------------------------------------------------------------

/** Runs `fn` over `items`, at most `limit` at a time; failures become undefined instead of aborting the rest. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          out[i] = await fn(items[i]);
        } catch (err) {
          console.error("Gmail sync: skipped one message:", err instanceof Error ? err.message : err);
        }
      }
    }),
  );
  return out;
}

/** Atomically takes the sync slot for this user, unless one ran within `minGapMs` or is running now. */
async function claim(email: string, minGapMs: number): Promise<boolean> {
  const now = Date.now();
  const claimed = await User.findOneAndUpdate(
    {
      email,
      $and: [
        { $or: [{ last_synced_at: { $exists: false } }, { last_synced_at: null }, { last_synced_at: { $lte: new Date(now - minGapMs) } }] },
        { $or: [{ sync_started_at: { $exists: false } }, { sync_started_at: null }, { sync_started_at: { $lte: new Date(now - STALE_LOCK_MS) } }] },
      ],
    },
    { $set: { sync_started_at: new Date(now) } },
  );
  return claimed !== null;
}

async function release(email: string, error?: string) {
  const now = new Date();
  await User.updateOne(
    { email },
    {
      // last_synced_at is the last attempt (it drives the throttle); last_sync_ok_at only moves on success.
      $set: { last_synced_at: now, ...(error ? { sync_error: error } : { last_sync_ok_at: now }) },
      $unset: { sync_started_at: 1, ...(!error && { sync_error: 1 }) },
    },
  );
}

/**
 * Turns a "processing" email into its final form: classified, stored per the rules above, and (for
 * emails kept in full) with its SI/BL files downloaded. Returns false if the email is no longer there.
 */
async function finalize(owner: string, client: OAuth2Client, msg: ParsedMessage, c: Classification): Promise<boolean> {
  const result = applyRules(c, msg);
  const full = isStoredInFull(result.category);

  // Download only the SI/BL files, and only for emails we keep in full.
  let attachmentIds: unknown[] = [];
  if (full && msg.attachments.length > 0) {
    await Attachment.deleteMany({ user_email: owner, email_id: msg.id }); // leftovers from a sync that died
    const files = await mapLimit(msg.attachments, FETCH_CONCURRENCY, async (a) => ({ a, data: await getAttachment(client, msg.id, a) }));
    const created = await Attachment.insertMany(
      files
        .filter((f): f is NonNullable<typeof f> => !!f)
        .map(({ a, data }) => ({
          attachment: data,
          doc_type: a.docType,
          filename: a.filename,
          content_type: contentTypeFor(a.filename, a.mimeType),
          email_id: msg.id,
          user_email: owner,
        })),
    );
    attachmentIds = created.map((d) => d._id);
  }

  const fields: Record<string, unknown> = { ...buildEmailDoc(owner, msg, result, attachmentIds) };
  delete fields.owner;
  delete fields.id;
  const res = await Email.updateOne(
    { owner, id: msg.id, status: "processing" }, // never touch an email that is already finished
    // Emails not kept in full were shown with their sender and subject while processing: drop those now.
    { $set: fields, $unset: { status: 1, ...(!full && { from: 1, subject: 1 }) } },
  );
  if (res.modifiedCount === 0 && attachmentIds.length > 0) await Attachment.deleteMany({ _id: { $in: attachmentIds } });
  return res.modifiedCount > 0;
}

async function pullAndStore(owner: string, client: OAuth2Client, onProgress?: () => void) {
  const ids = await listInboxIds(client, MAX_MESSAGES);
  // Finished emails have no `status`. Any still marked "processing" were left by a sync that died: redo them.
  const finished = new Set((await Email.find({ owner, id: { $in: ids }, status: { $exists: false } }).select("id").lean()).map((e) => e.id));
  const fresh = ids.filter((id) => !finished.has(id)); // only new mail is fetched and classified
  if (fresh.length === 0) return { added: 0, checked: ids.length, unclassified: 0 };

  const messages = (await mapLimit(fresh, FETCH_CONCURRENCY, (id) => getMessage(client, id))).filter((m): m is ParsedMessage => !!m);
  if (messages.length === 0) return { added: 0, checked: ids.length, unclassified: 0 };
  const byId = new Map(messages.map((m) => [m.id, m]));

  // Put every new email in the inbox right away, marked "processing", so people can see it while
  // it's being classified. Sender and subject are kept only until we know whether it's stored in full.
  await Email.bulkWrite(
    messages.map((m) => ({
      updateOne: {
        filter: { owner, id: m.id },
        update: { $setOnInsert: { status: "processing", from: m.from, subject: m.subject, ...(m.sentAt && { sent_at: m.sentAt }) } },
        upsert: true,
      },
    })) as Parameters<typeof Email.bulkWrite>[0],
    { ordered: false },
  );
  // Emails that failed to classify last time are back in the queue.
  await Email.updateMany({ owner, id: { $in: messages.map((m) => m.id) }, status: "failed" }, { $set: { status: "processing" } });
  onProgress?.(); // the new emails are in the inbox now, as "Processing"

  let added = 0;
  let unclassified = 0;
  try {
    // Each batch of 10 is finished as soon as the model answers, so rows flip from "Processing" one batch at a time.
    await classifyEmails(
      messages.map((m) => ({ id: m.id, from: m.from, subject: m.subject, body: m.body, attachments: m.attachments })),
      async (results, failedIds) => {
        if (failedIds.length > 0) {
          unclassified += failedIds.length;
          // Stay visible, marked "failed": the next sync fetches and classifies them again.
          await Email.updateMany({ owner, id: { $in: failedIds }, status: "processing" }, { $set: { status: "failed" } });
        }
        for (const [id, c] of results) {
          if (await finalize(owner, client, byId.get(id)!, c)) added++;
        }
        onProgress?.(); // this batch is classified
      },
    );
  } finally {
    // Nothing from this sync may stay "processing" (a rejected API key, a crash mid-batch): it would never finish.
    await Email.updateMany({ owner, id: { $in: messages.map((m) => m.id) }, status: "processing" }, { $set: { status: "failed" } });
  }
  return { added, checked: ids.length, unclassified };
}

/**
 * Pulls the newest inbox emails from the user's Gmail, classifies the new ones, and stores them.
 * Safe to call on every inbox load: it does nothing if it ran in the last few minutes or is
 * already running, and only ever fetches emails we haven't stored yet.
 */
export async function syncGmail(
  userEmail: string,
  opts: { force?: boolean; onProgress?: () => void } = {},
): Promise<SyncResult> {
  await connectDB();
  const owner = userEmail.toLowerCase();

  if (!classifierConfigured()) return { status: "error", error: "classifier_not_configured" };

  // In development the server keeps the Email model it first loaded, so after a schema change it
  // could silently mishandle the "processing" / "failed" markers. Fail loudly instead.
  const statuses = (Email.schema.path("status") as { enumValues?: string[] } | undefined)?.enumValues;
  if (!statuses?.includes("processing") || !statuses.includes("failed")) {
    return { status: "error", error: "failed", message: "The Email model is out of date - restart the dev server." };
  }

  const user = await User.findOne({ email: owner }).select("+google_refresh_token google_scope");
  if (!user?.google_refresh_token || !(user.google_scope ?? "").includes(GMAIL_READONLY)) {
    return { status: "error", error: "no_gmail_access" };
  }

  // `force` (the refresh button) skips the 5-minute wait, but never overlaps a sync that's running.
  if (!(await claim(owner, opts.force ? FORCE_MIN_INTERVAL_MS : SYNC_INTERVAL_MS))) {
    const state = await User.findOne({ email: owner }).select("sync_started_at sync_error").lean();
    if (state?.sync_started_at) return { status: "skipped", reason: "in_progress" };
    // Throttled, but the last attempt failed: keep reporting that instead of a misleading "up to date".
    if (state?.sync_error && !opts.force) return { status: "error", error: KNOWN_ERRORS.includes(state.sync_error) ? (state.sync_error as KnownError) : "failed" };
    return { status: "skipped", reason: "recent" };
  }

  let failure: string | undefined;
  try {
    const stats = await pullAndStore(owner, gmailClient(user.google_refresh_token), opts.onProgress);
    return { status: "synced", ...stats };
  } catch (err) {
    console.error("Gmail sync failed:", err);
    if (isReauthError(err)) {
      failure = "reauth_required";
      return { status: "error", error: "reauth_required" };
    }
    if (err instanceof ClassifierAuthError) {
      failure = "classifier_key_rejected";
      return { status: "error", error: "classifier_key_rejected" };
    }
    failure = "failed";
    return { status: "error", error: "failed", message: err instanceof Error ? err.message.slice(0, 200) : undefined };
  } finally {
    await release(owner, failure); // always frees the lock, even if something above threw
  }
}
