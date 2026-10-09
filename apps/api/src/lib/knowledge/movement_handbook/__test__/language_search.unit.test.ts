// The language search: generated from the standard library so it cannot
// drift, ranked plainly, and every anchor it hands out readable in the lean
// handbook (where whole chapters are not).

import { standardLibrary } from 'movement-lang';

import { readBook } from '../../library';
import { exampleText } from '../front_page';
import {
  CONTROL_FORMS,
  MAX_RESULTS,
  builtinSignature,
  languageIndex,
  searchLanguage,
  searchableBuiltins,
} from '../language_search';
import { proseViolations } from './prose_rules';

const index = languageIndex();
const top = (query: string, kind?: 'function' | 'concept' | 'recipe') =>
  searchLanguage({ query, ...(kind ? { kind } : {}) }).results.map((r) => r.name);

describe('built-ins come from the registry', () => {
  it('every documented registry function has an entry carrying its generated signature', () => {
    for (const builtin of searchableBuiltins()) {
      const entry = index.find((e) => e.kind === 'function' && e.name === builtin.name);
      if (!entry) throw new Error(`the standard library's ${builtin.name} has no search entry`);
      expect(entry.detail).toBe(builtinSignature(builtin));
      expect(entry.purpose).toBe(builtin.summary);
    }
  });

  it('leaves out only what the registry marks retired', () => {
    const left = standardLibrary().filter((b) => !searchableBuiltins().includes(b));
    expect(left.length).toBeGreaterThan(0);
    for (const b of left) expect(b.summary).toMatch(/^RETIRED/);
    for (const b of left) expect(index.some((e) => e.name === b.name)).toBe(false);
  });

  it('a built-in with a section of its own borrows its example from it', () => {
    const join = index.find((e) => e.name === 'JOIN');
    expect(join?.anchor).toBe('builtins#JOIN');
    expect(join?.example).toMatch(/JOIN\(/);
  });
});

describe('ranking', () => {
  it('finds a built-in by what it does', () => {
    expect(top('join text').slice(0, 2)).toContain('JOIN');
  });

  it('finds a built-in by name, whatever its case', () => {
    expect(top('coalesce')[0]).toBe('COALESCE');
    expect(top('format_figure')[0]).toBe('CURRENCY.FORMAT_FIGURE');
  });

  it('answers "update or create a record" with identity', () => {
    expect(top('update or create a record').slice(0, 2)).toContain('A write creates or updates, by identity');
  });

  it('answers a TypeScript habit with the place it misleads', () => {
    expect(top('undefined optional chaining', 'concept')[0]).toBe('Absent, not undefined');
  });

  it('finds the control forms the grammar owns', () => {
    expect(top('wait for an approval or a timeout')).toContain('race');
  });

  it('finds a recipe, and a system by name', () => {
    expect(top('scheduled digest', 'recipe')[0]).toBe('patterns#scheduled-digest');
    expect(top('slack').some((name) => name.startsWith('system:slack'))).toBe(true);
  });

  it('filters by kind, caps the results, and is deterministic', () => {
    const results = searchLanguage({ query: 'text', kind: 'function' }).results;
    expect(results.length).toBeLessThanOrEqual(MAX_RESULTS);
    for (const r of results) expect(r.kind).toBe('function');
    expect(top('text')).toEqual(top('text'));
  });

  it('says so when nothing matches', () => {
    const r = searchLanguage({ query: 'the of and' });
    expect(r.results).toEqual([]);
    expect(r.note).toMatch(/Nothing matched/);
  });
});

describe('what the search hands out', () => {
  it('every anchor reads with the front page instead of chapters', () => {
    const anchors = [...new Set(index.flatMap((e) => (e.anchor ? [e.anchor] : [])))];
    for (const anchor of anchors) {
      const read = readBook({ bookId: 'automations', chapter: anchor, frontPageInsteadOfChapters: true }) as { content?: string };
      if (!read.content) throw new Error(`${anchor} does not read with the front page instead of chapters: ${JSON.stringify(read)}`);
    }
  });

  it('the control forms it writes itself hold the prose contract', () => {
    for (const form of CONTROL_FORMS) {
      const asChapter = {
        id: 'reference' as const,
        title: form.name,
        content: `${form.purpose}\n\n${form.signature}\n\n\`\`\`\n${exampleText(form.example)}\n\`\`\``,
      };
      expect(proseViolations(asChapter)).toEqual([]);
    }
  });
});
