// parallel.json: `parallel` and `race` programs run on the TypeScript engine,
// which tests/parallel_oracle.rs holds the Rust engine to (chunk 7A Task 4).
// Written by generate.ts; deterministic.
//
// Each case is a seeded program whose arms (two to four, sometimes a nested
// `parallel` among them) take every kind of the run's own locks:
//   - writes `unique by` a key two arms may share (a shared type lock, then
//     the key's own);
//   - writes `unique by` two fields (another key-set group, so the type lock
//     is shared by a different group);
//   - FUZZY writes (the type lock exclusive);
//   - updates of a record the run wrote before the combinator (a record
//     lock two arms may contend for);
//   - links between two such records (an edge lock), or from the arm's own
//     record (written before the combinator, one per arm) to one of them,
//     which names the arm in the request;
//   - plain writes, and counts whose WHERE names the arm (the predicate is
//     pushed to the adapter, so the request names it).
//
// The host is scheduled: its adapter and its cross-run locks answer one
// request at a time, and the run goes on until every flow waits on the host
// again before the next is answered; the oldest step's request goes first,
// and among one step's, the least by its text. The Rust test's host
// answers the same way, so the two runs must ask the same requests in the
// same order. A lock taken carries the request its flow made next (the
// flow that took it is the only one the answer lets run), naming the arm
// and the key it was taken for. A case records every adapter call and lock
// taken in order, the writes in the order the run hands them back (the
// write ledger's order) with their ids, and how the run ended.

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
  positions: { note: { properties: { body: 'text', tag: 'text', payload: 'json' }, edges: { refs: { target: 'note' } } } },
  collections: { note: { target: 'note' } },
  writableRoots: { note: { fields: { body: 'text', tag: 'text', payload: 'json' }, resultShape: { externalId: 'text' }, fuzzyResolution: true } },
  supportsInPlaceUpdate: true,
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
  // Two records every arm can reach: what an update and a link lock.
  '  h0 = write graph-[:note]-> { body: "h0" }',
  '  h1 = write graph-[:note]-> { body: "h1" }',
  // One record per arm: a link from it names the arm that made it.
  '  ha = write graph-[:note]-> { body: "ha" }',
  '  hb = write graph-[:note]-> { body: "hb" }',
  '  hc = write graph-[:note]-> { body: "hc" }',
  '  hd = write graph-[:note]-> { body: "hd" }',
  'BODY',
  '}',
].join('\n');

