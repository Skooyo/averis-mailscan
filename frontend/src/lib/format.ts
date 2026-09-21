// Fixed locale and zone so the server render and the browser render agree
// (a locale-dependent format causes hydration mismatches).
const sent = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** "15 Dec 2026, 07:50 UTC", or null when the email has no known sent date. */
export function formatSent(iso: string | null): string | null {
  return iso ? `${sent.format(new Date(iso))} UTC` : null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
