// The run host's units (`cron`, `manual`): from version 5 in every file's
// scope, connected, with no import; before it, imported and constructed as any
// adapter. The Rust checker's twin is crates/movement-checker/tests/units.rs,
// on the same catalog.

import { parseProgram } from '../../parser/parse';
import { fromCatalogSnapshot, type CatalogSnapshot } from '../../service/snapshot';
import { checkProgram } from '../check';

const CATALOG = {
  adapters: {
    cron: {
      constructionArgs: [],
      canFire: true,
      triggerConfig: ['schedule', 'timezone'],
      triggerConfigRequired: ['schedule'],
      triggerConfigFormats: { schedule: 'cron', timezone: 'timezone' },
      schemas: { '': { positions: { Tick: { properties: { 'Fired at': 'date' }, edges: {} } }, collections: {}, writableRoots: {}, eventPosition: 'Tick', eventPositions: [{ position: 'Tick' }] } },
    },
    manual: {
      constructionArgs: [],
      canFire: true,
      schemas: { '': { positions: { Invocation: { properties: { Text: 'text' }, edges: {} } }, collections: {}, writableRoots: {}, eventPosition: 'Invocation', eventPositions: [{ position: 'Invocation' }] } },
    },
  },
  credentials: {},
  plugins: {},
} as unknown as CatalogSnapshot;

function check(source: string, version: number) {
  return checkProgram(parseProgram(source, { languageVersion: version }), fromCatalogSnapshot(CATALOG), { languageVersion: version });
}

const codes = (source: string, version: number) => check(source, version).map((d) => d.code);

const UNITS = [
  'function hello(run: <manual-[:Invocation]->>) {',
  '  return run.`Text`',
  '}',
  'listen to manual fire hello',
  'function digest(t: <cron-[:Tick]->>) {',
  '  return t.`Fired at`',
  '}',
  'listen to cron { schedule: "0 9 * * 1" } fire digest',
  '',
].join('\n');

describe('the run host units', () => {
  it('need no import from version 5', () => {
    expect(codes(UNITS, 5)).toEqual([]);
  });

  it('are typed as their adapter describes them', () => {
    expect(codes(UNITS.replace('run.`Text`', 'run.`Txt`'), 5)).toEqual(['MOV_UNKNOWN_PROPERTY']);
    expect(codes(UNITS.replace(' { schedule: "0 9 * * 1" }', ''), 5)).toEqual(['MOV_LISTEN_BAD_CONFIG']);
  });

  it("leave a file's own import and connection of one, and a name that hides one, checking as before", () => {
    const source = 'import { manual } from adapters\nruns = connect manual\nfunction hello(run: <runs-[:Invocation]->>) {\n  return run.`Text`\n}\nlisten to runs fire hello\n';
    expect(codes(source, 5)).toEqual([]);
    expect(codes('function hello(manual: <number>) {\n  return manual\n}\n', 5)).toEqual([]);
  });

  it('tell a connection of one to listen to it by name', () => {
    const found = check('runs = connect manual\n', 5);
    expect(found.map((d) => d.code)).toEqual(['MOV_CONSTRUCT_NOT_ADAPTER']);
    expect(found[0].message).toContain("one of the run host's units");
  });

  it('are imported and constructed before version 5', () => {
    expect(codes('movement hello(run: <manual-[:Invocation]->>) {\n  x = 1\n}\nlisten to manual {} fire hello\n', 4).length).toBeGreaterThan(0);
    const source = 'import { manual } from adapters\nruns = manual()\nmovement hello(run: <runs-[:Invocation]->>) {\n  x = run.`Text`\n}\nlisten to runs {} fire hello\n';
    expect(codes(source, 4)).toEqual([]);
  });
});
