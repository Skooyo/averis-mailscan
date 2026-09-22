import "server-only";
import { SHARED_OWNER } from "@/lib/constants";
import { connectDB } from "@/lib/mongodb";
import { visibleOwners } from "@/lib/owners";
import { Email } from "@/models/Email";
import { Result } from "@/models/Result";
import type {
  ComparisonFieldResult,
  CorrectionInfo,
  DuplicateAttachmentGroup,
  EmailCategory,
  ReviewItem,
  ResultStatus,
  ResultView,
} from "@/types/averis";

// The 7 canonical fields extract.py/comparison.py work with (backend/models.py, backend/comparison.py
// `FIELDS`). Drives which rows the comparison table shows -- see ComparisonFieldResult's own comment
// for why a matched field's value still comes back null.
export const CANONICAL_FIELDS = [
  "shipper",
  "consignee",
  "notify_party",
  "port_of_loading",
  "port_of_discharge",
  "container_count",
  "gross_weight_kg",
] as const;

const toIso = (d: Date | null | undefined) => (d ? d.toISOString() : new Date(0).toISOString());

// Shape of a Result document after `.lean()`. `details` is a Map in the schema
// (frontend/src/models/Result.ts), but `.lean()` never hydrates a document at all -- it returns
// the plain object the MongoDB driver decoded straight off the wire, so a Map-typed field comes
// back as a plain object here regardless (a real `MongooseMap` instance only ever gets built
// during document hydration, which `.lean()` skips entirely). `{ flattenMaps: true }` is a
// Document#toObject()/#toJSON() option, not a lean-query one, so passing it to `.lean()` here
// would be a harmless no-op -- left off rather than kept as a misleading no-op.
interface LeanResult {
  owner: string;
  email_id: string;
  status: string;
  category: string | null;
  message: string;
  incorrect_or_missing?: string[];
  details?: Record<string, { si?: unknown; bl?: unknown }>;
  duplicate_attachments?: { kept: string; dropped: string[] }[];
  corrections?: {
    field: string;
    value: unknown;
    note?: string | null;
    corrected_by?: string | null;
    corrected_at: string;
  }[];
  retried?: boolean;
  escalation: {
    required: boolean;
    reasons: { code: string; detail: string }[];
    resolved: boolean;
    resolved_by: string | null;
    resolution_note: string | null;
  };
  processed_at: Date;
}

function toFields(doc: LeanResult): ComparisonFieldResult[] {
  if (doc.status !== "match" && doc.status !== "mismatch") return [];
  const incorrect = new Set(doc.incorrect_or_missing ?? []);
  const details = doc.details ?? {};
  return CANONICAL_FIELDS.map((field) => {
    const diff = details[field];
    return {
      field,
      match: !incorrect.has(field),
      // Present for every field on a Result written since compare_documents started recording
      // matched values too; null for an older Result that only ever had the flagged fields.
      siValue: (diff?.si as string | number | undefined) ?? null,
      blValue: (diff?.bl as string | number | undefined) ?? null,
    };
  });
}

function toDuplicateAttachments(doc: LeanResult): DuplicateAttachmentGroup[] {
  return (doc.duplicate_attachments ?? []).map((g) => ({ kept: g.kept, dropped: g.dropped }));
}

function toCorrections(doc: LeanResult): CorrectionInfo[] {
  return (doc.corrections ?? []).map((c) => ({
    field: c.field,
    value: c.value,
    note: c.note ?? null,
    correctedBy: c.corrected_by ?? null,
    correctedAt: c.corrected_at,
  }));
}

function toResultView(doc: LeanResult): ResultView {
  return {
    emailId: doc.email_id,
    status: doc.status as ResultStatus,
    category: (doc.category as EmailCategory | null) ?? null,
    message: doc.message,
    fields: toFields(doc),
    duplicateAttachments: toDuplicateAttachments(doc),
    corrections: toCorrections(doc),
    retried: doc.retried ?? false,
    escalation: {
      required: doc.escalation?.required ?? false,
      reasons: doc.escalation?.reasons ?? [],
      resolved: doc.escalation?.resolved ?? false,
      resolvedBy: doc.escalation?.resolved_by ?? null,
      resolutionNote: doc.escalation?.resolution_note ?? null,
    },
    processedAt: toIso(doc.processed_at),
  };
}

/**
 * The comparison/escalation result for one email (joined on the same
 * (owner, id) key as Email -- see models/Result.ts), or null when the
 * pipeline hasn't written one yet for anyone this viewer can see. Not every
 * email has been run through `python -m backend.pipeline --write-db` in
 * every environment, so callers must handle null as a normal state, not an
 * error.
 */
export async function getComparisonResult(emailId: string, userEmail: string | null): Promise<ResultView | null> {
  await connectDB();
  const owners = visibleOwners(userEmail);
  const docs = (await Result.find({ email_id: emailId, owner: { $in: owners } }).lean()) as unknown as LeanResult[];
  if (docs.length === 0) return null;
  // Prefer the signed-in viewer's own result over the shared demo dataset's, in the unlikely
  // event both exist for the same email_id (ids aren't globally unique, only per owner).
  const doc = docs.find((d) => d.owner !== SHARED_OWNER) ?? docs[0];
  return toResultView(doc);
}

/**
 * Every comparison_request email this viewer can see that has actually gone through comparison
 * (status match/mismatch/error -- skipped/unclassified emails never ran one, so they're excluded),
 * newest-processed first, joined with their Email for subject/sender display. Includes clean
 * matches and unescalated mismatches, not just the ones backend/escalate.py flagged -- see
 * ReviewItem's own comment. Modeled on lib/emails.ts::getInboxEmails's style.
 */
export async function getReviewQueue(userEmail: string | null): Promise<ReviewItem[]> {
  await connectDB();
  const owners = visibleOwners(userEmail);

  const results = (await Result.find({ owner: { $in: owners }, status: { $in: ["match", "mismatch", "error"] } })
    .sort({ processed_at: -1 })
    .lean()) as unknown as LeanResult[];
  if (results.length === 0) return [];

  // Same (email_id, owner) collision tie-break as getComparisonResult, applied per email_id: an
  // id isn't globally unique, only per owner, so the shared demo dataset and a signed-in viewer's
  // own synced inbox could in principle both have a Result for the same email_id. Without this,
  // both rows would render (and collide on review-screen.tsx's `key={item.emailId}`).
  const byEmailId = new Map<string, LeanResult>();
  for (const r of results) {
    const existing = byEmailId.get(r.email_id);
    if (!existing || (existing.owner === SHARED_OWNER && r.owner !== SHARED_OWNER)) {
      byEmailId.set(r.email_id, r);
    }
  }
  const deduped = [...byEmailId.values()];

  const emails = await Email.find({ owner: { $in: owners }, id: { $in: deduped.map((r) => r.email_id) } })
    .select("owner id subject from")
    .lean();
  const emailByKey = new Map(emails.map((e) => [`${e.owner}:${e.id}`, e]));

  return deduped.map((r) => {
    const email = emailByKey.get(`${r.owner}:${r.email_id}`);
    return {
      emailId: r.email_id,
      category: (r.category as EmailCategory | null) ?? null,
      status: r.status as ResultStatus,
      message: r.message,
      subject: email?.subject ?? null,
      from: email?.from ?? null,
      reasons: r.escalation?.reasons ?? [],
      required: r.escalation?.required ?? false,
      resolved: r.escalation?.resolved ?? false,
      processedAt: toIso(r.processed_at),
    };
  });
}
