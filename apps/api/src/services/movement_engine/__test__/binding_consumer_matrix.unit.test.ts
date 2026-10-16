// The binding × consumer matrix: does the checker agree with the engine at
// every combination of HOW a record was bound and WHAT consumed it?
//
// A CELL is one (binding path, consumer) pair rendered into one small program:
// a fixed skeleton (a run-local `node { entries: <Entry> }` collection seeded
// with two records, an external system holding the same two, an extraction
// that answers them) plus the path's lines binding `x` (one record) or `xs`
// (a list of them), plus the consumer's lines using it. Each cell runs through
// the REAL parse → check → interpreter path and must do exactly one of:
//
//   (a) the checker accepts AND the run yields the expected rows, or
//   (b) the checker refuses with the named diagnostic code — the engine is
//       never reached (`runMovement` throws MOVENG_CHECK/MOVENG_PARSE before
//       the interpreter is built).
//
// A cell expects (b) only where a checker rule documented by its own
// diagnostic says so (`ruledRefusal` in the cells file: a system record's
// field list is not in hand, a record on no edge cannot be updated, a record
// is not a plugin's text argument; and, by version, `expectationBefore`: a
// version-1 map's keys may all miss, so the record one holds may be empty);
// every other cell expects (a).
//
// Accepted-then-thrown is a FAILURE named by its pair; accepted-then-wrong is
// one too. A cell nobody has decided the right answer for is in TRIAGE below
// with the outcome it has today and a TODO: the test pins that outcome, so the
// list cannot rot, and the whole matrix stays visible.
//
// Versions: this file runs under the current language version in the unit
// suite, and under versions 1 and 2 through the engine conformance configs
// (`pnpm test:conformance:v1|v2`), whose setup makes CURRENT_LANGUAGE_VERSION
// that version. A cell whose syntax that version does not have (`since`) is
// skipped there, by name.
//
// To add a binding path or a consumer: add it to binding_consumer_matrix.cells.ts
// (a path says what records it binds and the facts the rules read — on an
// edge, opaque; a consumer says the rows it leaves per record and
// which rule it trips). Every new pairing is generated; run this file under
// each version and either fix the expectation or add a TRIAGE entry.
//
// Set MATRIX_REPORT=<file> to write every cell's outcome as JSON, and
// MATRIX_ONLY=<text> to run only the cells whose name contains it.

// ── Jest module workarounds (mirrors local_record_update.unit.test.ts) ──────

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('movement-engine/services/knowledge_pipeline/output_v3/schemas');

process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_SALT_BASE64 ??= Buffer.alloc(16, 2).toString('base64');
process.env.DATABASE_URL_TEST ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.DATABASE_URL_TEST_READONLY ??=
  'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.SCRAPER_API_KEY ??= 'unit-test-unused';

function mockChainable(): object {
  const handler: ProxyHandler<object> = {
    get(_target: object, prop: string | symbol): unknown {
      if (prop === 'execute') return async () => [];
      if (prop === 'executeTakeFirst') return async () => null;
      if (prop === 'then') return undefined;
      return () => mockChainable();
    },
  };
  return new Proxy({}, handler);
}
jest.mock('../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(() => mockChainable()),
  getAutomationsQb: jest.fn(() => mockChainable()),
  getQb: jest.fn(() => mockChainable()),
  getCoreQb: jest.fn(() => mockChainable()),
}));

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../context', () => ({
  unsafeCurrentContext: () => undefined,
  currentContext: () => ({
    user: undefined,
    runAsync: async <T>(fn: () => Promise<T>) => fn(),
  }),
}));

jest.mock('../../translation_graph/adapters/knowledge_graph', () => ({
  KG_ADAPTER_TYPE: 'kg',
  KG_MANIFEST: {
    adapterType: 'kg',
    displayName: 'Knowledge Graph',
    supportedTriggers: ['mutation'],
    methods: [
      'listEntryPoints', 'describe', 'resolveEntity', 'getDedupRules',
      'getFieldValue', 'getRelated', 'createRecord', 'updateRecord',
      'getPriorMatch', 'recordLink',
    ],
    triggerKinds: ['KG_MUTATION'],
  },
  createKnowledgeGraphAdapter: jest.fn(() => ({ adapterType: 'kg' })),
}));

