import { NextResponse } from "next/server";
import { GUEST_COOKIE, GUEST_MAX_AGE, safeNext } from "@/lib/auth-shared";

// "Continue with sample data": remember the choice, then go on to the page they wanted.
// POST (a form on the login page) so a link prefetch or crawler can't set the cookie by accident.
export async function POST(req: Request) {
  const form = await req.formData();
  const res = NextResponse.redirect(new URL(safeNext(String(form.get("next") ?? "")), req.url), 303);
  res.cookies.set(GUEST_COOKIE, "1", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: GUEST_MAX_AGE,
  });
  return res;
}
