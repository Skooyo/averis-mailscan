// Fixed locale and zone so the server render and the browser render agree
// (a locale-dependent format causes hydration mismatches).
const sent = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** "15 Dec 2026, 07:50 UTC", or null when the email has no known sent date. */
export function formatSent(iso: string | null): string | null {
  return iso ? `${sent.format(new Date(iso))} UTC` : null;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago" for a duration in milliseconds. */
export function timeAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
