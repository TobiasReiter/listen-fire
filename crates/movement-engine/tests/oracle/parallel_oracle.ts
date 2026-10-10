// parallel.json: `parallel` and `race` programs run on the TypeScript engine,
// which tests/parallel_oracle.rs holds the Rust engine to (chunk 7A Task 4).
// Written by generate.ts; deterministic.
//
// Each case is a seeded program whose arms (two to four, sometimes a nested
// `parallel` among them) write notes, write notes `unique by` a key two arms
// may share, and count the notes. Its adapter answers every call at once and
// mints ids in the order it is asked, so what a case records is the order
// the engine asked in: the interleaving of the arms' requests (each adapter
// call, each cross-run lock taken, by name), and the writes in the order the
// run hands them back (the write ledger's order, each write's citations
// renumbered). Every program ends in a write of what the combinator bound.
//
// A case carries its body, the check's answer as the shim hands it to the
// Rust engine (`check.program`), and what the run did: `events` (in order),
// `writes`, and how it ended.

import { checkAnswer, checkPinned } from '../../../../apps/api/src/services/movement_engine/program_check';
import { mockCatalogSnapshot, type InstanceSchema } from '../../../../packages/movement-lang';
import { tenantIdOf } from '../../../../packages/engine-contracts';
import { MovementEngineError } from '../../../../apps/api/src/services/movement_engine/errors';
import { runFailureCause, runMovement } from '../../../../apps/api/src/services/movement_engine/run';
import { credentialIdsFor, makeTestHost } from '../../../../apps/api/src/services/movement_engine/test_host';
import { InMemoryWriteLocks, type WriteLocks } from '../../../../apps/api/src/services/write_locks/write_locks';
import type { Adapter } from '../../../../apps/api/src/services/translation_graph/adapter';
import { containerAssociation } from '../../../../apps/api/src/services/translation_graph/adapter';
import { positionData } from '../../../../apps/api/src/services/translation_graph/types';

type Rand = () => number;

const inboxSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};
const kgSchema: InstanceSchema = {
  positions: { note: { properties: { body: 'text', payload: 'json' }, edges: {} } },
  collections: { note: { target: 'note' } },
  writableRoots: { note: { fields: { body: 'text', payload: 'json' }, resultShape: { externalId: 'text' } } },
};

export const PARALLEL_CATALOG = mockCatalogSnapshot({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: inboxSchema },
    kg: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: kgSchema },
  },
  credentials: { inbox_cred: { adapters: ['email'] }, kg_cred: { adapters: ['kg'] } },
});

export const PARALLEL_PRELUDE = [
  'import { email, kg } from adapters',
  'import { inbox_cred, kg_cred } from credentials',
  'inbox = email(credentials: inbox_cred)',
  'graph = kg(credentials: kg_cred)',
  'movement m(msg: <inbox-[:message]->>) {',
  'BODY',
  '}',
].join('\n');

