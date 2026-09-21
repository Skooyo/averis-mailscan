import "server-only";
import { getMessageHeaders, gmailClient, isMissingMessageError, isReauthError } from "@/lib/gmail";
import { GMAIL_READONLY } from "@/lib/google";
import { connectDB } from "@/lib/mongodb";
import { Email } from "@/models/Email";
import { User } from "@/models/User";

export interface LiveHeader {
  from: string;
  subject: string;
}

export interface LiveHeadersResult {
  headers: Record<string, LiveHeader>; // by email document id
  unavailable: string[]; // ids we couldn't load (deleted in Gmail, or a Gmail error)
  reauthRequired: boolean; // the stored Google token no longer works
}

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const GMAIL_ID = /^[0-9a-f]{12,20}$/;
const MAX_IDS = 25; // one inbox page
const CONCURRENCY = 5;

// Sender and subject of emails we deliberately don't store, remembered in this server process's
// memory for a few minutes so paging back and forth doesn't hit Gmail every time. Never written
// to the database, and lost on restart. Keyed by owner, so one user's entries are never served to another.
const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 1000;
const cache = new Map<string, { at: number; value: LiveHeader }>();

function remember(key: string, value: LiveHeader) {
  cache.delete(key); // re-insert so the oldest entries come first
  cache.set(key, { at: Date.now(), value });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
}

/**
 * Sender and subject, read live from the viewer's own Gmail, for their emails that we don't store.
 * `docIds` are email document ids; anything that isn't the viewer's own slim Gmail email is ignored,
 * so this can never read another account's mail.
 */
export async function getLiveHeaders(viewerEmail: string, docIds: string[]): Promise<LiveHeadersResult> {
  const owner = viewerEmail.trim().toLowerCase();
  const out: LiveHeadersResult = { headers: {}, unavailable: [], reauthRequired: false };
  const ids = docIds.filter((id) => OBJECT_ID.test(id)).slice(0, MAX_IDS);
  if (ids.length === 0) return out;

  await connectDB();
  // Slim emails have no sender/subject/body fields at all; processing ones are still being classified.
  const rows = (
    await Email.find({ _id: { $in: ids }, owner, status: { $exists: false }, from: { $exists: false }, subject: { $exists: false }, body: { $exists: false } })
      .select("id")
      .lean()
  ).filter((r) => GMAIL_ID.test(r.id));

  const pending: { docId: string; gmailId: string }[] = [];
  const now = Date.now();
  for (const r of rows) {
    const hit = cache.get(`${owner}:${r.id}`);
    if (hit && now - hit.at < TTL_MS) out.headers[String(r._id)] = hit.value;
    else pending.push({ docId: String(r._id), gmailId: r.id });
  }
  if (pending.length === 0) return out;

  const user = await User.findOne({ email: owner }).select("+google_refresh_token google_scope");
  if (!user?.google_refresh_token || !(user.google_scope ?? "").includes(GMAIL_READONLY)) {
    out.reauthRequired = true;
    out.unavailable.push(...pending.map((p) => p.docId));
    return out;
  }
  const client = gmailClient(user.google_refresh_token);

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
      while (next < pending.length && !out.reauthRequired) {
        const { docId, gmailId } = pending[next++];
        try {
          const value = await getMessageHeaders(client, gmailId);
          remember(`${owner}:${gmailId}`, value);
          out.headers[docId] = value;
        } catch (err) {
          if (isReauthError(err)) out.reauthRequired = true;
          else if (!isMissingMessageError(err)) console.error("Reading an email's headers from Gmail failed:", err instanceof Error ? err.message : err);
          out.unavailable.push(docId);
        }
      }
    }),
  );
  // Anything not attempted because the token failed is unavailable too.
  const done = new Set([...Object.keys(out.headers), ...out.unavailable]);
  out.unavailable.push(...pending.map((p) => p.docId).filter((id) => !done.has(id)));
  return out;
}
