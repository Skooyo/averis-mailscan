import "server-only";
import { OAuth2Client } from "google-auth-library";

export const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
// Identity (who signed in) + read-only Gmail (so the server can import their emails later).
export const GOOGLE_SCOPES = ["openid", "email", "profile", GMAIL_READONLY];

// Short-lived cookie tying the callback to the browser that started sign-in.
export const TX_COOKIE = "oauth_tx";
export const TX_PATH = "/api/auth/google";
export const TX_MAX_AGE = 10 * 60; // seconds

// Must match an "Authorised redirect URI" on the OAuth client in Google Cloud Console exactly.
export const redirectUri = () =>
  process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/api/auth/google/callback";

/** Google sign-in only works when all of these are set; without them the site runs as guest-only. */
export const googleConfigured = () =>
  Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.AUTH_SECRET &&
      process.env.AUTH_SECRET.length >= 32,
  );

export function googleClient() {
  return new OAuth2Client({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: redirectUri(),
  });
}
