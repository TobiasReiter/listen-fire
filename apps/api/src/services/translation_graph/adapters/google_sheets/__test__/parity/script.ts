// The calls recorded parity makes, in order, against one Google Sheets
// implementation. Each later call is built from what an earlier one answered,
// so the script walks the seeded spreadsheets the way a run would: the root
// and every type, the Spreadsheet collection and its narrowing, each leaf's
// hop, the table, tab and cell reads, a positioned instance, then every write
// kind. The transcript is every answer, as JSON; two implementations agree
// when their transcripts and the requests they made are identical.
//
// Every call is made on a FRESH adapter. A module served as a process is built
// afresh per request, so nothing an instance memoizes (the cross-grant
// catalog) outlives a call there; making every subject do the same keeps the
// requests comparable across the three.

import type { Expression } from '#shared/expression/types';
import type { Adapter, MutationContext, ParentLink, RelatedResult } from 'movement-engine/public/adapter';
import type { SourcePosition } from 'movement-engine/public/catalog';

import { makeMetaPosition, makeStablePosition, positionData } from 'movement-engine/public/catalog';

export interface ParitySubject {
  /** A fresh adapter for one call; positioned at a granted spreadsheet's
   *  Title when `spreadsheet` is given (the `spreadsheet:` construction arg). */
  adapter(input?: { spreadsheet?: string }): Promise<Adapter> | Adapter;
}

export interface TranscriptEntry {
  step: string;
  answer: unknown;
}

/** The grants the subjects are seeded with, in grant order. `stale-404` is a
 *  grant whose spreadsheet the fake never held (deleted or revoked). */
export const PARITY_GRANTS: ReadonlyArray<{ spreadsheetId: string; name: string }> = [
  { spreadsheetId: 'test-spreadsheet-001', name: 'Pipeline Sheet' },
  { spreadsheetId: 'test-spreadsheet-plain', name: 'Dealflow Log' },
  { spreadsheetId: 'created-2', name: 'Shared Metrics' },
  { spreadsheetId: 'stale-404', name: 'Gone Sheet' },
];

/** The team's primary emails a created spreadsheet is shared with. */
export const PARITY_TEAM_EMAILS: readonly string[] = ['ana@parity.test', 'ben@parity.test'];

export const PARITY_ACCESS_TOKEN = 'parity-google-access-token';

/** Steps expected to fail: the refusals are part of the surface. */
export const REFUSED = 'refused: ';

const ADAPTER = 'google_sheets';
const MUTATION: MutationContext = { source: { type: 'api' }, occurredAt: '2026-10-17T00:00:00.000Z' };

const prop = (name: string): Expression => ({ type: 'property', propertyTypeId: name }) as Expression;
const value = (v: string | number | boolean | null): Expression => ({ type: 'static', value: v }) as Expression;
const eq = (field: string, v: string): Expression => ({ type: 'compare', op: 'eq', left: prop(field), right: value(v) }) as Expression;
const or = (...operands: Expression[]): Expression => ({ type: 'logical', op: 'or', operands }) as Expression;

function json(answer: unknown): unknown {
  return answer === undefined ? null : JSON.parse(JSON.stringify(answer));
}

const spreadsheetPosition = (spreadsheetId: string, title: string): SourcePosition =>
  makeStablePosition({ adapterType: ADAPTER, recordType: 'Spreadsheet', recordId: spreadsheetId, data: { Title: title } });

const under = (spreadsheetId: string, edgeName: string): ParentLink[] => [
  { recordType: 'Spreadsheet', externalId: spreadsheetId, edgeName },
];

const uniqueBy = (...fields: string[]) => ({ any: [{ all: fields.map((field) => ({ field })) }] });

