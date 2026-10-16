// A movement's event parameter typed against an instance the catalog has no
// description of. The host leaves an instance undescribed when its connection
// does not resolve or its system does not answer; nothing then types the
// parameter, and every read off it used to pass unsaid and be null at run
// time — an undescribed position accepting any field.
//
// From version 5 a read or a write off it is refused (MOV_EVENT_UNDESCRIBED) —
// a movement's, a closure's or a library function's parameter; on a check for
// a move up across 5 it is the upgrade warning instead; before 5 it stays
// unsaid. The Rust checker's twin is crates/movement-checker/tests/
// event_undescribed.rs, on the same catalog.

import { parseProgram } from '../../parser/parse';
import { fromCatalogSnapshot, type CatalogSnapshot } from '../../service/snapshot';
import { checkProgram } from '../check';

const MANUAL_UNDESCRIBED = { constructionArgs: [], canFire: true, triggerConfig: [], schemas: {} };
const MANUAL_DESCRIBED = {
  ...MANUAL_UNDESCRIBED,
  schemas: {
    '': {
      positions: { Invocation: { properties: { text: 'text' }, edges: {} } },
      collections: {},
      writableRoots: {},
      eventPosition: 'Invocation',
      eventPositions: [{ position: 'Invocation' }],
    },
  },
};

function check(
  source: string,
  version: number,
  manual: object = MANUAL_UNDESCRIBED,
  options: { upgradingFrom?: number; library?: string } = {},
) {
  const snapshot = { adapters: { manual }, credentials: {}, plugins: {} } as unknown as CatalogSnapshot;
  const library = options.library;
  return checkProgram(parseProgram(source, { languageVersion: version }), fromCatalogSnapshot(snapshot), {
    languageVersion: version,
    ...(options.upgradingFrom !== undefined ? { upgradingFrom: options.upgradingFrom } : {}),
    ...(library !== undefined ? { resolveFile: (path: string) => (path === 'lib/recap' ? { source: library } : undefined) } : {}),
  });
}

const V5 = [
  'import { manual } from adapters',
  'runs = connect manual',
  'function recap(go: <runs-[:Invocation]->>) {',
  '  t = go.`text`',
  '  go-[r:record]-> { fail("${r.`Name`}") }',
  '}',
  'listen to runs {} fire recap',
].join('\n');

const BEFORE_5 = [
  'import { manual } from adapters',
  'runs = manual()',
  'movement recap(go: <runs-[:Invocation]->>) {',
  '  t = go.`text`',
  '  go-[r:record]-> { ERROR("${r.`Name`}") }',
  '}',
  'listen to runs {} fire recap',
].join('\n');

describe('MOV_EVENT_UNDESCRIBED', () => {
  it('refuses a field read and a walk off an undescribed event from version 5, each where it is', () => {
    const found = check(V5, 5);
    expect(found.map(d => [d.code, d.severity, d.span.start.line])).toEqual([
      ['MOV_EVENT_UNDESCRIBED', undefined, 4],
      ['MOV_EVENT_UNDESCRIBED', undefined, 5],
    ]);
    expect(found[0].message).toBe(
      "'runs-[:Invocation]->' has no description in the catalog, so a read or write off 'go' can't be checked — it would be null at run time. "
        + "The catalog describes it from the system behind 'runs': check that its connection resolves and the system answers, then check again.",
    );
  });

  it.each([1, 2, 3, 4])('says nothing under version %i, as before', version => {
    expect(check(BEFORE_5, version)).toEqual([]);
  });

  it.each([3, 4])('is the upgrade warning on a check for a move up from %i, which holds the pin', from => {
    const found = check(V5, 5, MANUAL_UNDESCRIBED, { upgradingFrom: from });
    expect(found.map(d => [d.code, d.severity, d.upgrade])).toEqual([
      ['MOV_EVENT_UNDESCRIBED', 'warning', true],
      ['MOV_EVENT_UNDESCRIBED', 'warning', true],
    ]);
    expect(found[0].message).toBe(
      "since \"Dancing Wren\" (5) a read or write off 'go' is refused while 'runs-[:Invocation]->' has no description in the catalog; before, it read null. "
        + "The catalog describes it from the system behind 'runs': check that its connection resolves and the system answers, then upgrade.",
    );
  });

  it("refuses a read off a closure's parameter typed as the event", () => {
    const source = [
      'import { manual } from adapters',
      'runs = connect manual',
      'function recap(n: <number>) {',
      '  subject = (go: <runs-[:Invocation]->>) => go.`text`',
      '  return n',
      '}',
    ].join('\n');
    expect(check(source, 5).map(d => [d.code, d.span.start.line])).toEqual([['MOV_EVENT_UNDESCRIBED', 4]]);
  });

  it("refuses a read off a library function's parameter, reported at the import", () => {
    const library = [
      'import { manual } from adapters',
      'runs = connect manual',
      'export function recap(go: <runs-[:Invocation]->>) {',
      '  return go.`text`',
      '}',
    ].join('\n');
    const source = ['import { recap } from "lib/recap"', 'x = 1'].join('\n');
    const found = check(source, 5, MANUAL_UNDESCRIBED, { library });
    expect(found.map(d => d.code)).toEqual(['MOV_EVENT_UNDESCRIBED']);
    expect(found[0].message).toMatch(/^"lib\/recap" line 4: /);
  });

  it('is silent when the catalog describes the event', () => {
    expect(check(V5, 5, MANUAL_DESCRIBED).map(d => d.code)).not.toContain('MOV_EVENT_UNDESCRIBED');
  });

  it('is silent on a parameter nothing reads off', () => {
    const source = V5.replace('  t = go.`text`\n  go-[r:record]-> { fail("${r.`Name`}") }\n', '  return go\n');
    expect(check(source, 5).map(d => d.code)).not.toContain('MOV_EVENT_UNDESCRIBED');
  });

  it('leaves an adapter the catalog does not know to its own error', () => {
    const source = V5.replaceAll('manual', 'nope');
    expect(check(source, 5).map(d => d.code)).not.toContain('MOV_EVENT_UNDESCRIBED');
  });
});
