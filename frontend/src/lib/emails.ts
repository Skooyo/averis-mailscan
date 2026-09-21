import "server-only";
import { getMessage, gmailClient, isMissingMessageError, isReauthError } from "@/lib/gmail";
import { GMAIL_READONLY } from "@/lib/google";
import { connectDB } from "@/lib/mongodb";
import { visibleOwners } from "@/lib/owners";
import { unescapeNewlines } from "@/lib/text";
import { Attachment } from "@/models/Attachment";
import { Email } from "@/models/Email";
import { User } from "@/models/User";
import type { EmailDetail, InboxEmail } from "@/types/averis";

// Every read below is scoped with `visibleOwners(userEmail)`: the shared
// dataset plus, when signed in, the user's own. Pass the email from
// `getCurrentUserEmail()`.

// Not mongoose.isValidObjectId: that also accepts any 12-character string.
const OBJECT_ID = /^[0-9a-f]{24}$/i;

const toIso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// Emails synced from Gmail have Gmail's own message id as their `id` (hex); the sample data's ids differ.
const GMAIL_ID = /^[0-9a-f]{12,20}$/;
const MAX_LIVE_BODY = 200_000;

/**
 * Is this one of the viewer's own Gmail emails whose content we deliberately don't store, so it
 * can be read live from their Gmail? Never true for the shared sample data or someone else's mail.
 */
function canReadLive(
  e: { owner: string; id: string; status?: string | null; from?: string | null; subject?: string | null; body?: string | null },
  viewerEmail: string | null,
): boolean {
  return (
    viewerEmail !== null &&
    e.owner === viewerEmail.trim().toLowerCase() &&
    e.status !== "processing" &&
    e.from == null &&
    e.subject == null &&
    e.body == null &&
    GMAIL_ID.test(e.id)
  );
}

type LiveResult =
  | { ok: true; from: string; subject: string; body: string }
  | { ok: false; error: "reauth_required" | "not_found" | "failed" };

/**
 * Reads an email's content straight from its owner's Gmail, for emails we deliberately don't keep
 * (only shipping-document emails are stored in full). Nothing read here is saved anywhere.
 */
async function fetchFromGmail(owner: string, gmailId: string): Promise<LiveResult> {
  const user = await User.findOne({ email: owner }).select("+google_refresh_token google_scope");
  if (!user?.google_refresh_token || !(user.google_scope ?? "").includes(GMAIL_READONLY)) {
    return { ok: false, error: "reauth_required" };
  }
  try {
    const m = await getMessage(gmailClient(user.google_refresh_token), gmailId);
    return { ok: true, from: m.from, subject: m.subject, body: m.body.slice(0, MAX_LIVE_BODY) };
  } catch (err) {
    if (isReauthError(err)) return { ok: false, error: "reauth_required" };
    if (isMissingMessageError(err)) return { ok: false, error: "not_found" }; // deleted in Gmail
    console.error("Reading an email from Gmail failed:", err instanceof Error ? err.message : err);
    return { ok: false, error: "failed" };
  }
}

/**
 * Emails shown in the inbox. Bodies are left out: the list doesn't show them
 * and there are hundreds.
 */
export async function getInboxEmails(userEmail: string | null): Promise<InboxEmail[]> {
  await connectDB();
  const docs = await Email.find({ owner: { $in: visibleOwners(userEmail) } })
    .select("owner id category status confidence from subject sent_at attachments")
    .sort({ id: 1 })
    .lean();

  // Map to plain objects: lean() results contain ObjectIds and Dates, which
  // can't be passed from a Server Component to a Client Component.
  return docs.map((d) => ({
    docId: String(d._id),
    id: d.id,
    category: d.category ?? null,
    processing: d.status === "processing",
    failed: d.status === "failed",
    confidence: d.confidence ?? null,
    from: d.from ?? null,
    subject: d.subject ?? null,
    sentAt: toIso(d.sent_at),
    attachmentCount: d.attachments?.length ?? 0,
    canLoadLive: canReadLive(d, userEmail),
  }));
}

/**
 * When the user's Gmail was last synced successfully, as an ISO string, or null if it never has been.
 * Falls back to the older last_synced_at for accounts synced before last_sync_ok_at existed
 * (unless their last attempt failed, when that timestamp isn't a success).
 */
export async function getLastSyncedAt(userEmail: string): Promise<string | null> {
  await connectDB();
  const u = await User.findOne({ email: userEmail.trim().toLowerCase() }).select("last_sync_ok_at last_synced_at sync_error").lean();
  return toIso(u?.last_sync_ok_at ?? (u?.sync_error ? null : u?.last_synced_at));
}

/** One email with its body and attachment list, or null if it doesn't exist or isn't visible to this user. */
export async function getEmailDetail(docId: string, userEmail: string | null): Promise<EmailDetail | null> {
  if (!OBJECT_ID.test(docId)) return null;
  await connectDB();

  const email = await Email.findOne({ _id: docId, owner: { $in: visibleOwners(userEmail) } }).lean();
  if (!email) return null;

  // An email's attachments belong to the same owner as the email.
  // (Not lean(): hydrated documents give a Buffer, so we can report the size.)
  const files = await Attachment.find({ user_email: email.owner, email_id: email.id }).sort({ doc_type: -1 });

  // A slim email (content not stored) that belongs to the person looking at it: fetch it from their
  // Gmail now. Only ever the viewer's own account and token, never someone else's, and never for
  // the shared sample data.
  const live = canReadLive(email, userEmail) ? await fetchFromGmail(email.owner, email.id) : null;

  return {
    docId: String(email._id),
    id: email.id,
    category: email.category ?? null,
    processing: email.status === "processing",
    failed: email.status === "failed",
    confidence: email.confidence ?? null,
    from: live?.ok ? live.from : (email.from ?? null),
    subject: live?.ok ? live.subject : (email.subject ?? null),
    // Bodies stored before the fix in lib/gmail can still hold literal "\\n" escapes, so tidy on the way out too.
    body: live?.ok ? live.body : email.body != null ? unescapeNewlines(email.body) : null,
    live: live?.ok === true,
    liveError: live && !live.ok ? live.error : null,
    sentAt: toIso(email.sent_at),
    attachments: files.map((f) => ({
      id: String(f._id),
      filename: f.filename,
      docType: f.doc_type,
      contentType: f.content_type,
      size: f.attachment.length,
    })),
  };
}

/** The file for a download, or null if it doesn't exist or isn't visible to this user. */
export async function getAttachmentFile(attachmentId: string, userEmail: string | null) {
  if (!OBJECT_ID.test(attachmentId)) return null;
  await connectDB();
  const file = await Attachment.findOne({ _id: attachmentId, user_email: { $in: visibleOwners(userEmail) } });
  return file ? { filename: file.filename, contentType: file.content_type, data: file.attachment } : null;
}