function pick<T>(rand: Rand, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

/** One statement of an arm: a plain write, a write `unique by` a key two
 *  arms may share, a count of the notes. */
function step(rand: Rand, arm: string, j: number, indent: string): string {
  const roll = rand();
  if (roll < 0.4) return `${indent}write graph-[:note]-> { body: "${arm}.${j}" }`;
  // The key two arms may share; where it is written tells the two apart.
  if (roll < 0.75) return `${indent}write graph-[:note]-> { unique by (\`body\`), body: "k${pick(rand, ['0', '1'])}", payload: { at: "${arm}.${j}" } }`;
  return `${indent}n${j} = COUNT(graph-[:note]->)`;
}

/** An arm: a closure of one to three statements, ending in a `return` of
 *  its name most of the time; at depth 0, now and then a nested `parallel`. */
function arm(rand: Rand, name: string, depth: number): string {
  const indent = '      '.slice(0, 4 + depth * 2);
  const lines: string[] = [];
  const steps = 1 + Math.floor(rand() * 3);
  for (let j = 0; j < steps; j++) {
    if (depth === 0 && rand() < 0.12) {
      const inner = [0, 1].map((k) => arm(rand, `${name}${j}${k}`, depth + 1));
      lines.push(`${indent}x${j} = await parallel([`, ...inner.map((a) => `${a},`), `${indent}])`);
    } else {
      lines.push(step(rand, name, j, indent));
    }
  }
  if (rand() < 0.75) lines.push(`${indent}return "${name}"`);
  const open = `${indent.slice(2)}() => {`;
  return [open, ...lines, `${indent.slice(2)}}`].join('\n');
}

function body(rand: Rand): string {
  const combinator = rand() < 0.7 ? 'parallel' : 'race';
  const arms = 2 + Math.floor(rand() * 3);
  const names = ['a', 'b', 'c', 'd'].slice(0, arms);
  return [
    `  r = await ${combinator}([`,
    ...names.map((name) => `${arm(rand, name, 0)},`),
    '  ])',
    '  write graph-[:note]-> { body: "after", payload: { r: r } }',
  ].join('\n');
}

/** What a recorded call names: the method, and what tells it apart. */
type Event = [string, unknown];

function kgAdapter(events: Event[]): Adapter {
  let created = 0;
  return {
    adapterType: 'kg',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    async resolveEntity(input) {
      events.push(['resolveEntity', [input.record.body ?? null, input.record.payload ?? null]]);
      return { candidates: [] };
    },
    getFieldValue: async ({ position, fieldId }) => (positionData(position) as Record<string, unknown> | undefined)?.[fieldId] ?? null,
    async getRelated(read) {
      events.push(['getRelated', read.fieldId]);
      return [];
    },
    async createRecord(write) {
      created += 1;
      events.push(['createRecord', [write.fields.body ?? null, write.fields.payload ?? null]]);
      return { adapterType: 'kg', externalId: `n${created}`, data: {} };
    },
    async updateRecord(input) {
      return { adapterType: 'kg', externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    deleteRecord: async () => ({}),
  };
}

const emailAdapter: Adapter = {
  adapterType: 'email',
  supportedTriggers: ['webhook'],
  runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
  listEntryPoints: async () => [],
  describe: async () => null,
  resolveEntity: async () => ({ candidates: [] }),
  getFieldValue: async () => null,
  getRelated: async () => [],
  createRecord: async () => ({ adapterType: 'email', externalId: 'e1', data: {} }),
  updateRecord: async (input) => ({ adapterType: 'email', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
  deleteRecord: async () => ({}),
};

function ending(error: unknown): unknown {
  const cause = runFailureCause(error) ?? error;
  if (cause instanceof MovementEngineError) return { code: cause.code, message: cause.message };
  return { message: String(cause instanceof Error ? cause.message : cause) };
}

export async function writeParallelOracle(rand: Rand, write: (name: string, text: string) => void): Promise<void> {
  const cases: unknown[] = [];
  let refused = 0;
  for (let i = 0; i < 400; i++) {
    const text = body(rand);
    const source = PARALLEL_PRELUDE.replace('BODY', text);
    let check: unknown;
    try {
      check = checkAnswer(checkPinned({ source, catalog: PARALLEL_CATALOG, languageVersion: 3 }));
    } catch {
      refused += 1;
      continue;
    }
    const events: Event[] = [];
    const inner = new InMemoryWriteLocks();
    const locks: WriteLocks = {
      holder(scope) {
        const holder = inner.holder(scope);
        return {
          acquire: (names) => {
            events.push(['acquire', [...names]]);
            return holder.acquire(names);
          },
          release: (names) => holder.release(names),
        };
      },
    };
    const kg = kgAdapter(events);
    let outcome: unknown;
    let writes: unknown = null;
    try {
      const result = await runMovement({
        source,
        languageVersion: 3,
        event: { pipelineInputId: 'p', adapterType: 'email', triggerType: 'webhook', payload: { subject: 'Acme' } },
        catalog: PARALLEL_CATALOG,
        teamId: tenantIdOf('00000000-0000-0000-0000-0000000000a8'),
        credentialIds: credentialIdsFor(PARALLEL_CATALOG, (name) => `cred-${name}`),
        host: makeTestHost({
          adapters: { resolve: ({ adapterType }) => (adapterType === 'kg' ? kg : emailAdapter) },
          locks,
        }),
      });
      writes = result.writes.map((w) => ({ externalId: w.externalId, body: w.writtenValues.body ?? null, payload: w.writtenValues.payload ?? null }));
      outcome = { completed: true };
    } catch (error) {
      outcome = { error: ending(error) };
    }
    cases.push({ body: text, check, events, writes, outcome });
  }
  write(
    'parallel.json',
    `{"catalog":${JSON.stringify(PARALLEL_CATALOG)},"prelude":${JSON.stringify(PARALLEL_PRELUDE)},"cases":[\n${cases.map((c) => JSON.stringify(c)).join(',\n')}\n]}\n`,
  );
  console.log(`parallel.json: ${cases.length} cases (${refused} refused by the checker and left out)`);
}
