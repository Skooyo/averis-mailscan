export type EmailCategory =
  | "comparison_request"
  | "new_si_request"
  | "invoice_query"
  | "general"
  | "spam";

export type EmailStatus = "mismatch" | "match" | "escalated" | "not_applicable";

export interface ComparisonField {
  field: string;
  si_value: string;
  bl_value: string;
  match: boolean;
}

export interface DocumentComparison {
  si_doc_type_detected: "SI";
  bl_doc_type_detected: "BL";
  fields: ComparisonField[];
  summary: string;
}

export interface ReviewReason {
  code: string;
  message: string;
}

export interface ClassifiedEmail {
  email_id: string;
  category: EmailCategory;
  confidence: number;
  status: EmailStatus;
  needs_review: boolean;
  review_reason: ReviewReason | null;
  comparison: DocumentComparison | null;
}

export type ClassificationDataset = Record<string, ClassifiedEmail>;

/** An email row in the inbox, as read from the `emails` collection. */
export interface InboxEmail {
  docId: string; // the document's _id; `id` alone repeats across owners, so URLs use this
  id: string;
  category: EmailCategory | null; // null while the email is still being classified
  processing: boolean; // true while a Gmail sync is classifying it
  failed: boolean; // classification didn't work; the next sync retries it
  confidence: number | null; // null when the ingest overrode the classifier's category
  from: string | null; // null, like subject, when not stored: only shipping-document emails are kept in full
  subject: string | null;
  sentAt: string | null; // ISO 8601; null when unknown (the demo dataset has no dates)
  attachmentCount: number;
  /** Sender and subject aren't stored but can be read live from the viewer's own Gmail (see lib/live-headers). */
  canLoadLive: boolean;
}

export interface AttachmentInfo {
  id: string; // attachments _id, used for the download URL
  filename: string;
  docType: "SI" | "BL";
  contentType: string;
  size: number; // bytes
}

/** Everything about one email, for the detail page. */
export interface EmailDetail {
  docId: string;
  id: string;
  category: EmailCategory | null; // null while the email is still being classified
  processing: boolean;
  failed: boolean;
  confidence: number | null;
  from: string | null; // null when not stored (see InboxEmail)
  subject: string | null;
  body: string | null;
  sentAt: string | null;
  attachments: AttachmentInfo[];
  /** True when from/subject/body were just read from the owner's Gmail because we don't store them. Nothing is saved. */
  live: boolean;
  /** Why the live read from Gmail failed, if it did. */
  liveError: "reauth_required" | "not_found" | "failed" | null;
}

export interface EmailPresentation {
  sender: string;
  initials: string;
  subject: string;
  reference: string;
  received: string;
}

export interface ReviewQueueItem {
  id: string;
  emailId: string;
  reference: string;
  issue: string;
  assignee: string;
  pending: string;
  priority: "high" | "medium" | "low";
  requiresReview: boolean;
}

// ---------------------------------------------------------------------------
// Real pipeline output (frontend/src/models/Result.ts, backend/pipeline.py
// process_comparison_requests()), read via frontend/src/lib/results.ts.
// Kept separate from the mock types above (still used by
// frontend/src/data/averis-data.ts) rather than reshaping them, since the
// real backend shape doesn't line up field-for-field with the mock's.
// ---------------------------------------------------------------------------

/** The literal status strings backend/pipeline.py/backend/comparison.py emit. */
export type ResultStatus = "match" | "mismatch" | "error" | "skipped" | "unclassified";

/** backend/escalate.py `EscalationReason`. */
export interface EscalationReasonInfo {
  code: string;
  detail: string;
}

/** backend/escalate.py `EscalationReport`. */
export interface EscalationInfo {
  required: boolean;
  reasons: EscalationReasonInfo[];
  resolved: boolean;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

/**
 * One of the 7 canonical fields (backend/comparison.py `FIELDS`), for a
 * match/mismatch result. backend/comparison.py's CompareResult records every
 * field's SI/BL value, matched or not, so a human reviewing a match can still
 * see what was read off each document. `siValue`/`blValue` are only null for
 * a Result written before that change, or a field neither document had.
 */
export interface ComparisonFieldResult {
  field: string;
  match: boolean;
  siValue: string | number | null;
  blValue: string | number | null;
}

/** backend/review.py `Correction`, as recorded in a result's audit trail. */
export interface CorrectionInfo {
  field: string; // "category", or a canonical field name
  value: unknown;
  note: string | null;
  correctedBy: string | null;
  correctedAt: string;
}

/** One collapsed duplicate-attachment group (backend/pipeline.py::dedupe_attachments()). */
export interface DuplicateAttachmentGroup {
  kept: string;
  dropped: string[];
}

/** One email's Result document, mapped to a plain serializable shape. */
export interface ResultView {
  emailId: string;
  status: ResultStatus;
  category: EmailCategory | null; // null only for "unclassified"
  message: string;
  // [] for error/skipped/unclassified, which never ran a comparison.
  fields: ComparisonFieldResult[];
  duplicateAttachments: DuplicateAttachmentGroup[];
  corrections: CorrectionInfo[];
  retried: boolean;
  escalation: EscalationInfo;
  processedAt: string; // ISO 8601
}

/** One row of the review queue: an escalated email, joined with its Email for display. */
export interface EscalationQueueItem {
  emailId: string;
  category: EmailCategory | null;
  status: ResultStatus;
  subject: string | null;
  from: string | null;
  reasons: EscalationReasonInfo[];
  resolved: boolean;
  processedAt: string; // ISO 8601
}
