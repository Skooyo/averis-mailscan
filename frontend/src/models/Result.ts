import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";
import { EMAIL_CATEGORIES } from "./Email";

// The literal `status` strings backend/pipeline.py and backend/comparison.py actually emit:
// "match"/"mismatch" from CompareResult, "error"/"skipped"/"unclassified" from
// process_comparison_requests for anything that isn't a clean comparison. Not invented here --
// read straight off backend/pipeline.py::process_comparison_requests and backend/comparison.py.
export const RESULT_STATUSES = ["match", "mismatch", "error", "skipped", "unclassified"] as const;

// One mismatched/missing field's SI vs BL value (backend/comparison.py `FieldDifference`).
// `si`/`bl` are `Any` on the Python side (string, number, or null), so Mixed here too.
const fieldDifferenceSchema = new Schema(
  {
    si: Schema.Types.Mixed,
    bl: Schema.Types.Mixed,
  },
  { _id: false },
);

// backend/escalate.py `EscalationReason`.
const escalationReasonSchema = new Schema(
  {
    code: { type: String, required: true },
    detail: { type: String, required: true },
  },
  { _id: false },
);

// backend/escalate.py `EscalationReport`. `resolved`/`resolved_by`/`resolution_note` start
// false/null and are only ever set by a human action (backend/review.py::mark_resolved /
// apply_corrections) -- evaluate_email() itself never sets them.
const escalationSchema = new Schema(
  {
    required: { type: Boolean, default: false },
    reasons: { type: [escalationReasonSchema], default: [] },
    resolved: { type: Boolean, default: false },
    resolved_by: { type: String, default: null },
    resolution_note: { type: String, default: null },
  },
  { _id: false },
);

// One collapsed duplicate-attachment group (backend/pipeline.py::dedupe_attachments()):
// `kept` is the attachment key that survived, `dropped` the keys collapsed into it. NOT a Map
// keyed by `kept` -- attachment keys are file paths (backend/extract.py::_attachment_key), which
// routinely contain dots (e.g. "attachments/email_001_SI.txt"); a dotted key in a Mongoose Map
// throws on hydration and needs Mongo >=5.0 even at the raw driver level. backend/db.py reshapes
// the Python dict {kept: [dropped, ...]} into this array shape before writing.
const duplicateAttachmentGroupSchema = new Schema(
  {
    kept: { type: String, required: true },
    dropped: { type: [String], required: true },
  },
  { _id: false },
);

// backend/review.py `Correction` -- one human override, appended to `record["corrections"]` by
// apply_corrections(). `email_id` is redundant with the parent Result's own email_id (the
// correction ledger backend/review.py writes is a separate flat file keyed the same way), kept
// here only so this subdocument matches that model 1:1 rather than silently dropping a field.
const correctionSchema = new Schema(
  {
    email_id: { type: String, required: true },
    field: { type: String, required: true }, // "category", or a canonical field name e.g. "shipper"
    value: Schema.Types.Mixed,
    note: { type: String, default: null },
    corrected_by: { type: String, default: null },
    corrected_at: { type: String, required: true }, // ISO string, as backend/review.py's Correction already stores it
  },
  { _id: false },
);

const resultSchema = new Schema(
  {
    owner: { type: String, required: true, lowercase: true, trim: true }, // User.email, or SHARED_OWNER -- same convention as Email.owner
    email_id: { type: String, required: true }, // Email.id this result belongs to (unique per owner, not globally)

    status: { type: String, enum: RESULT_STATUSES, required: true },
    // null only for "unclassified" (process_comparison_requests has no Classification to read a
    // category from at all); every other status carries the classifier's category, even
    // "skipped" -- that's *why* it was skipped.
    category: { type: String, enum: EMAIL_CATEGORIES, default: null },

    // Always present (CompareResult.message is required; the skipped/unclassified/error branches
    // in process_comparison_requests all set one too).
    message: { type: String, required: true },

    // Only meaningful for a compared (match/mismatch) result -- `default: undefined` keeps these
    // absent rather than Mongoose's default empty array/object on every other status.
    incorrect_or_missing: { type: [String], default: undefined },
    // field name -> {si, bl}, only for the fields compare_documents flagged. NOTE: matched fields
    // are NOT represented anywhere in this document -- backend/comparison.py's CompareResult only
    // ever records the fields it flagged, so a full 7-field SI/BL table (including the values of
    // fields that matched) cannot be reconstructed from this alone. See frontend/src/lib/results.ts.
    details: { type: Map, of: fieldDifferenceSchema, default: undefined },

    // One entry per collapsed duplicate-attachment group. Only present when a duplicate was
    // actually found -- see duplicateAttachmentGroupSchema above for why this is an array, not a Map.
    duplicate_attachments: { type: [duplicateAttachmentGroupSchema], default: undefined },

    // Audit trail left by backend/review.py::apply_corrections(); absent until a human corrects
    // this email at least once.
    corrections: { type: [correctionSchema], default: undefined },
    // Set true by backend/review.py::retry_email() when this record came from a re-run, not the
    // original pipeline pass.
    retried: { type: Boolean, default: undefined },

    escalation: { type: escalationSchema, required: true },

    // When the pipeline run that produced this document wrote it (backend/db.py::upsert_results).
    // Distinct from Mongoose's own createdAt/updatedAt below, which track this *document's* history
    // in Mongo, not the pipeline run that generated its content.
    processed_at: { type: Date, required: true },
  },
  // Explicit collection name: backend/db.py's RESULTS_COLLECTION must match this literally --
  // don't rely on both sides agreeing on Mongoose's pluralization of "Result" by coincidence.
  { id: false, timestamps: true, collection: "results" },
);

resultSchema.index({ owner: 1, email_id: 1 }, { unique: true });

export type ResultAttrs = InferSchemaType<typeof resultSchema>;

export const Result = (models.Result as Model<ResultAttrs>) || model<ResultAttrs>("Result", resultSchema);
