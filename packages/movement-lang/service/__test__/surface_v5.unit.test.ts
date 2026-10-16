// The editor under language version 5: completion offers, and hover
// explains, the v5 surface (core words, PascalCase namespaces, `&&`, `is`,
// `function`, `connect … using …`), read from the parser's spelling table.
// Walk brackets keep their CAPS words. service.unit.test.ts pins version 4.

import { getHoverInfo, getMovementCompletions } from '../service';
import type { CatalogSnapshot } from '../snapshot';

const snapshot: CatalogSnapshot = {
  adapters: { email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: { positions: {}, collections: {} } } },
  credentials: {},
  plugins: {},
} as unknown as CatalogSnapshot;

const V5 = { languageVersion: 5 } as const;

function labelsAt(text: string): string[] {
  const offset = text.indexOf('¦');
  const source = text.slice(0, offset) + text.slice(offset + 1);
  return getMovementCompletions(source, offset, snapshot, V5).items.map((i) => i.label);
}

function hoverAt(text: string): string {
  const offset = text.indexOf('¦');
  const source = text.slice(0, offset) + text.slice(offset + 1);
  return getHoverInfo(source, offset, snapshot, V5)?.contents.join('\n') ?? '';
}

describe('the editor under language version 5', () => {
  it('a file offers `function`, not `movement`', () => {
    const labels = labelsAt('¦');
    expect(labels).toContain('function');
    expect(labels).not.toContain('movement');
  });

  it('an expression offers core words and namespaces, never a CAPS built-in', () => {
    const labels = labelsAt('function go(t: <text>) {\n  x = t + ¦');
    expect(labels).toEqual(expect.arrayContaining(['map(…)', 'coalesce(…)', 'Text.', 'List.', '!']));
    expect(labels.filter((l) => /^[A-Z_]{2,}[.(]/.test(l) && !l.startsWith('KG_'))).toEqual([]);
    expect(labels).not.toContain('IF');
  });

  it('a namespace offers its members', () => {
    expect(labelsAt('function go(t: <text>) {\n  x = Text.¦')).toEqual(expect.arrayContaining(['upper', 'regexExtract', 'includes']));
  });

  it('a condition offers `&&` and `is`', () => {
    const labels = labelsAt('function go(t: <text>) {\n  if t ¦');
    expect(labels).toEqual(expect.arrayContaining(['&&', '||', 'is']));
    expect(labels).not.toContain('AND');
  });

  it('inside walk brackets the CAPS words stand', () => {
    const labels = labelsAt('function go(t: <text>) {\n  x = crm-[c:Companies WHERE ¦');
    expect(labels).toEqual(expect.arrayContaining(['AND', 'OR']));
  });

  it('an adapter is connected', () => {
    const labels = labelsAt('import { email } from adapters\ninbox = ¦');
    expect(labels).toContain('connect email using …');
  });

  it('hover explains a v5 built-in and the retired keyword', () => {
    expect(hoverAt('function go(t: <text>) {\n  x = Text.up¦per(t)\n}')).toContain('Text.upper(text)');
    expect(hoverAt('function go(t: <text>) {\n  x = ma¦p([t], (s) => s)\n}')).toContain('map(');
    expect(hoverAt('mo¦vement go() {}')).toContain('written `function`');
  });
});