jest.mock('../../knowledge_pipeline/facts', () => ({
  extractFactsForResource: jest.fn(async () => []),
}));
jest.mock('../../../lib/anthropic', () => ({
  anthropicChat: jest.fn(async () => '{}'),
  anthropicChatDetailed: jest.fn(async () => ({
    text: '{}',
    stopReason: 'end_turn',
    truncated: false,
  })),
  MAX_CHAT_CONTINUATIONS: 5,
}));

import { writeFileSync } from 'node:fs';

import { CURRENT_LANGUAGE_VERSION, fromCatalogSnapshot, type LanguageVersion } from 'movement-lang';
import { spelledFor } from 'movement-lang/checker/__test__/surface_spelling';

import type { ExtractCallLlmInput, ExtractCallLlmResult } from 'movement-engine/services/movement_engine/extraction_call';
import type { MovementTransformInvoker } from 'movement-engine/services/movement_engine/extraction';
import type { CapturedWrite } from 'movement-engine/services/translation_graph/engine/dry_run_adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { tenantIdOf } from 'engine-contracts';
import { makeTestHost } from 'movement-engine/services/movement_engine/test_host';

import { runMovement, runFailureCause, type MovementRunResult } from 'movement-engine/services/movement_engine/run';
import { MovementEngineError } from 'movement-engine/services/movement_engine/errors';
import { containerAssociation, type Adapter } from 'movement-engine/services/translation_graph/adapter';
import { makeStablePosition, positionData, positionRecordId, META_RECORD_TYPE } from 'movement-engine/services/translation_graph/types';
import { ACME, BETA, GAMMA, cellId, cells, expectationAt, row, type Cell, type Rec } from './binding_consumer_matrix.cells';
import { RELAY, SUMMARISE, catalog, programFor } from './binding_consumer_matrix.program';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000088');
const VERSION: LanguageVersion = CURRENT_LANGUAGE_VERSION;

// ── Triage: cells whose right answer nobody has decided ─────────────────────

/** A cell's outcome as the matrix reports it: `ok`, `wrong` (accepted, ran,
 *  yielded other rows), `refused:<codes>`, or `FAIL` (accepted, then threw). */
type Verdict = 'ok' | 'wrong' | `refused:${string}` | 'FAIL';

interface TriageEntry {
  /** Why nobody can say yet what these cells should do — a TODO for whoever
   *  decides. */
  reason: string;
  /** The versions the entry covers; absent ⇒ every version the cells run in. */
  versions?: LanguageVersion[];
  /** What the cells do today; the test fails the moment one does otherwise. */
  observed: Verdict;
  /** `path × consumer`, as the test names them. */
  cells: string[];
}

const TODO = {} as const;

const TRIAGE: TriageEntry[] = [];


// ── Fakes ────────────────────────────────────────────────────────────────────

const SYSTEM_RECORDS: Rec[] = [ACME, BETA];
/** The company a cell's run creates in the system. The system gives it
 *  children of its own (a CRM that files a founder with every company), so a
 *  walk off a write's result reaches the system's records — the case a
 *  serialisation of one must refuse. */
const CREATED: Rec = GAMMA;

/** One field of the data a fake position was minted with. */
function dataField(position: Parameters<typeof positionData>[0], key: string): unknown {
  const data = positionData(position);
  return typeof data === 'object' && data !== null ? Object.entries(data).find(([k]) => k === key)?.[1] : undefined;
}

