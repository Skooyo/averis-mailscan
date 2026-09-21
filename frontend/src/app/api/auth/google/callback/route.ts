import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, safeNext } from "@/lib/auth-shared";
import { safeEqual, unsign } from "@/lib/crypto";
import { TX_COOKIE, TX_PATH, googleClient, googleConfigured } from "@/lib/google";
import { saveGoogleUser } from "@/lib/google-user";
import { SESSION_MAX_AGE, cookieOptions, createSession } from "@/lib/session";

/** Where Google sends the browser back to after the consent screen. */
export async function GET(req: Request) {
  const url = new URL(req.url);

  // Every exit clears the one-time cookie. Errors go back to the login page with a code.
  const finish = (to: string) => {
    const res = NextResponse.redirect(new URL(to, req.url));
    res.cookies.delete({ name: TX_COOKIE, path: TX_PATH });
    return res;
  };
  let next = "/"; // where to land afterwards; read from the signed cookie below
  const fail = (code: string) => finish(`/login?error=${code}${next === "/" ? "" : `&next=${encodeURIComponent(next)}`}`);

  if (!googleConfigured()) return fail("not_configured");
  if (url.searchParams.get("error")) return fail("denied"); // e.g. the user pressed Cancel

  // The callback must belong to a sign-in this browser started: the `state` in the URL has to
  // match the one in our signed cookie. This is what stops forged callback links.
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const tx = (await cookies()).get(TX_COOKIE)?.value;
  const payload = tx ? unsign(tx) : null;
  if (!code || !state || !payload) return fail("invalid");
  const [savedState, codeVerifier, consentForced, encodedNext] = payload.split(".");
  if (!savedState || !codeVerifier || !safeEqual(savedState, state)) return fail("invalid");
  next = safeNext(encodedNext ? Buffer.from(encodedNext, "base64url").toString() : "/"); // re-checked, never trusted

  try {
    const client = googleClient();
    const { tokens } = await client.getToken({ code, codeVerifier });
    if (!tokens.id_token) return fail("failed");

    // Verifies the signature against Google's keys, the audience (our client id) and expiry.
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID });
    const profile = ticket.getPayload();
    if (!profile?.email || !profile.email_verified) return fail("unverified");

    const { hasRefreshToken } = await saveGoogleUser({
      email: profile.email,
      name: profile.name,
      refreshToken: tokens.refresh_token,
      scope: tokens.scope,
    });

    // No refresh token yet (Google only issues one on first consent): ask once more, with the
    // consent screen forced. If that still yields none, sign in anyway; Gmail import just
    // won't be available until they reconnect.
    if (!hasRefreshToken && consentForced !== "1") {
      return finish(`/api/auth/google?consent=1&next=${encodeURIComponent(next)}`);
    }

    const res = finish(next);
    res.cookies.set(SESSION_COOKIE, await createSession(profile.email.toLowerCase()), cookieOptions(SESSION_MAX_AGE));
    return res;
  } catch (err) {
    console.error("Google sign-in failed:", err);
    return fail("failed");
  }
}
