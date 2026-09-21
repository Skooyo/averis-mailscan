import { getCurrentUser } from "@/lib/auth";
import { getLiveHeaders } from "@/lib/live-headers";

/**
 * Sender and subject for inbox rows whose content we don't store, read live from the signed-in
 * user's own Gmail. The inbox calls this for the rows on the page being viewed. POST + a
 * SameSite=Lax session cookie, so another website can't trigger it.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "signed_out" }, { status: 401 });

  let ids: unknown;
  try {
    ids = (await req.json())?.ids;
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  return Response.json(await getLiveHeaders(user.email, ids.slice(0, 25)));
}
