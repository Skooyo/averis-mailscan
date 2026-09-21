import { getCurrentUserEmail } from "@/lib/auth";
import { resolveEscalation } from "@/lib/review-actions";

/**
 * Acknowledge an email's escalation without changing any value -- the frontend counterpart to
 * backend/review.py::mark_resolved().
 */
export async function POST(req: Request, { params }: { params: Promise<{ emailId: string }> }) {
  const { emailId } = await params;
  const body = await req.json().catch(() => ({}));
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim() : null;

  const userEmail = await getCurrentUserEmail();
  const result = await resolveEscalation({ emailId, note }, userEmail, userEmail);

  if (result === "not_found") {
    return Response.json({ status: "error", error: "result_not_found" }, { status: 404 });
  }
  return Response.json({ status: "ok" });
}