function systemAdapter(): Adapter {
  let n = 0;
  return {
    adapterType: 'attio',
    supportedTriggers: [] as never[],
    runtimeCapabilities: () => ({ traversal: { incoming: true, edgeProperties: true }, resources: true }),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      return dataField(position, fieldId);
    },
    async getRelated({ position, fieldId }) {
      if (position.recordType === META_RECORD_TYPE && fieldId === 'companies') {
        return SYSTEM_RECORDS.map((r) => ({
          position: makeStablePosition({ adapterType: 'attio', recordType: 'company', recordId: `c-${r.name}`, data: { name: r.name, tag: r.tag } }),
        }));
      }
      if (position.recordType === 'company' && fieldId === 'child') {
        // A company the system did not list is one the run created (a dry
        // run mints its id and hands back no data).
        const id = positionRecordId(position);
        const owner = SYSTEM_RECORDS.find((r) => `c-${r.name}` === id) ?? CREATED;
        return owner.child.map((first) => ({
          position: makeStablePosition({ adapterType: 'attio', recordType: 'person', recordId: `p-${first}`, data: { first } }),
        }));
      }
      return [];
    },
    async createRecord(input) {
      n += 1;
      return { adapterType: 'attio', externalId: `ext-attio-${n}`, data: { ...input.fields } };
    },
    async updateRecord(input) {
      return { adapterType: 'attio', externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
}

function plainAdapter(adapterType: string): Adapter {
  let n = 0;
  return {
    ...systemAdapter(),
    adapterType,
    async getRelated() {
      return [];
    },
    async createRecord() {
      n += 1;
      return { adapterType, externalId: `ext-${adapterType}-${n}`, data: {} };
    },
  };
}

const cite = (value: unknown) => ({ value, evidence: { item: 0, quote: 'q' } });
const cited = (r: Rec) => ({ name: cite(r.name), tag: cite(r.tag), child: r.child.map((first) => ({ first: cite(first) })) });

const extractLlm = {
  async call(_input: ExtractCallLlmInput): Promise<ExtractCallLlmResult> {
    return {
      parsedJson: { records: [cited(ACME), cited(BETA)], record: cited(ACME) },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    };
  },
};

const transformInvoker: MovementTransformInvoker = {
  async invoke({ plugin, config }) {
    const data = config.data;
    if (plugin === RELAY && typeof data === 'string') return { text: data };
    if (plugin !== SUMMARISE && plugin !== RELAY) return { text: 'page' };
    const name = typeof data === 'object' && data !== null && 'name' in data ? data.name : undefined;
    return { text: typeof name === 'string' ? name : 'no name' };
  },
};

function event(): TriggerEvent {
  return {
    pipelineInputId: 'pi-binding-matrix',
    adapterType: 'email',
    triggerType: 'webhook',
    payload: { subject: 'Recap', text: 'Acme and Beta pitched.' },
  };
}

// ── Running and judging one cell ─────────────────────────────────────────────

type Outcome =
  | { kind: 'ran'; rows: string[] }
  | { kind: 'refused'; codes: string[]; message: string }
  | { kind: 'threw'; message: string };

/** The rows a run leaves: each sink write, then each marked update or create
 *  a write consumer made (the seed's own writes are not marked). */
function rowsOf(sink: CapturedWrite[], result: MovementRunResult): string[] {
  const sinkRows = sink.filter((w) => w.adapterType === 'sheets').map((w) => row(w.fields ?? {}));
  const effects = result.writes
    .filter((w) => Object.values(w.writtenValues).some((value) => typeof value === 'string' && /^(W|K)-/.test(value)))
    .map((w) => `${w.outcome ?? (w.created ? 'create' : 'update')} ${row(w.writtenValues)}`);
  return [...sinkRows, ...effects];
}

async function runCell(cell: Cell): Promise<Outcome> {
  const sink: CapturedWrite[] = [];
  try {
    const result = await runMovement({
      source: spelledFor(VERSION, programFor(cell, VERSION), fromCatalogSnapshot(catalog)),
      movementName: 'run_cell',
      event: event(),
      teamId: TEAM_ID,
      catalog,
      host: makeTestHost({
        writeSink: (w) => sink.push(w),
        adapters: { resolve: ({ adapterType }) => (adapterType === 'attio' ? systemAdapter() : plainAdapter(adapterType)) },
        llm: { extractCall: extractLlm, transforms: transformInvoker },
      }),
      dryRun: true,
    });
    return { kind: 'ran', rows: rowsOf(sink, result) };
  } catch (error) {
    const cause = runFailureCause(error);
    if (cause instanceof MovementEngineError && (cause.code === 'MOVENG_CHECK' || cause.code === 'MOVENG_PARSE')) {
      const diagnostics: unknown[] = Array.isArray(cause.details) ? cause.details : [];
      const codeOf = (d: unknown) => (typeof d === 'object' && d !== null && 'code' in d ? String(d.code) : 'UNCODED');
      const codes = cause.code === 'MOVENG_PARSE' ? ['PARSE'] : [...new Set(diagnostics.map(codeOf))].sort();
      return { kind: 'refused', codes, message: cause.message };
    }
    return { kind: 'threw', message: cause instanceof Error ? cause.message : String(cause) };
  }
}

function verdictOf(cell: Cell, outcome: Outcome): Verdict {
  switch (outcome.kind) {
    case 'refused':
      return `refused:${outcome.codes.join('+')}`;
    case 'threw':
      return 'FAIL';
    case 'ran':
    {
      const expected = expectationAt(cell, VERSION);
      return expected.kind === 'value' && JSON.stringify(outcome.rows) === JSON.stringify(expected.observed) ? 'ok' : 'wrong';
    }
  }
}

function describeOutcome(outcome: Outcome): string {
  switch (outcome.kind) {
    case 'refused':
      return `refused: ${outcome.codes.join(', ')}`;
    case 'threw':
      return `engine threw after the checker accepted: ${outcome.message.slice(0, 400)}`;
    case 'ran':
      return `ran, leaving ${JSON.stringify(outcome.rows)}`;
  }
}

const report: Array<{ cell: string; path: string; consumer: string; expected: string; verdict: Verdict | 'skipped'; detail: string; triage: boolean }> = [];

function expectedLabel(cell: Cell): string {
  const expected = expectationAt(cell, VERSION);
  switch (expected.kind) {
    case 'value':
      return 'ok';
    case 'refused':
      return `refused:${expected.code ?? 'any'}`;
  }
}

afterAll(() => {
  const file = process.env.MATRIX_REPORT;
  if (file !== undefined) writeFileSync(`${file}.v${VERSION}.json`, JSON.stringify(report, null, 2));
});

const ONLY = process.env.MATRIX_ONLY;
const ALL = cells().filter((cell) => ONLY === undefined || cellId(cell).includes(ONLY));

const triageFor = (id: string): TriageEntry | undefined =>
  TRIAGE.find((t) => t.cells.includes(id) && (t.versions === undefined || t.versions.includes(VERSION)));

describe(`binding × consumer matrix under language version ${VERSION}`, () => {
  it('every triage entry names cells the matrix generates', () => {
    const generated = new Set(cells().map(cellId));
    expect(TRIAGE.flatMap((t) => t.cells).filter((id) => !generated.has(id))).toEqual([]);
  });

  for (const cell of ALL) {
    const id = cellId(cell);
    if (cell.since > VERSION) {
      it.skip(`${id} (syntax since version ${cell.since})`, () => undefined);
      report.push({ cell: id, path: cell.path.id, consumer: cell.consumer.id, expected: expectedLabel(cell), verdict: 'skipped', detail: `since ${cell.since}`, triage: false });
      continue;
    }
    it(id, async () => {
      const outcome = await runCell(cell);
      const verdict = verdictOf(cell, outcome);
      const triaged = triageFor(id);
      report.push({ cell: id, path: cell.path.id, consumer: cell.consumer.id, expected: expectedLabel(cell), verdict, detail: outcome.kind === 'refused' ? `${describeOutcome(outcome)} — ${outcome.message.slice(0, 300)}` : describeOutcome(outcome), triage: triaged !== undefined });

      if (triaged !== undefined) {
        // Pinned to today's outcome until someone decides the right one.
        expect({ cell: id, verdict, detail: describeOutcome(outcome) }).toMatchObject({ verdict: triaged.observed });
        return;
      }
      const expected = expectationAt(cell, VERSION);
      switch (expected.kind) {
        case 'refused':
          expect({ cell: id, outcome: describeOutcome(outcome) }).toEqual({
            cell: id,
            outcome:
              expected.code === undefined && outcome.kind === 'refused'
                ? describeOutcome(outcome)
                : `refused: ${expected.code?.split('+').join(', ') ?? `(any code — ${expected.why})`}`,
          });
          return;
        case 'value':
          expect({ cell: id, outcome: describeOutcome(outcome) }).toEqual({
            cell: id,
            outcome: `ran, leaving ${JSON.stringify(expected.observed)}`,
          });
          return;
      }
    });
  }
});
