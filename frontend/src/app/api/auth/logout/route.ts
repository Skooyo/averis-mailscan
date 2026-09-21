import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth-shared";
import { endSession } from "@/lib/session";

// POST only, and the session cookie is SameSite=Lax, so another site can't sign you out.
export async function POST(req: Request) {
  const jar = await cookies();
  await endSession(jar.get(SESSION_COOKIE)?.value); // invalidate server-side, not just in the browser

  const res = NextResponse.redirect(new URL("/", req.url), 303); // 303: follow up with a GET
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
