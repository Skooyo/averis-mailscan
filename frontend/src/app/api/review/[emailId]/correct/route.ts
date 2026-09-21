import { getCurrentUserEmail } from "@/lib/auth";
import { correctField } from "@/lib/review-actions";

/**
 * Record a human correction for one email's Result and have it resolve the mismatch -- the
 * frontend counterpart to backend/review.py::apply_corrections(). See review-actions.ts for why
 * this is safe to implement directly in TypeScript (a pure document edit) unlike retry, which
 * isn't wired up here at all -- see backend/review.py's module docstring.
 */
export async function POST(req: Request, { params }: { params: Promise<{ emailId: string }> }) {
  const { emailId } = await params;
  const body = await req.json().catch(() => null);
  const field = body?.field;
  if (typeof field !== "string" || field.length === 0) {
    return Response.json({ status: "error", error: "field is required" }, { status: 400 });
  }
  if (!("value" in (body ?? {}))) {
    return Response.json({ status: "error", error: "value is required" }, { status: 400 });
  }
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim() : null;

  const userEmail = await getCurrentUserEmail();
  const result = await correctField({ emailId, field, value: body.value, note }, userEmail, userEmail);

  if (result === "not_found") {
    return Response.json({ status: "error", error: "result_not_found" }, { status: 404 });
  }
  if (result === "invalid_field") {
    return Response.json({ status: "error", error: "invalid_field" }, { status: 400 });
  }
  return Response.json({ status: "ok" });
}
