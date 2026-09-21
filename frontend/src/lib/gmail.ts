import "server-only";
import { OAuth2Client } from "google-auth-library";
import { decrypt } from "@/lib/crypto";
import { unescapeNewlines } from "@/lib/text";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export type DocType = "SI" | "BL";

// We only keep shipping documents: attachments that are clearly an SI or a BL.
const DOC_EXTENSIONS = new Set(["pdf", "xlsx", "xls", "docx", "doc", "txt"]);
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // MongoDB documents top out at 16 MB

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  txt: "text/plain",
};

/**
 * Is this filename an SI or a BL? Real attachments aren't named like our sample data
 * (email_001_SI.txt), so look for the words: "SI", "S/I", "Shipping Instruction(s)" and
 * "BL", "B/L", "HBL", "MBL", "Bill of Lading". Anything else, or a name that looks like
 * both, or a file type/size we don't keep, is null (and the attachment is skipped).
 */
export function detectDocType(filename: string, size = 0): DocType | null {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  if (!DOC_EXTENSIONS.has(ext) || size > MAX_ATTACHMENT_BYTES) return null;

  // "SI_5RSG-00133" / "Draft B/L (final)" -> " si 5rsg 00133 " / " draft b/l final "
  const name = ` ${filename.slice(0, dot).toLowerCase().replace(/[^a-z0-9/]+/g, " ")} `;
  const si = / (si|s\/i) /.test(name) || /shipping instructions?/.test(name);
  const bl = / (bl|b\/l|hbl|mbl|hb\/l|mb\/l) /.test(name) || /bill of lading/.test(name);
  if (si === bl) return null; // neither, or ambiguous
  return si ? "SI" : "BL";
}

export const contentTypeFor = (filename: string, fallback?: string) =>
  CONTENT_TYPES[filename.slice(filename.lastIndexOf(".") + 1).toLowerCase()] || fallback || "application/octet-stream";

// --- Gmail response shapes (only what we read) -----------------------------

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  internalDate?: string;
  payload?: GmailPart;
}

export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
  docType: DocType; // only SI/BL attachments are kept
  attachmentId: string | null;
  inlineData: string | null; // small attachments can arrive inline, base64url
}

export interface ParsedMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
  sentAt: Date | null;
  attachments: AttachmentMeta[];
}

// --- parsing ----------------------------------------------------------------

const decodeBase64Url = (data: string) => Buffer.from(data, "base64url");

/** Header values normally arrive decoded; this handles any left as RFC 2047 "=?utf-8?B?...?=" words. */
export function decodeMimeWords(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, "$1$2") // whitespace between adjacent encoded words is ignored
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, enc: string, text: string) => {
      try {
        const bytes =
          enc.toLowerCase() === "b"
            ? Buffer.from(text, "base64")
            : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
        return new TextDecoder(charset).decode(bytes);
      } catch {
        return whole;
      }
    });
}

const ENTITIES: Record<string, string> = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" };

