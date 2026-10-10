// An instance's schema belongs to (adapter, credential, POSITION).
//
// The live team catalog has always keyed it that way; the SNAPSHOT — the form
// the editor checks against — dropped the position and keyed on the credential
// alone. So a construction that pins an entry position (`google_sheets(…,
// spreadsheet: "LP Commitments")`) resolved to the UNPOSITIONED surface, whose
// leaves deliberately do not exist until a spreadsheet is named. The editor
// then reported a correct program's own table as an unknown edge.
//
// These pin the snapshot to the live catalog's rule, including its fallback.

import type { CatalogSnapshot } from '../snapshot';
import { fromCatalogSnapshot, instanceSchemaKey } from '../snapshot';

import type { InstanceSchema } from '../../checker/catalog';
import { entryPositionKeyOf } from '../../checker/catalog';

const schemaWith = (collection: string): InstanceSchema => ({
  positions: { Row: { properties: {}, edges: {} } },
  collections: { [collection]: { target: 'Row' } },
  writableRoots: {},
});

const UNPOSITIONED = schemaWith('Spreadsheet');
const AT_LP_COMMITMENTS = schemaWith('LPs (table)');

const SPEC = {
  constructionArgs: [
    { name: 'credentials', kind: 'credential' as const, required: true },
    { name: 'spreadsheet', kind: 'position' as const, required: false, optionsFromType: 'Spreadsheet' },
  ],
};

const snapshot = (schemas: Record<string, InstanceSchema>): CatalogSnapshot => ({
  adapters: { google_sheets: { ...SPEC, schemas } },
  credentials: { 'Sheets Probe': { adapters: ['google_sheets'] } },
  plugins: {},
});

describe('entryPositionKeyOf', () => {
  it('is empty for a construction that pins no position', () => {
    expect(entryPositionKeyOf(SPEC, { credentials: 'Sheets Probe' })).toBe('');
  });

  it('ignores the credential and any arg the spec does not declare a position', () => {
    // The credential is already the other half of the key; a non-position arg
    // does not pick a different node, so neither may fork the schema.
    expect(entryPositionKeyOf(SPEC, { credentials: 'A', spreadsheet: '"S"' })).toBe(
      entryPositionKeyOf(SPEC, { credentials: 'B', spreadsheet: '"S"', unknown: 'x' }),
    );
  });

  it('UNQUOTES the authored literal — the key is the value, not its spelling', () => {
    // `spreadsheet: "LP Commitments"` arrives as raw source. The api side keys
    // on the unquoted value; if the two disagree, every positioned lookup misses.
    expect(entryPositionKeyOf(SPEC, { spreadsheet: '"LP Commitments"' })).toBe(
      entryPositionKeyOf(SPEC, { spreadsheet: 'LP Commitments' }),
    );
  });

  it('is order-independent across several position args', () => {
    const spec = {
      constructionArgs: [
        { name: 'base', kind: 'position' as const, required: false },
        { name: 'table', kind: 'position' as const, required: false },
      ],
    };
    expect(entryPositionKeyOf(spec, { base: '"a"', table: '"b"' })).toBe(
      entryPositionKeyOf(spec, { table: '"b"', base: '"a"' }),
    );
  });
});

describe('instanceSchemaKey', () => {
  it('is the bare credential name when no position is pinned — the existing key, unchanged', () => {
    // Every snapshot written before positions existed keys this way; a new
    // dimension must not invalidate them.
    expect(instanceSchemaKey({ credentialName: 'Sheets Probe', positionKey: '' })).toBe(
      'Sheets Probe',
    );
    expect(instanceSchemaKey({ positionKey: '' })).toBe('');
  });

  it('distinguishes two positions of ONE credential', () => {
    const a = instanceSchemaKey({
      credentialName: 'Sheets Probe',
      positionKey: entryPositionKeyOf(SPEC, { spreadsheet: '"LP Commitments"' }),
    });
    const b = instanceSchemaKey({
      credentialName: 'Sheets Probe',
      positionKey: entryPositionKeyOf(SPEC, { spreadsheet: '"Board Pack"' }),
    });
    expect(a).not.toBe(b);
  });
});

