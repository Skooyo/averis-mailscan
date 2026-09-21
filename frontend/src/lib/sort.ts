/**
 * Orders two inbox emails by when they were sent. Emails without a date (the sample data has
 * none) always go last, whichever direction is chosen, and keep their existing relative order
 * because this returns 0 for them (Array.prototype.sort is stable).
 */
export function compareBySent(a: { sentAt: string | null }, b: { sentAt: string | null }, newestFirst: boolean): number {
  const x = a.sentAt ? Date.parse(a.sentAt) : NaN;
  const y = b.sentAt ? Date.parse(b.sentAt) : NaN;
  if (Number.isNaN(x) && Number.isNaN(y)) return 0;
  if (Number.isNaN(x)) return 1;
  if (Number.isNaN(y)) return -1;
  return newestFirst ? y - x : x - y;
}
