import "server-only";
import { SHARED_OWNER } from "@/lib/constants";
import { connectDB } from "@/lib/mongodb";
import { visibleOwners } from "@/lib/owners";
import { CANONICAL_FIELDS } from "@/lib/results";
import { Result } from "@/models/Result";

// backend/comparison.py::NO_MISMATCH_MESSAGE, verbatim -- CompareResult.message is set to exactly
// this string once every flagged field has been resolved, and the frontend has to produce the same
// string when a correction resolves the last one, or the two runtimes' output would visibly diverge.
const NO_MISMATCH_MESSAGE = "No mismatch detected";

/**
 * The write side of frontend/src/lib/results.ts's read helpers -- a TypeScript port of
 * backend/review.py's apply_corrections()/mark_resolved(), operating directly on the Mongoose
 * `Result` document instead of the Python `results: Dict[email_id, dict]` shape those functions
 * take. Deliberately NOT a port of retry_email(): that needs real extraction (LLM calls) and the
 * original attachment files, neither of which the Vercel-hosted frontend has access to. See
 * backend/review.py's module docstring and todo.md/HANDOVER.md for what completing retry actually
 * requires -- correct/resolve don't have that problem, they're pure document edits.
 */

async function findResultDoc(emailId: string, userEmail: string | null) {
  const owners = visibleOwners(userEmail);
  const docs = await Result.find({ email_id: emailId, owner: { $in: owners } });
  if (docs.length === 0) return null;
  // Same (owner, email_id) collision preference as getComparisonResult/getReviewQueue in results.ts.
  return docs.find((d) => d.owner !== SHARED_OWNER) ?? docs[0];
}

export type ReviewActionResult = "ok" | "not_found" | "invalid_field";

export interface CorrectFieldInput {
  emailId: string;
  field: string; // "category", or one of CANONICAL_FIELDS
  value: unknown;
  note?: string | null;
}

/**
 * Record a human correction and have it resolve the mismatch, same contract as
 * backend/review.py::apply_corrections(): a "category" correction overrides the category
 * directly; any other field is treated as a canonical comparison field -- if it was flagged in
 * incorrect_or_missing, the correction resolves it (removed from incorrect_or_missing/details,
 * status flips to "match" once nothing is left outstanding). Always appended to `corrections` as
 * an audit trail, and escalation.resolved is set true regardless -- a human has now looked at it,
 * whatever the original reasons said.
 *
 * `correctedBy` comes from the caller's verified session (see the API route), never from request
 * input, so a client can't attribute a correction to someone else.
 */
export async function correctField(
  input: CorrectFieldInput,
  userEmail: string | null,
  correctedBy: string | null,
): Promise<ReviewActionResult> {
  if (input.field !== "category" && !CANONICAL_FIELDS.includes(input.field as (typeof CANONICAL_FIELDS)[number])) {
    return "invalid_field";
  }

  await connectDB();
  const doc = await findResultDoc(input.emailId, userEmail);
  if (!doc) return "not_found";

  const correction = {
    email_id: input.emailId,
    field: input.field,
    value: input.value,
    note: input.note ?? null,
    corrected_by: correctedBy,
    corrected_at: new Date().toISOString(),
  };
  // Cast: Mongoose accepts a plain array of subdocument-shaped objects on assignment and casts it
  // to a real DocumentArray internally on save -- the mismatch here is purely against the stricter
  // DocumentArray type TS infers for the getter, not a runtime issue.
  const newCorrections = [...(doc.corrections ?? []), correction];
  doc.corrections = newCorrections as typeof doc.corrections;

  if (input.field === "category") {
    doc.category = input.value as typeof doc.category;
  } else {
    const incorrect = doc.incorrect_or_missing;
    if (Array.isArray(incorrect) && incorrect.includes(input.field)) {
      const remaining = incorrect.filter((f) => f !== input.field);
      doc.incorrect_or_missing = remaining;
      doc.details?.delete(input.field);
      if (remaining.length === 0) {
        doc.status = "match";
        doc.message = NO_MISMATCH_MESSAGE;
      }
    }
  }

  doc.escalation.resolved = true;
  doc.escalation.resolved_by = correctedBy;
  const notes = newCorrections.map((c) => c.note).filter((n): n is string => Boolean(n));
  doc.escalation.resolution_note = notes.length > 0 ? notes.join("; ") : null;

  await doc.save();
  return "ok";
}

export interface ResolveEscalationInput {
  emailId: string;
  note?: string | null;
}

/**
 * Acknowledge an escalation without changing any value -- backend/review.py::mark_resolved()'s
 * "a human looked at it, it's fine as-is" case (e.g. a low-confidence field that's actually
 * correct).
 */
export async function resolveEscalation(
  input: ResolveEscalationInput,
  userEmail: string | null,
  resolvedBy: string | null,
): Promise<ReviewActionResult> {
  await connectDB();
  const doc = await findResultDoc(input.emailId, userEmail);
  if (!doc) return "not_found";

  doc.escalation.resolved = true;
  doc.escalation.resolved_by = resolvedBy;
  doc.escalation.resolution_note = input.note ?? null;

  await doc.save();
  return "ok";
}
