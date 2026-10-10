// The handbook's front page: short enough to read on every build, held to
// the prose contract, and every anchor a diagnostic names resolves to it.
// Its examples are checked with the chapters' (handbook.unit.test.ts and
// engine_claims.unit.test.ts take `frontPageClaims()` alongside them).

import { HANDBOOK_POINTERS, HANDBOOK_POINTER_BY_CODE } from 'movement-lang';
import { readBook } from '../../library';
import { CONCEPTS, TS_EXCEPT, exampleProgram, frontPageClaims, frontSection, renderFrontPage } from '../front_page';
import { proseViolations } from './prose_rules';

/** The page is read on every build; past this it stops being a front page. */
const WORD_CEILING = 800;

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

describe('the front page', () => {
  const page = renderFrontPage();

  it(`stays under ${WORD_CEILING} words`, () => {
    expect(words(page)).toBeLessThanOrEqual(WORD_CEILING);
  });

  it('holds the prose contract — it may name the tools of the build loop, and nothing else is relaxed', () => {
    const asChapter = { id: 'foundations' as const, title: 'Front page', content: page };
    expect(proseViolations(asChapter, { agentFacing: true })).toEqual([]);
  });

  it('only shows examples that are checked', () => {
    const shown = [...TS_EXCEPT, ...CONCEPTS].filter((e) => e.example !== undefined).length;
    expect(frontPageClaims()).toHaveLength(shown);
    // A whole-file example is shown exactly as checked; every other one is
    // checked inside the prelude the page leaves unsaid.
    for (const entry of [...TS_EXCEPT, ...CONCEPTS]) {
      if (entry.example === undefined) continue;
      const probe = exampleProgram(entry.example);
      if ('file' in entry.example) expect(page).toContain(probe.trimEnd());
      else expect(page).not.toContain(probe);
    }
  });

  it('carries every concept with no TypeScript analogue', () => {
    expect(CONCEPTS.map((c) => c.anchor)).toEqual(['systems', 'graph-and-paths', 'identity', 'extraction', 'runs']);
  });

  it('answers each anchor alone, and names the real ones for an unknown one', () => {
    for (const entry of [...TS_EXCEPT, ...CONCEPTS]) {
      const section = frontSection(entry.anchor);
      expect(section.ok).toBe(true);
      if (section.ok) expect(section.content).toContain(entry.title);
    }
    const missing = frontSection('nope');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('maybe-absent');
  });
});

describe('diagnostics point at a section that exists', () => {
  const anchors = [...new Set([...Object.values(HANDBOOK_POINTERS), ...Object.values(HANDBOOK_POINTER_BY_CODE)])];

  it.each(anchors.flatMap((anchor) => [false, true].map((frontPageInsteadOfChapters) => [anchor, frontPageInsteadOfChapters] as const)))(
    '%s resolves through the handbook (front page instead of chapters: %s)',
    (anchor, frontPageInsteadOfChapters) => {
      const read = readBook({ bookId: 'automations', chapter: anchor, frontPageInsteadOfChapters }) as { content?: string; error?: string };
      expect(read.error).toBeUndefined();
      expect(read.content?.length ?? 0).toBeGreaterThan(40);
    },
  );
});
