import "server-only";
import { connectDB } from "@/lib/mongodb";
import { visibleOwners } from "@/lib/owners";
import { Attachment } from "@/models/Attachment";
import { Email } from "@/models/Email";
import type { EmailDetail, InboxEmail } from "@/types/averis";

// Every read below is scoped with `visibleOwners(userEmail)`: the shared
// dataset plus, when signed in, the user's own. Pass the email from
// `getCurrentUserEmail()`.

// Not mongoose.isValidObjectId: that also accepts any 12-character string.
const OBJECT_ID = /^[0-9a-f]{24}$/i;

const toIso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * Emails shown in the inbox. Bodies are left out: the list doesn't show them
 * and there are hundreds.
 */
export async function getInboxEmails(userEmail: string | null): Promise<InboxEmail[]> {
  await connectDB();
  const docs = await Email.find({ owner: { $in: visibleOwners(userEmail) } })
    .select("id category confidence from subject sent_at attachments")
    .sort({ id: 1 })
    .lean();

  // Map to plain objects: lean() results contain ObjectIds and Dates, which
  // can't be passed from a Server Component to a Client Component.
  return docs.map((d) => ({
    docId: String(d._id),
    id: d.id,
    category: d.category,
    confidence: d.confidence ?? null,
    from: d.from ?? "",
    subject: d.subject ?? "",
    sentAt: toIso(d.sent_at),
    attachmentCount: d.attachments?.length ?? 0,
  }));
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

  return {
    docId: String(email._id),
    id: email.id,
    category: email.category,
    confidence: email.confidence ?? null,
    from: email.from ?? "",
    subject: email.subject ?? "",
    body: email.body ?? "",
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
