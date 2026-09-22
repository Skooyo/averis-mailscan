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

/**
 * Orders two email ids. The sample dataset's ids are "email_NNN" -- compared as the number, so
 * "email_7" sorts before "email_100" rather than after it as plain text would. A real Gmail
 * message id (a hex string, no such number) falls back to a plain string comparison; mixing the
 * two schemes has no single "correct" order, so numbered ids simply sort before hex ones.
 */
export function compareEmailId(a: string, b: string, ascending: boolean): number {
  const numOf = (id: string) => (/^email_(\d+)$/.exec(id) ? Number(/^email_(\d+)$/.exec(id)![1]) : null);
  const [na, nb] = [numOf(a), numOf(b)];
  const cmp = na !== null && nb !== null ? na - nb : na !== null ? -1 : nb !== null ? 1 : a.localeCompare(b);
  return ascending ? cmp : -cmp;
}
