// The conceptual-documentation contract shared by the two layers that meet
// over it: an adapter declares a section on its manifest
// (services/translation_graph/adapter.ts), and the handbook registry
// (lib/knowledge/movement_handbook) assembles the declared sections into the
// automation book. It lives below both so the manifest never has to import
// the handbook, nor the handbook own anything adapter-specific.

/**
 * A machine-checkable claim a chapter's prose makes about what the
 * engine runs. The lockstep test
 * (knowledge/movement_handbook/__test__/engine_claims.unit.test.ts) runs
 * the engine's own static interpretability scan
 * (services/movement_engine/interpretable.ts — the same gate every save
 * uses) over `probe`:
 *
 *   - 'runs'    — the scan must pass the probe clean; the test fails if
 *                 the construct returns to the unsupported list while
 *                 the chapter still says it works;
 *   - 'pending' — the scan must flag the probe with `flag`; the test
 *                 fails the moment an engine lift stops flagging it —
 *                 gap-closure cannot forget the docs.
 */
export type EngineClaim =
  | {
      construct: string;
      status: 'runs';
      probe: string;
      /** Library files the probe imports by path (`import { f } from "lib/x"`),
       *  keyed by that path, so the checker can resolve them as a save would. */
      files?: Readonly<Record<string, string>>;
    }
  | {
      construct: string;
      status: 'pending';
      probe: string;
      /** Substring of the construct label `listUnsupportedConstructs` reports. */
      flag: string;
    };

/**
 * What an author should know about a system BEFORE instantiating it — its
 * idioms, the choice between two approaches, the behaviour that surprises.
 * A distinct tier from `authoringHints` (post-instantiation, per-instance)
 * and from field/edge descriptions (point-of-use): this is prose the author
 * reads while deciding what to build.
 *
 * Assembled as a chapter of the automation handbook, so it is bound by the
 * same contract as every other chapter — consumer-neutral prose, no internal
 * vocabulary, and every runnable example backed by a probe the checker
 * validates against the captured adapter catalog.
 */
export interface HandbookSection {
  /** Chapter title, as the handbook index lists it. */
  title: string;
  /** Full section body, same register as a handbook chapter. */
  content: string;
  /** Runnable examples the engine gate and the checker hold to account. */
  engineClaims?: EngineClaim[];
}

// ── Section addressing ──────────────────────────────────────────────────────
//
// A chapter body is markdown whose `###` headings are already how the intent
// index points at a rule ("writes §identity"). These make that anchor a
// FETCHABLE unit, so needing one rule costs one section rather than a whole
// chapter. Generic over any book's chapters — nothing here knows about
// automations.

/** `chapter` or `chapter#section` — the address an index entry routes to, and
 *  the exact string a reader hands back to fetch it. */
export function chapterRoute(entry: { chapter: string; section?: string }): string {
  return entry.section ? `${entry.chapter}#${entry.section}` : entry.chapter;
}

/** Split a `chapter#section` address. A bare chapter id yields no section. */
export function splitChapterRoute(route: string): { chapter: string; section?: string } {
  const hash = route.indexOf('#');
  if (hash === -1) return { chapter: route };
  return { chapter: route.slice(0, hash), section: route.slice(hash + 1) };
}

const HEADING = /^###\s+(.*\S)\s*$/;
/** A heading may carry an explanatory tail after a dash; the id is what
 *  precedes it, which is what the intent index and the agent quote. */
const TAIL = /\s+[—–-]\s+.*$/;

/** The addressable id of a `### ` heading line's text. */
function headingId(heading: string): string {
  return heading.replace(TAIL, '');
}

/** Every section id in a chapter body, in source order. Empty when the
 *  chapter has no `###` headings at all (a body served whole). */
export function listChapterSections(content: string): string[] {
  return content
    .split('\n')
    .flatMap((line) => {
      const m = HEADING.exec(line);
      return m ? [headingId(m[1])] : [];
    });
}

/**
 * One section of a chapter body: its heading line through the line before
 * the next `##`/`###` heading (or the end).
 *
 * Matching is by section id — the heading text up to any " — tail" — case
 * insensitive, and a request also matches a heading it is a prefix of, so
 * `suppress_self` reaches "### suppress_self — two-way sync without the echo".
 */
export function sliceChapterSection(
  content: string,
  section: string,
): { ok: true; section: string; content: string } | { ok: false; error: string } {
  const lines = content.split('\n');
  const wanted = section.trim().toLowerCase();
  const headings = lines.flatMap((line, i) => {
    const m = HEADING.exec(line);
    return m ? [{ index: i, id: headingId(m[1]) }] : [];
  });
  if (headings.length === 0) {
    return { ok: false, error: 'This chapter has no sections — read it whole.' };
  }
  const at =
    headings.find((h) => h.id.toLowerCase() === wanted) ??
    headings.find((h) => h.id.toLowerCase().startsWith(wanted));
  if (!at) {
    return {
      ok: false,
      error: `No section "${section}" here. Sections: ${headings.map((h) => h.id).join(', ')}.`,
    };
  }
  let end = lines.length;
  for (let i = at.index + 1; i < lines.length; i++) {
    if (/^#{2,3}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { ok: true, section: at.id, content: lines.slice(at.index, end).join('\n').trimEnd() };
}