describe('fromCatalogSnapshot().instantiate — positioned instances', () => {
  const positionedKey = instanceSchemaKey({
    credentialName: 'Sheets Probe',
    positionKey: entryPositionKeyOf(SPEC, { spreadsheet: '"LP Commitments"' }),
  });

  it('resolves the POSITIONED schema when the construction pins a position', () => {
    const catalog = fromCatalogSnapshot(
      snapshot({ 'Sheets Probe': UNPOSITIONED, [positionedKey]: AT_LP_COMMITMENTS }),
    );
    const schema = catalog.instantiate('google_sheets', {
      credentials: 'Sheets Probe',
      spreadsheet: '"LP Commitments"',
    });
    expect(schema).toBe(AT_LP_COMMITMENTS);
    expect(Object.keys(schema?.collections ?? {})).toEqual(['LPs (table)']);
  });

  it('still resolves the unpositioned schema for a bare construction', () => {
    const catalog = fromCatalogSnapshot(
      snapshot({ 'Sheets Probe': UNPOSITIONED, [positionedKey]: AT_LP_COMMITMENTS }),
    );
    expect(catalog.instantiate('google_sheets', { credentials: 'Sheets Probe' })).toBe(UNPOSITIONED);
  });

  it('falls back to the meta position when the pinned position was never described', () => {
    // Mirrors the LIVE catalog's documented fallback exactly. The two must
    // agree: a rule the editor applies and the compiler does not is the
    // divergence this whole change exists to remove.
    const catalog = fromCatalogSnapshot(snapshot({ 'Sheets Probe': UNPOSITIONED }));
    expect(
      catalog.instantiate('google_sheets', {
        credentials: 'Sheets Probe',
        spreadsheet: '"Never Described"',
      }),
    ).toBe(UNPOSITIONED);
  });

  it('publishes the position arg OPTIONS, so an unseeable value can be warned about', () => {
    // The other half of the same silence: pinning a spreadsheet this connection
    // cannot see falls back to the unpositioned surface. Falling back is fine —
    // saying nothing about it is not, and the checker can only speak if the
    // snapshot carries the option list the live catalog has.
    const withOptions: CatalogSnapshot = {
      ...snapshot({ 'Sheets Probe': UNPOSITIONED }),
      adapters: {
        google_sheets: {
          ...SPEC,
          schemas: { 'Sheets Probe': UNPOSITIONED },
          constructionArgOptions: {
            'Sheets Probe': { spreadsheet: ['LP Commitments', 'Board Pack'] },
          },
        },
      },
    };
    const catalog = fromCatalogSnapshot(withOptions);
    expect(
      catalog.constructionArgOptions?.({
        adapter: 'google_sheets',
        credentialName: 'Sheets Probe',
        arg: 'spreadsheet',
      }),
    ).toEqual(['LP Commitments', 'Board Pack']);
  });

  it('leaves an arg with no published options UNCHECKED rather than mis-warning', () => {
    const catalog = fromCatalogSnapshot(snapshot({ 'Sheets Probe': UNPOSITIONED }));
    expect(
      catalog.constructionArgOptions?.({
        adapter: 'google_sheets',
        credentialName: 'Sheets Probe',
        arg: 'spreadsheet',
      }),
    ).toBeUndefined();
  });

  it('stays UNTYPED when the credential is unresolvable, position or not', () => {
    const catalog = fromCatalogSnapshot(snapshot({ 'Sheets Probe': UNPOSITIONED }));
    expect(
      catalog.instantiate('google_sheets', {
        credentials: 'Other Probe',
        spreadsheet: '"LP Commitments"',
      }),
    ).toBeUndefined();
  });
});
