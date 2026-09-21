/**
 * Some emails have their line breaks written out as the two characters "\n" (for example text
 * copied out of a JSON file and pasted into a message), with the mail client's own line wrapping
 * on top. When a body looks like that, this turns the escapes back into real line breaks and
 * drops the client's wrapping (those real newlines are not paragraph breaks, so they become spaces).
 *
 * It is deliberately cautious, because a literal "\n" can be genuine ("C:\new\notes.txt", code).
 * The body is left exactly as it is unless ALL of these hold:
 *   - it contains at least two "\n" escapes,
 *   - it has no real blank lines (a genuine multi-paragraph email would),
 *   - fewer than half of the escapes are followed by a lowercase letter (as in "\notes" or "\new").
 */
export function unescapeNewlines(text: string): string {
  const escapes = text.match(/\\r\\n|\\n/g) ?? [];
  if (escapes.length < 2) return text;
  if (/\n[ \t]*\r?\n/.test(text)) return text;
  const looksLikePath = (text.match(/\\n(?=[a-z])/g) ?? []).length;
  if (looksLikePath >= escapes.length / 2) return text;

  return text
    .replace(/\r?\n/g, " ") // the client's own wrapping
    .replace(/\\r\\n|\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/[ \t]+\n/g, "\n") // no trailing spaces left at the end of lines
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}
