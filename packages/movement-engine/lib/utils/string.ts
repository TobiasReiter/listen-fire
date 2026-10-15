function toTitleCase(words: string): string {
  /* Transforms to Title Case
  For example:
    - snake_case -> Snake Case
    - WhatEVER word -> Whatever Word
  */
  return words.replaceAll('_', ' ').replace(/\w\S*/g, (word) => {
    return word.charAt(0).toUpperCase() + word.substring(1).toLowerCase();
  });
}

function customJoin(
  a: string[],
  options: { sep?: string; finalSep?: string } = { sep: undefined, finalSep: undefined },
) {
  const { sep, finalSep } = options;
  if (finalSep && a.length > 1) {
    return a.slice(0, a.length - 2).join(sep) + finalSep + a.slice(a.length - 1);
  }
  return a.join(sep);
}

function startCase(str: string) {
  return str
    .split(/[ _]/)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Resolve a candidate to its canonical spelling within an allowed option set:
 * exact match first, then case-insensitive (whitespace-trimmed). Returns
 * undefined when nothing matches. Shared by movement-engine extraction
 * validation and the Attio select/status write path so the two never drift on
 * what a near-miss resolves to — or that it drops.
 */
function matchOption(candidate: unknown, options: readonly string[]): string | undefined {
  if (typeof candidate !== 'string') return undefined;
  const trimmed = candidate.trim();
  const exact = options.find((option) => option === trimmed);
  if (exact !== undefined) return exact;
  const lowered = trimmed.toLowerCase();
  return options.find((option) => option.toLowerCase() === lowered);
}

/**
 * A lowercase, hyphen-separated form of `text`, safe for a URL path segment.
 *
 * Lives here rather than in `file_generation` (its first home) because a
 * company's `slug` is minted on the REST create path, and that module pulls in
 * OpenAI, jsPDF, ExcelJS and the adapter registry — far too much to drag into
 * a request for five lines of string work.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

export { toTitleCase, customJoin, startCase, matchOption, slugify };
