import { NextResponse } from "next/server";
import { CodeChallengeMethod } from "google-auth-library";
import { safeNext } from "@/lib/auth-shared";
import { randomToken, sign } from "@/lib/crypto";
import { GOOGLE_SCOPES, TX_COOKIE, TX_MAX_AGE, TX_PATH, googleClient, googleConfigured } from "@/lib/google";

/** Starts Google sign-in: sends the browser to Google's consent screen. */
export async function GET(req: Request) {
  if (!googleConfigured()) return NextResponse.redirect(new URL("/login?error=not_configured", req.url));

  // ?consent=1 forces Google to show the consent screen again. The callback asks for
  // this once when Google didn't hand back a refresh token (needed to read Gmail later).
  const params = new URL(req.url).searchParams;
  const forceConsent = params.get("consent") === "1";
  const next = safeNext(params.get("next")); // where to land after signing in

  const client = googleClient();
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync(); // PKCE
  const state = randomToken();

  const res = NextResponse.redirect(
    client.generateAuthUrl({
      access_type: "offline", // asks for a refresh token
      scope: GOOGLE_SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      prompt: forceConsent ? "consent" : "select_account",
    }),
  );

  // Remember state + PKCE verifier for the callback. Signed, so it can't be tampered with;
  // httpOnly, so page scripts can't read it. SameSite=Lax is required: the browser returns
  // from Google via a cross-site redirect, and Strict would drop the cookie.
  // `next` is base64url, so it can't contain the "." separator.
  const payload = `${state}.${codeVerifier}.${forceConsent ? 1 : 0}.${Buffer.from(next).toString("base64url")}`;
  res.cookies.set(TX_COOKIE, sign(payload), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: TX_PATH,
    maxAge: TX_MAX_AGE,
  });
  return res;
}
