// Constants and helpers shared by the proxy, the auth routes and the pages.
// Deliberately imports nothing: the proxy bundles this file, and must stay light.

export const SESSION_COOKIE = "session";

// Set when someone picks "Continue with sample data" on the login page, so we stop
// sending them back to it. Just a marker: it grants nothing beyond what any visitor sees.
export const GUEST_COOKIE = "guest";
export const GUEST_MAX_AGE = 30 * 24 * 60 * 60; // seconds

/**
 * A safe place to send someone after they've chosen how to continue: only a path on
 * this site. Anything else (another site, "//host", "/\host", the login page itself,
 * API routes) becomes "/", so a crafted link can't turn login into an open redirect.
 */
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/")) return "/";
  try {
    const url = new URL(value, "http://local.invalid");
    if (url.origin !== "http://local.invalid") return "/";
    if (url.pathname === "/login" || url.pathname.startsWith("/api/")) return "/";
    return url.pathname + url.search;
  } catch {
    return "/";
  }
}