function pick<T>(rand: Rand, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

/** One statement of an arm, `at` naming where it is written (`own`, at
 *  the top level, the arm's own record). */
function step(rand: Rand, at: string, j: number, indent: string, own: string | undefined): string {
  const key = pick(rand, ['0', '1']);
  const tagged = `payload: { at: "${at}" }`;
  const roll = rand();
  if (roll < 0.2) return `${indent}write graph-[:note]-> { body: "${at}" }`;
  if (roll < 0.42) return `${indent}write graph-[:note]-> { unique by (\`body\`), body: "k${key}", ${tagged} }`;
  if (roll < 0.52) return `${indent}write graph-[:note]-> { unique by (\`body\`, \`tag\`), body: "k${key}", tag: "t", ${tagged} }`;
  if (roll < 0.62) return `${indent}write graph-[:note]-> { unique by (FUZZY \`body\`), body: "f${key}", ${tagged} }`;
  if (roll < 0.77) return `${indent}write h${key} { body: "${at}" }`;
  if (roll < 0.87) {
    if (own !== undefined && rand() < 0.5) return `${indent}link h${own} -[:refs]-> h${key}`;
    return `${indent}link h${key} -[:refs]-> h${key === '0' ? '1' : '0'}`;
  }
  return `${indent}n${j} = COUNT(graph-[x:note WHERE x.\`tag\` == "${at}"]->)`;
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
      lines.push(step(rand, `${name}.${j}`, j, indent, depth === 0 ? name : undefined));
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

/** The text a count's pushed WHERE compares the tag with: the arm's place. */
function tagOf(where: unknown): string | null {
  if (typeof where === 'string') return /^[a-d][0-9]*\.[0-9]+$/.test(where) ? where : null;
  if (Array.isArray(where)) return where.map(tagOf).find((t) => t !== null) ?? null;
  if (where !== null && typeof where === 'object') return Object.values(where).map(tagOf).find((t) => t !== null) ?? null;
  return null;
}

/** What a recorded request names: the method, and what tells it apart. */
type Event = [string, unknown] | [string, unknown, unknown];

/** The host's scheduled requests: each waits until the driver answers it. */
interface Asked {
  /** How many requests had been answered when it was asked. */
  step: number;
  event: Event;
  answer: () => unknown;
  resolve: (value: unknown) => void;
}

function scheduledHost(queue: Asked[], answered: () => number) {
  let created = 0;
  const ask = <T>(event: Event, answer: () => T): Promise<T> =>
    new Promise<T>((resolve) => queue.push({ step: answered(), event, answer, resolve: resolve as (value: unknown) => void }));
  const kg: Adapter = {
    adapterType: 'kg',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: (input) => ask(['resolveEntity', [input.record.body ?? null, input.record.payload ?? null, input.record.tag ?? null]], () => ({ candidates: [] })),
    getFieldValue: async ({ position, fieldId }) => (positionData(position) as Record<string, unknown> | undefined)?.[fieldId] ?? null,
    getRelated: (read) => ask(['getRelated', read.fieldId, tagOf(read.where)], () => []),
    createRecord: (write) =>
      ask(['createRecord', [write.fields.body ?? null, write.fields.payload ?? null, write.fields.tag ?? null]], () => {
        created += 1;
        return { adapterType: 'kg', externalId: `n${created}`, data: {} };
      }),
    updateRecord: (input) =>
      ask(['updateRecord', [input.externalId, input.fields.body ?? null]], () => ({
        adapterType: 'kg',
        externalId: input.externalId,
        data: {},
        association: containerAssociation(input),
      })),
    linkRecords: (input) => ask(['linkRecords', [input.from.externalId, input.edgeName, input.to.externalId]], () => ({ created: true })),
    deleteRecord: async () => ({}),
  };
  const inner = new InMemoryWriteLocks();
  const locks: WriteLocks = {
    holder(scope) {
      const holder = inner.holder(scope);
      return {
        acquire: (names) => ask(['acquire', [...names]], () => holder.acquire(names)) as ReturnType<typeof holder.acquire>,
        release: (token) => holder.release(token),
      };
    },
  };
  return { kg, locks };
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

/** The request answered next: the oldest step's, and among the requests one
 *  step let several flows ask (arms started together, waiters a release
 *  let through), the least by its text, whichever flow asked first: which
 *  of them reaches the host first turns on how many microtasks each layer
 *  takes, which no other engine reproduces. */
function next(queue: Asked[]): number {
  let best = 0;
  for (let i = 1; i < queue.length; i++) {
    const [a, b] = [queue[i]!, queue[best]!];
    if (a.step < b.step || (a.step === b.step && JSON.stringify(a.event) < JSON.stringify(b.event))) best = i;
  }
  return best;
}

/** Until the run has gone as far as it can: every flow waits on the host. */
async function quiesce(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
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
    const queue: Asked[] = [];
    const events: Event[] = [];
    const { kg, locks } = scheduledHost(queue, () => events.length);
    let ended: { ok: Awaited<ReturnType<typeof runMovement>> } | { error: unknown } | undefined;
    void runMovement({
      source,
      languageVersion: 3,
      event: { pipelineInputId: 'p', adapterType: 'email', triggerType: 'webhook', payload: { subject: 'Acme' } },
      catalog: PARALLEL_CATALOG,
      teamId: tenantIdOf('00000000-0000-0000-0000-0000000000a8'),
      credentialIds: credentialIdsFor(PARALLEL_CATALOG, (name) => `cred-${name}`),
      host: makeTestHost({ adapters: { resolve: ({ adapterType }) => (adapterType === 'kg' ? kg : emailAdapter) }, locks }),
    }).then(
      (ok) => (ended = { ok }),
      (error: unknown) => (ended = { error }),
    );
    await quiesce();
    while (queue.length > 0) {
      const asked = queue.splice(next(queue), 1)[0]!;
      const before = queue.length;
      const index = events.length;
      events.push(asked.event);
      asked.resolve(asked.answer());
      await quiesce();
      // The only flow the answer let run is the one that asked: what it
      // asks next says what the lock was taken for.
      if (asked.event[0] === 'acquire') events[index] = [asked.event[0], asked.event[1], queue[before]?.event ?? null];
    }
    if (ended === undefined) throw new Error(`parallel oracle: case ${i} never ended:\n${source}`);
    const outcome = 'ok' in ended ? { completed: true } : { error: ending(ended.error) };
    const writes =
      'ok' in ended
        ? ended.ok.writes.map((w) => ({ externalId: w.externalId, body: w.writtenValues.body ?? null, payload: w.writtenValues.payload ?? null }))
        : null;
    cases.push({ body: text, check, events, writes, outcome });
  }
  write(
    'parallel.json',
    `{"catalog":${JSON.stringify(PARALLEL_CATALOG)},"prelude":${JSON.stringify(PARALLEL_PRELUDE)},"cases":[\n${cases.map((c) => JSON.stringify(c)).join(',\n')}\n]}\n`,
  );
  console.log(`parallel.json: ${cases.length} cases (${refused} refused by the checker and left out)`);
}
