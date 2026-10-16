// The upgrade loop (checker/upgrade.ts): a program's text moved to version 5
// by its own fixes, with nothing outside the rewritten spans touched.

import { mockCatalog, type InstanceSchema } from '../catalog';
import { checkProgram, diagnosticSeverity, type Diagnostic } from '../check';
import { parseProgram } from '../../parser/parse';
import { mockCatalogSnapshot } from '../../service/snapshot';
import { checkSourceInRust } from '../rust_checker';
import { rustCheck, spellingCheck, typescriptCheck, unifiedDiff, upgradeSource, type UpgradeCheck } from '../upgrade';

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
  it('applies the safe fixes and holds the one not proved to keep the meaning', () => {
    const upgraded = upgradeSource(V4, checked);
    expect(upgraded.source).toContain('ISNULL(first(names))');
    expect(upgraded.held.map((d) => d.code)).toEqual(['MOV_V5_SPELLING']);
    expect(upgraded.held[0]?.message).toContain('ISNULL');
  });

  it('rewrites every old spelling and checks clean under 5, every fix applied when asked', () => {
    const upgraded = upgradeSource(V4, checked, { all: true });
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
    expect(upgradeSource(V4, spellingCheck(), { all: true }).source).toBe(upgradeSource(V4, checked, { all: true }).source);
  });

  it('keeps comments, blank lines and spacing outside the rewritten spans byte for byte', () => {
    const before = V4.split('\n');
    const after = upgradeSource(V4, checked, { all: true }).source.split('\n');
    expect(after).toHaveLength(before.length);
    for (const i of [0, 1, 3, 5, 12, 13]) expect(after[i]).toBe(before[i]);
    expect(after[2]!.endsWith('    # the   workspace')).toBe(true);
  });

  it('changes nothing in a program already in the version 5 surface', () => {
    const once = upgradeSource(V4, checked, { all: true }).source;
    const again = upgradeSource(once, checked);
    expect(again).toEqual({ source: once, changed: false, applied: 0, remaining: [], settled: true, held: [] });
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

// A rewrite keeps the program's meaning: the upgraded text, checked under 5,
// says what the original said under 4 — the same refusals, by code — in both
// checkers, and reads into the tree the original did.
describe('a rewritten program means what it meant', () => {
  const crm: InstanceSchema = {
    positions: { company: { properties: { name: 'text' }, edges: {} } },
    collections: { companies: { target: 'company' } },
    writableRoots: { company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } } },
  };
  const spec = {
    adapters: { attio: { constructionArgs: [{ name: 'credentials', kind: 'credential' as const, required: true }], schema: crm } },
    credentials: { crm_cred: { adapter: 'attio' } },
    plugins: {
      lookup: {
        args: ['q', 'limit'],
        argTypes: { q: 'text' as const, limit: 'number' as const },
        requiredArgs: ['q'],
        output: { kind: 'value' as const, type: 'text' as const },
      },
    },
  };
  const catalog = mockCatalog(spec);
  const snapshot = mockCatalogSnapshot(spec);
  const program = (body: string): string =>
    `import { attio } from adapters
import { crm_cred } from credentials
import { lookup } from plugins
crm = attio(credentials: crm_cred)
movement m(x: <text>) {
${body}
}
`;
  const errorCodes = (diagnostics: Diagnostic[]): string[] =>
    diagnostics.filter((d) => diagnosticSeverity(d) === 'error').map((d) => d.code);
  const underTs = (source: string, version: 4 | 5): string[] =>
    errorCodes(checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version }));
  const underRust = (source: string, version: 4 | 5): string[] => errorCodes(checkSourceInRust(source, snapshot, { languageVersion: version }));

  /** The upgrade in both checkers: one text, its refusals unchanged. */
  const roundTrip = (body: string): string => {
    const source = program(body);
    const ts = upgradeSource(source, typescriptCheck({ catalog, upgradingFrom: 4 }));
    const rust = upgradeSource(source, rustCheck({ snapshot, upgradingFrom: 4 }));
    expect(rust.source).toBe(ts.source);
    expect(ts.held).toEqual([]);
    expect(underTs(ts.source, 5)).toEqual(underTs(source, 4));
    expect(underRust(rust.source, 5)).toEqual(underRust(source, 4));
    return ts.source;
  };

  it("puts a through stage's plugin arguments in position, its settings last", () => {
    const upgraded = roundTrip(`  found = extract from [x] {
    name: "the name"
  } through [lookup(q: name, limit: 2)] {
    round: "the round"
  } through [lookup(q: x)] { detail: "more" }`);
    expect(upgraded).toContain('through [lookup(name, { limit: 2 })]');
    expect(upgraded).toContain('through [lookup(x)]');
  });

  it("keeps a record's AT refusal: AT(h, \"name\") is h[\"name\"], never the field read h.name", () => {
    const body = `  h = write crm-[:companies]-> { name: "Acme" }
  t = AT(h, "name")`;
    expect(underTs(program(body), 4)).toEqual(['MOV_AT_RECORD_KEY']);
    expect(roundTrip(body)).toContain('t = h["name"]');
  });

  it('indexes a conditional or a sum in parentheses, which parses', () => {
    const upgraded = roundTrip(`  d = { name: "a" }
  e = { name: "b" }
  a = AT(IF LENGTH(x) > 1 THEN d ELSE e END, "name")
  b = AT([1] + [2], 0)
  c = AT(COALESCE(d, e), "name")`);
    expect(upgraded).toContain('a = (Text.length(x) > 1 ? d : e)["name"]');
    expect(upgraded).toContain('b = ([1] + [2])[0]');
    expect(upgraded).toContain('c = coalesce(d, e)["name"]');
  });
});

describe('which fixes one pass takes', () => {
  const at = (line: number, col: number) => ({ line, col });
  const fixed = (from: [number, number], to: [number, number], text: string, extra?: Partial<Diagnostic>): Diagnostic => ({
    code: 'MOV_TEST',
    message: 'test',
    span: { start: at(...from), end: at(...to) },
    fix: { edits: [{ span: { start: at(...from), end: at(...to) }, text }], safe: true },
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
        safe: true,
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
