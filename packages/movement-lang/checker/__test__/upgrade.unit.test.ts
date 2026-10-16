// The upgrade loop (checker/upgrade.ts): a program's text moved to version 5
// by its own fixes, with nothing outside the rewritten spans touched.

import { mockCatalog, type InstanceSchema } from '../catalog';
import type { Diagnostic } from '../check';
import { spellingCheck, typescriptCheck, unifiedDiff, upgradeSource, type UpgradeCheck } from '../upgrade';

const chatSchema: InstanceSchema = {
  positions: {
    channel: {
      properties: { Name: 'text' },
      edges: { Messages: { target: 'message', readable: true, sequenced: 'chronological' } },
    },
    message: { properties: { Text: 'text' }, edges: {} },
    note: { properties: { Body: 'text', Count: 'number' }, edges: {} },
  },
  collections: { Channels: { target: 'channel' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { Body: 'text', Count: 'number' }, resultShape: { Body: 'text' }, edges: {} },
  },
};

const catalog = mockCatalog({ adapters: { slack: { constructionArgs: [], schema: chatSchema } } });
const checked = typescriptCheck({ catalog, upgradingFrom: 4 });

const V4 = `# what it does — résumé of the channel 🎉
import { slack } from adapters
chat = slack()    # the   workspace

movement go(c: <chat-[:channel]->>) {
  # every message, upper-cased
  names = MAP(c-[m:Messages]->, (m) => UPPER(TRIM(m.Text)))
  if COUNT(names) > 0 AND NOT ISNULL(FIRST(names)) {
    write chat-[:note]-> { Body: COALESCE(FIRST(names), "none"), Count: ROUND(COUNT(names)) }
  }
  label = IF COUNT(names) > 1 THEN "many — ünïcode" ELSE "one" END
  write chat-[:note]-> { Body: label }
}
`;

describe('upgrading a program to version 5', () => {
  it('rewrites every old spelling and checks clean under 5', () => {
    const upgraded = upgradeSource(V4, checked);
    expect(upgraded.remaining).toEqual([]);
    expect(upgraded.settled).toBe(true);
    expect(upgraded.changed).toBe(true);
    expect(upgraded.source).toBe(`# what it does — résumé of the channel 🎉
import { slack } from adapters
chat = connect slack    # the   workspace

function go(c: <chat-[:channel]->>) {
  # every message, upper-cased
  names = map(c-[m:Messages]->, (m) => Text.upper(Text.trim(m.Text)))
  if (count(names) > 0 && !(first(names) == null)) {
    write chat-[:note]-> { Body: coalesce(first(names), "none"), Count: Number.round(count(names)) }
  }
  label = count(names) > 1 ? "many — ünïcode" : "one"
  write chat-[:note]-> { Body: label }
}
`);
  });

  it('the parse alone rewrites the same spellings, without a catalog', () => {
    expect(upgradeSource(V4, spellingCheck()).source).toBe(upgradeSource(V4, checked).source);
  });

  it('keeps comments, blank lines and spacing outside the rewritten spans byte for byte', () => {
    const before = V4.split('\n');
    const after = upgradeSource(V4, checked).source.split('\n');
    expect(after).toHaveLength(before.length);
    for (const i of [0, 1, 3, 5, 12, 13]) expect(after[i]).toBe(before[i]);
    expect(after[2]!.endsWith('    # the   workspace')).toBe(true);
  });

  it('changes nothing in a program already in the version 5 surface', () => {
    const once = upgradeSource(V4, checked).source;
    const again = upgradeSource(once, checked);
    expect(again).toEqual({ source: once, changed: false, applied: 0, remaining: [], settled: true });
  });

  it('reports what it cannot rewrite by line, against the rewritten text', () => {
    const upgraded = upgradeSource(
      `import { slack } from adapters
chat = slack()

movement go(c: <chat-[:channel]->>) {
  write chat-[:note]-> { Nope: UPPER(c.Name) }
}`,
      checked,
    );
    expect(upgraded.source).toContain('{ Nope: Text.upper(c.Name) }');
    expect(upgraded.remaining.map((d) => [d.code, d.span.start.line])).toEqual([['MOV_WRITE_UNKNOWN_FIELD', 5]]);
  });
});

describe('which fixes one pass takes', () => {
  const at = (line: number, col: number) => ({ line, col });
  const fixed = (from: [number, number], to: [number, number], text: string, extra?: Partial<Diagnostic>): Diagnostic => ({
    code: 'MOV_TEST',
    message: 'test',
    span: { start: at(...from), end: at(...to) },
    fix: { edits: [{ span: { start: at(...from), end: at(...to) }, text }] },
    ...extra,
  });
  /** A check that answers `rounds[i]` on its i-th call, then nothing. */
  const scripted = (rounds: Diagnostic[][]): UpgradeCheck => {
    let call = 0;
    return () => rounds[call++] ?? [];
  };

  it('one repair offered twice is applied once', () => {
    const insert = fixed([1, 1], [1, 1], 'import { x } from plugins\n');
    expect(upgradeSource('a\n', scripted([[insert, { ...insert }]])).source).toBe('import { x } from plugins\na\n');
  });

  it('the outer of two overlapping fixes goes first; the inner one comes round again', () => {
    const outer = fixed([1, 1], [1, 8], 'f(G(x))');
    const inner = fixed([1, 3], [1, 7], 'g(x)');
    const upgraded = upgradeSource('F(G(x))', scripted([[inner, outer], [fixed([1, 3], [1, 7], 'g(x)')]]));
    expect(upgraded.source).toBe('f(g(x))');
    expect(upgraded.applied).toBe(2);
  });

  it('a fix is taken whole or not at all', () => {
    const first = fixed([1, 1], [1, 3], 'XX');
    const both: Diagnostic = {
      ...fixed([1, 2], [1, 3], 'Y'),
      fix: {
        edits: [
          { span: { start: at(1, 2), end: at(1, 3) }, text: 'Y' },
          { span: { start: at(1, 3), end: at(1, 4) }, text: 'Z' },
        ],
      },
    };
    // `both` overlaps `first` in one edit, so neither of its edits applies.
    expect(upgradeSource('abc', scripted([[both, first]])).source).toBe('XXc');
  });

  it('a warning that says nothing about the move is not applied', () => {
    expect(upgradeSource('abc', scripted([[fixed([1, 1], [1, 2], 'X', { severity: 'warning' })]])).changed).toBe(false);
    expect(upgradeSource('abc', scripted([[fixed([1, 1], [1, 2], 'X', { severity: 'warning', upgrade: true })]])).source).toBe('Xbc');
  });

  it('fixes that never settle are reported, not looped on', () => {
    const upgraded = upgradeSource('a', () => [fixed([1, 1], [1, 1], '#')]);
    expect(upgraded.settled).toBe(false);
    expect(upgraded.remaining).toHaveLength(1);
  });
});

describe('the diff an upgrade prints', () => {
  it('is empty for no change, and a unified diff otherwise', () => {
    expect(unifiedDiff({ before: 'a\n', after: 'a\n', path: 'm.mvt' })).toBe('');
    expect(unifiedDiff({ before: 'a\nb\nc\n', after: 'a\nB\nc\n', path: 'm.mvt' })).toBe(
      '--- a/m.mvt\n+++ b/m.mvt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n',
    );
  });
});