/** Plain text from an HTML-only email: good enough for classification and display. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseMessage(msg: GmailMessage): ParsedMessage {
  const payload = msg.payload ?? {};
  const header = (name: string) =>
    payload.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

  const plain: string[] = [];
  const html: string[] = [];
  const attachments: AttachmentMeta[] = [];

  const walk = (part: GmailPart) => {
    if (part.filename) {
      // A file (not the message text). Keep it only if it's an SI/BL of a type and size we store.
      const size = part.body?.size ?? 0;
      const docType = detectDocType(part.filename, size);
      if (docType && (part.body?.attachmentId || part.body?.data)) {
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType ?? "",
          size,
          docType,
          attachmentId: part.body.attachmentId ?? null,
          inlineData: part.body.data ?? null,
        });
      }
      return;
    }
    if (part.mimeType === "text/plain" && part.body?.data) plain.push(decodeBase64Url(part.body.data).toString("utf8"));
    else if (part.mimeType === "text/html" && part.body?.data) html.push(decodeBase64Url(part.body.data).toString("utf8"));
    part.parts?.forEach(walk);
  };
  walk(payload);

  // Prefer the plain-text part; fall back to the HTML one for HTML-only emails.
  const body = unescapeNewlines(plain.join("\n").replace(/\r\n/g, "\n").trim() || htmlToText(html.join("\n")));

  // Sender's Date header when it parses, otherwise when Gmail received it.
  const headerDate = new Date(header("Date"));
  const received = msg.internalDate ? new Date(Number(msg.internalDate)) : null;
  const sentAt = !Number.isNaN(headerDate.getTime()) ? headerDate : received && !Number.isNaN(received.getTime()) ? received : null;

  return {
    id: msg.id,
    from: decodeMimeWords(header("From")),
    subject: decodeMimeWords(header("Subject")),
    body,
    sentAt,
    attachments,
  };
}

// --- API calls -----------------------------------------------------------------

// A client remembers the access token it fetched, so reusing one skips a round trip to Google
// (a few hundred ms) on every sync and live read. Kept in this server process's memory only, keyed
// by the stored (encrypted) token: reconnecting Google stores a new one, which gets a fresh client.
const clients = new Map<string, OAuth2Client>();
const MAX_CLIENTS = 100;

/** A Gmail client for one user, from their stored (encrypted) Google refresh token. Access tokens are refreshed automatically. */
export function gmailClient(encryptedRefreshToken: string): OAuth2Client {
  const hit = clients.get(encryptedRefreshToken);
  if (hit) return hit;

  const client = new OAuth2Client({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET });
  client.setCredentials({ refresh_token: decrypt(encryptedRefreshToken) });
  clients.set(encryptedRefreshToken, client);
  if (clients.size > MAX_CLIENTS) clients.delete(clients.keys().next().value as string);
  return client;
}

/** Ids of the newest inbox messages, newest first. */
export async function listInboxIds(client: OAuth2Client, max: number): Promise<string[]> {
  const res = await client.request<{ messages?: { id: string }[] }>({
    url: `${API}/messages`,
    params: { labelIds: "INBOX", maxResults: max },
  });
  return (res.data.messages ?? []).map((m) => m.id);
}

export async function getMessage(client: OAuth2Client, id: string): Promise<ParsedMessage> {
  const res = await client.request<GmailMessage>({ url: `${API}/messages/${id}`, params: { format: "full" } });
  return parseMessage(res.data);
}

export async function getAttachment(client: OAuth2Client, messageId: string, a: AttachmentMeta): Promise<Buffer> {
  if (a.inlineData) return decodeBase64Url(a.inlineData);
  const res = await client.request<{ data: string }>({ url: `${API}/messages/${messageId}/attachments/${a.attachmentId}` });
  return decodeBase64Url(res.data.data);
}

/** Just the sender and subject of a message (a much lighter call than reading the whole thing). */
export async function getMessageHeaders(client: OAuth2Client, id: string): Promise<{ from: string; subject: string }> {
  const res = await client.request<GmailMessage>({
    url: `${API}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
  });
  const header = (name: string) => res.data.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
  return { from: decodeMimeWords(header("from")), subject: decodeMimeWords(header("subject")) };
}

/** The message doesn't exist (any more): Gmail answers 404 for a deleted one and 400 "Invalid id" for a malformed id. */
export function isMissingMessageError(err: unknown): boolean {
  const e = err as { message?: string; response?: { status?: number } };
  const status = e?.response?.status;
  return status === 404 || (status === 400 && /invalid id/i.test(e?.message ?? ""));
}

/** True when Google says the stored refresh token no longer works (revoked, expired, password changed). */
export function isReauthError(err: unknown): boolean {
  const e = err as { message?: string; response?: { data?: { error?: string } } };
  return e?.response?.data?.error === "invalid_grant" || /invalid_grant/.test(e?.message ?? "");
}
