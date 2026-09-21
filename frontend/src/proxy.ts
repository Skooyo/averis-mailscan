import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { GUEST_COOKIE, SESSION_COOKIE } from "./lib/auth-shared";

// First visit: send people to the login page. Anyone signed in (session cookie), or who
// already chose "Continue with sample data" (guest cookie), goes straight through.
//
// This is a convenience gate, not security. It only checks that a cookie exists, never that
// it's valid, and guests are allowed anyway. What each person can see is enforced in the data
// layer (lib/emails.ts, via visibleOwners).
export function proxy(request: NextRequest) {
  if (request.cookies.has(SESSION_COOKIE) || request.cookies.has(GUEST_COOKIE)) {
    return NextResponse.next();
  }

  const login = new URL("/login", request.url);
  const { pathname, search } = request.nextUrl;
  if (pathname !== "/") login.searchParams.set("next", pathname + search); // come back here afterwards
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except the login page, API routes (auth, downloads) and static files.
  matcher: ["/((?!api|login|_next/static|_next/image|.*\\..*).*)"],
};