export async function runParityScript(subject: ParitySubject): Promise<TranscriptEntry[]> {
  const transcript: TranscriptEntry[] = [];
  const step = async <T>(name: string, call: (adapter: Adapter) => Promise<T>, at?: { spreadsheet?: string }): Promise<T | undefined> => {
    try {
      const answer = await call(await subject.adapter(at));
      transcript.push({ step: name, answer: json(answer) });
      return answer;
    } catch (error) {
      transcript.push({ step: name, answer: { error: error instanceof Error ? error.message : String(error) } });
      return undefined;
    }
  };
  const meta = makeMetaPosition(ADAPTER);
  const positioned = { spreadsheet: 'Pipeline Sheet' };

  // ── The root and every type ───────────────────────────────────────────────
  await step('listEntryPoints', (a) => a.listEntryPoints());
  for (const type of [
    'Spreadsheet',
    'Pipeline Sheet',
    'Named cell',
    'Cell',
    'Companies (table)',
    'Sheet1 (sheet)',
    'Summary (sheet)',
    'FX_Rate (cell)',
    'Total_ARR (cell)',
    'Nonexistent',
  ]) {
    await step(`describe ${type}`, (a) => a.describe(type));
  }
  await step('edgesFrom meta', async (a) => (await a.edgesFrom?.(meta)) ?? null);

  // ── The Spreadsheet collection and its narrowing ──────────────────────────
  const grants = await step('Spreadsheet collection', (a) =>
    a.getRelated({ position: meta, fieldId: 'Spreadsheet', direction: 'outgoing' }),
  );
  await step('Spreadsheet collection WHERE Title', (a) =>
    a.getRelated({ position: meta, fieldId: 'Spreadsheet', direction: 'outgoing', where: eq('Title', 'Dealflow Log') }),
  );
  await step('unpositioned root, a leaf edge', (a) =>
    a.getRelated({ position: meta, fieldId: 'Companies (table)', direction: 'outgoing' }),
  );
  const landing = (title: string): SourcePosition =>
    grants?.find((g: RelatedResult) => Reflect.get(Object(positionData(g.position)), 'Title') === title)?.position ??
    spreadsheetPosition(PARITY_GRANTS.find((g) => g.name === title)?.spreadsheetId ?? title, title);
  const pipeline = landing('Pipeline Sheet');
  const dealflow = landing('Dealflow Log');
  const metrics = landing('Shared Metrics');

  await step('Pipeline Sheet.Title', (a) => a.getFieldValue({ position: pipeline, fieldId: 'Title' }));
  await step('Pipeline Sheet.Missing', (a) => a.getFieldValue({ position: pipeline, fieldId: 'Missing' }));

  // ── Each spreadsheet's hop, and each leaf's ───────────────────────────────
  const pipelineHop = await step('edgesFrom Pipeline Sheet', async (a) => (await a.edgesFrom?.(pipeline)) ?? null);
  for (const [key, leaf] of Object.entries(pipelineHop?.targetPositions ?? {})) {
    await step(`edgesFrom Pipeline Sheet / ${key}`, async (a) => (await a.edgesFrom?.(leaf)) ?? null);
  }
  const dealflowHop = await step('edgesFrom Dealflow Log', async (a) => (await a.edgesFrom?.(dealflow)) ?? null);
  const tab = dealflowHop?.targetPositions?.['Sheet1 (sheet)'];
  if (tab !== undefined) await step('edgesFrom Dealflow Log / Sheet1 (sheet)', async (a) => (await a.edgesFrom?.(tab)) ?? null);
  await step('edgesFrom Shared Metrics', async (a) => (await a.edgesFrom?.(metrics)) ?? null);
  await step(`${REFUSED}edgesFrom a stale grant`, async (a) => (await a.edgesFrom?.(spreadsheetPosition('stale-404', 'Gone Sheet'))) ?? null);
  await step('edgesFrom an ungranted spreadsheet', async (a) => (await a.edgesFrom?.(spreadsheetPosition('picked-042', 'LP Commitments'))) ?? null);

  // ── Reads off a spreadsheet node ──────────────────────────────────────────
  const read = (name: string, position: SourcePosition, fieldId: string, where?: Expression) =>
    step(name, (a) => a.getRelated({ position, fieldId, direction: 'outgoing', ...(where !== undefined ? { where } : {}) }));
  await read('Pipeline Sheet / Companies (table), empty', pipeline, 'Companies (table)');
  await read('Pipeline Sheet / named cells, unset', pipeline, 'named cells');
  await read('Pipeline Sheet / cells WHERE Cell (one tab, unqualified)', pipeline, 'cells', eq('Cell', 'B6'));
  await read('Pipeline Sheet / cells, no address', pipeline, 'cells');
  await read('Shared Metrics / named cells', metrics, 'named cells');
  await read('ungranted spreadsheet / Companies (table)', spreadsheetPosition('picked-042', 'LP Commitments'), 'LPs (table)');
  await read('Pipeline Sheet / unknown edge', pipeline, 'Nope (table)');
  await step('incoming direction', (a) => a.getRelated({ position: pipeline, fieldId: 'Companies (table)', direction: 'incoming' }));

  // ── A positioned instance (`spreadsheet: "Pipeline Sheet"`) ───────────────
  await step('positioned listEntryPoints', (a) => a.listEntryPoints(), positioned);
  await step('positioned edgesFrom meta', async (a) => (await a.edgesFrom?.(meta)) ?? null, positioned);
  await step('positioned describe Companies (table)', (a) => a.describe('Companies (table)'), positioned);
  await step('positioned root / Companies (table)', (a) => a.getRelated({ position: meta, fieldId: 'Companies (table)', direction: 'outgoing' }), positioned);
  await step('positioned root / named cells', (a) => a.getRelated({ position: meta, fieldId: 'named cells', direction: 'outgoing' }), positioned);
  await step(
    'positioned root / cells WHERE Cell',
    (a) => a.getRelated({ position: meta, fieldId: 'cells', direction: 'outgoing', where: or(eq('Cell', 'Companies!B6'), eq('Cell', 'A1')) }),
    positioned,
  );

  // ── Writes: a spreadsheet (grant and share) ───────────────────────────────
  const created = await step('create Spreadsheet', (a) =>
    a.createRecord({ recordType: 'Spreadsheet', fields: { Title: '  Parity Report ' }, mutationContext: MUTATION }),
  );
  await step(`${REFUSED}create Spreadsheet without a Title`, (a) =>
    a.createRecord({ recordType: 'Spreadsheet', fields: { Title: ' ' }, mutationContext: MUTATION }),
  );
  const createdId = created?.externalId ?? 'created-1';
  await step('resolveEntity Spreadsheet unique by Title', (a) =>
    a.resolveEntity({ recordType: 'Spreadsheet', record: { Title: 'parity report' }, candidates: [], constraints: uniqueBy('Title') }),
  );
  await step('resolveEntity Spreadsheet, no constraints', (a) =>
    a.resolveEntity({ recordType: 'Spreadsheet', record: { Title: 'Parity Report' }, candidates: [], constraints: { any: [] } }),
  );
  await step('updateRecord Spreadsheet (the matched grant)', (a) =>
    a.updateRecord({ recordType: 'Spreadsheet', externalId: createdId, fields: { Title: 'Parity Report' }, mutationContext: MUTATION }),
  );
  await step('readRecord Spreadsheet', async (a) => (await a.readRecord?.({ recordType: 'Spreadsheet', externalId: createdId })) ?? null);
  await step('readRecord an ungranted Spreadsheet', async (a) => (await a.readRecord?.({ recordType: 'Spreadsheet', externalId: 'picked-042' })) ?? null);
  await step('Spreadsheet collection after the create', (a) =>
    a.getRelated({ position: meta, fieldId: 'Spreadsheet', direction: 'outgoing' }),
  );
  await step('edgesFrom the created spreadsheet', async (a) => (await a.edgesFrom?.(spreadsheetPosition(createdId, 'Parity Report'))) ?? null);

  // ── Writes: table rows, unique by ─────────────────────────────────────────
  const table = 'Companies (table)';
  await step('append a table row', (a) =>
    a.createRecord({
      recordType: table,
      fields: { Name: 'Acme', Stage: 'Seed', Domain: 'acme.com', Notes: null, Unknown: 'dropped' },
      parentLinks: under('test-spreadsheet-001', table),
      mutationContext: MUTATION,
    }),
  );
  await step('append a second table row', (a) =>
    a.createRecord({
      recordType: table,
      fields: { Name: 'Beta', Stage: 'Pre-seed', Domain: 'beta.io', Notes: 'warm intro' },
      parentLinks: under('test-spreadsheet-001', table),
      mutationContext: MUTATION,
    }),
  );
  const matched = await step('resolveEntity a table row unique by Name', (a) =>
    a.resolveEntity({ recordType: table, record: { Name: ' ACME ' }, candidates: [], constraints: uniqueBy('Name') }),
  );
  await step('resolveEntity a table row, no match', (a) =>
    a.resolveEntity({ recordType: table, record: { Name: 'Gamma' }, candidates: [], constraints: uniqueBy('Name') }),
  );
  await step('resolveEntity a table row, no constraints', (a) =>
    a.resolveEntity({ recordType: table, record: { Name: 'Acme' }, candidates: [], constraints: { any: [] } }),
  );
  const rowId = matched?.candidates[0]?.externalId ?? 'test-spreadsheet-001:table-companies:2';
  await step('update a table row (unique by)', (a) =>
    a.updateRecord({
      recordType: table,
      externalId: rowId,
      fields: { Stage: 'Series A', Unknown: 'dropped' },
      parentLinks: under('test-spreadsheet-001', table),
      mutationContext: MUTATION,
    }),
  );
  await step(`${REFUSED}update a table row by a bare table id`, (a) =>
    a.updateRecord({ recordType: table, externalId: 'table-companies', fields: { Stage: 'x' }, mutationContext: MUTATION }),
  );
  await step('readRecord a table row', async (a) => (await a.readRecord?.({ recordType: table, externalId: rowId })) ?? null);
  await step('readRecord a row that is not there', async (a) =>
    (await a.readRecord?.({ recordType: table, externalId: 'test-spreadsheet-001:table-companies:99' })) ?? null,
  );
  await read('Pipeline Sheet / Companies (table), after the writes', pipeline, table);
  await step('positioned append a table row', (a) =>
    a.createRecord({ recordType: table, fields: { Name: 'Gamma', Stage: 'Seed' }, mutationContext: MUTATION }), positioned);
  await step(`${REFUSED}append to an unknown table`, (a) =>
    a.createRecord({ recordType: 'Nope (table)', fields: { Name: 'x' }, parentLinks: under('test-spreadsheet-001', 'Nope (table)'), mutationContext: MUTATION }),
  );

  // ── Writes: a tab append ──────────────────────────────────────────────────
  await step('append to a tab', (a) =>
    a.createRecord({
      recordType: 'Sheet1 (sheet)',
      fields: { Timestamp: '2026-10-17T09:00:00Z', Sender: 'ana', Message: 'hello', E: 'by letter', Company: null },
      parentLinks: under('test-spreadsheet-plain', 'Sheet1 (sheet)'),
      mutationContext: MUTATION,
    }),
  );
  await step(`${REFUSED}append to a tab, an unknown column`, (a) =>
    a.createRecord({
      recordType: 'Sheet1 (sheet)',
      fields: { Nope: 'x' },
      parentLinks: under('test-spreadsheet-plain', 'Sheet1 (sheet)'),
      mutationContext: MUTATION,
    }),
  );
  await step(`${REFUSED}append to a tab, a header and its own letter`, (a) =>
    a.createRecord({
      recordType: 'Sheet1 (sheet)',
      fields: { Sender: 'ana', B: 'ben' },
      parentLinks: under('test-spreadsheet-plain', 'Sheet1 (sheet)'),
      mutationContext: MUTATION,
    }),
  );
  await step('resolveEntity a tab (append only)', (a) =>
    a.resolveEntity({ recordType: 'Sheet1 (sheet)', record: { Sender: 'ana' }, candidates: [], constraints: uniqueBy('Sender') }),
  );

  // ── Writes: named cells, cells, named range values ────────────────────────
  await step('name a cell', (a) =>
    a.createRecord({
      recordType: 'Named cell',
      fields: { Name: 'Parity_Cell', Cell: 'Companies!D9' },
      parentLinks: under('test-spreadsheet-001', 'Named Cells'),
      mutationContext: MUTATION,
    }),
  );
  await step(`${REFUSED}name a cell with no spreadsheet (several granted)`, (a) =>
    a.createRecord({ recordType: 'Named cell', fields: { Name: 'Orphan', Cell: 'A1' }, mutationContext: MUTATION }),
  );
  await step(`${REFUSED}name a cell, not an A1 cell`, (a) =>
    a.createRecord({
      recordType: 'Named cell',
      fields: { Name: 'Bad', Cell: 'A1:B2' },
      parentLinks: under('test-spreadsheet-001', 'Named Cells'),
      mutationContext: MUTATION,
    }),
  );
  await step('write a cell', (a) =>
    a.createRecord({
      recordType: 'Cell',
      fields: { Cell: 'Companies!D9', Value: 42 },
      parentLinks: under('test-spreadsheet-001', 'Cells'),
      mutationContext: MUTATION,
    }),
  );
  await step('positioned write a cell, unqualified', (a) =>
    a.createRecord({ recordType: 'Cell', fields: { Cell: 'E3', Value: 'positioned' }, mutationContext: MUTATION }), positioned);
  await step(`${REFUSED}write a cell on an unknown tab`, (a) =>
    a.createRecord({
      recordType: 'Cell',
      fields: { Cell: 'Nope!A1', Value: 1 },
      parentLinks: under('test-spreadsheet-001', 'Cells'),
      mutationContext: MUTATION,
    }),
  );
  await step(`${REFUSED}write a cell without a Value`, (a) =>
    a.createRecord({ recordType: 'Cell', fields: { Cell: 'A1', Value: '' }, parentLinks: under('test-spreadsheet-001', 'Cells'), mutationContext: MUTATION }),
  );
  await step('set a named range value', (a) =>
    a.createRecord({
      recordType: 'FX_Rate (cell)',
      fields: { Value: 1.08 },
      parentLinks: under('test-spreadsheet-001', 'FX_Rate (cell)'),
      mutationContext: MUTATION,
    }),
  );
  await step('set another spreadsheet’s named range value', (a) =>
    a.createRecord({
      recordType: 'Total_ARR (cell)',
      fields: { Value: '1200000' },
      parentLinks: under('created-2', 'Total_ARR (cell)'),
      mutationContext: MUTATION,
    }),
  );
  await step(`${REFUSED}set a named range value without a Value`, (a) =>
    a.createRecord({ recordType: 'FX_Rate (cell)', fields: {}, parentLinks: under('test-spreadsheet-001', 'FX_Rate (cell)'), mutationContext: MUTATION }),
  );
  await step('resolveEntity a named range', (a) =>
    a.resolveEntity({ recordType: 'FX_Rate (cell)', record: { Value: 1 }, candidates: [], constraints: { any: [] } }),
  );
  await step('resolveEntity a cell', (a) => a.resolveEntity({ recordType: 'Cell', record: {}, candidates: [], constraints: { any: [] } }));
  await read('Pipeline Sheet / named cells, after the writes', pipeline, 'named cells');
  await read('Pipeline Sheet / cells WHERE Cell, after the writes', pipeline, 'cells', eq('Cell', 'Companies!D9'));
  await read('Shared Metrics / named cells, after the write', metrics, 'named cells');
  await step(`${REFUSED}deleteRecord`, (a) => a.deleteRecord({ recordType: table, externalId: rowId, mutationContext: MUTATION }));
  return transcript;
}
