// patterns.json: the retirement proof (PLAN-07A Task 6). For every admission
// pattern the Rust engine's port list names (crates/movement-engine/README.md,
// "The port list"), and for every pattern chunk 7A closed, seeded programs
// that exercise it, each run on BOTH engines through the real entry points
// and the real shim against one scripted host:
//
//   - the TypeScript run is recorded at the host boundary (the conformance
//     kit's recorder): every request, every answer, how the entry ended;
//   - the Rust run (MOVEMENT_ENGINE=rust) is recorded the same way against a
//     fresh copy of the same scripted host, and the shim's counts say what
//     its admission did: ran whole, refused (with every reason), declined;
//   - a program Rust runs whole must make the TypeScript's requests with the
//     TypeScript's answers and end as it ended (its writes, their provenance
//     and its trace are its result): the TypeScript recording replayed
//     through the Rust target must pass the kit's verdict, and the two
//     recordings agree exactly or as the kit's matching rule allows;
//   - a program Rust refuses must name the pattern among its reasons, and
//     the TypeScript engine runs it (the fallback): the two outcomes agree.
//
// A pattern says which it is (`routes`): `whole` for a pattern that now runs
// on Rust, `refused` for one still refused by name, `declined` for one only
// the check's answer reveals, `by_contract` for one both engines refuse by
// the park-state contract, `unrecordable` for an input the shim refuses
// because the eval wire cannot carry it (PLAN-08A Task 1: so "0 refused, 0
// declined" means no port is left). A program that ends somewhere its
// pattern does not say fails the generator, and so does a program refused
// or declined for a reason the README's port list has retired (marked
// Closed, or no longer named): the committed file is the inventory, and the
// one-command report (patterns_report.ts, `pnpm engine:patterns`) reads it.
//
// Written by generate.ts (seed 20261015); deterministic: the scripted host
// answers from the program alone (a fixed clock, ids in order asked).

import { mockCatalogSnapshot, type InstanceSchema, type PluginSpec } from '../../../../packages/movement-lang';
import { tenantIdOf } from '../../../../packages/engine-contracts';
import type { HostRecording } from '../../../../packages/engine-contracts/conformance';
import { recordEntry, recordedError } from '../../../../apps/api/src/services/movement_engine/conformance/recorder';
import { rustTarget } from '../../../../apps/api/src/services/movement_engine/conformance/replay';
import { resumeMovement, runMovement } from '../../../../apps/api/src/services/movement_engine/run';
import { resetRustRunStats, resetRustEvalStats, rustRunStats } from '../../../../apps/api/src/services/movement_engine/rust_stats';
import { credentialIdsFor, makeFakeParkSink, makeTestHost } from '../../../../apps/api/src/services/movement_engine/test_host';
import { staticCatalogFromManifests } from '../../../../apps/api/src/services/translation_graph/movement/catalog';
import type { ActingUser, Adapter, RelatedResult } from '../../../../apps/api/src/services/translation_graph/adapter';
import { containerAssociation } from '../../../../apps/api/src/services/translation_graph/adapter';
import { makeStablePosition, makeUnstablePosition, positionData } from '../../../../apps/api/src/services/translation_graph/types';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { BY_CONTRACT, PATTERNS, UNRECORDABLE, type Pick, type Program, type Routes } from './patterns_table';

type Rand = () => number;

// ── The world ────────────────────────────────────────────────────────────────

const fileRef = (name: string) => ({ __brand: 'FileRef', name, contentType: 'application/pdf', source: { store: 'document', objectUri: `s3://patterns/${name}` } });

const emailSchema: InstanceSchema = {
  positions: {
    message: {
      properties: { subject: 'text', text: 'text', user: 'text', amount: 'number', deck: 'file', meta: 'json', missing: 'text', sent: 'datetime' },
      edges: { files: { target: 'attachment', sequenced: 'document' } },
    },
    attachment: { properties: { filename: 'text', contentType: 'text', data: 'file' }, edges: {} },
  },
  collections: {},
  writableRoots: {},
};

const crmSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { name: 'text', stage: 'text', domain: 'text', summary: 'text', employees: 'number' },
      edges: { notes: { target: 'note', writable: true }, deals: { target: 'deal' }, people: { target: 'person' } },
    },
    note: { properties: { body: 'text', title: 'text', payload: 'json' }, edges: {} },
    deal: { properties: { title: 'text', amount: 'number' }, edges: { people: { target: 'person' } } },
    person: { properties: { name: 'text', email: 'text' }, edges: { company: { target: 'company', writable: true } } },
    bag: { properties: {}, edges: {}, openProperties: true },
  },
  collections: {
    companies: { target: 'company' },
    notes: { target: 'note' },
    deals: { target: 'deal' },
    people: { target: 'person' },
    bags: { target: 'bag' },
  },
  writableRoots: {
    company: {
      fields: { name: 'text', stage: 'text', domain: 'text', summary: 'text', employees: 'number' },
      resultShape: { externalId: 'text', name: 'text' },
      fuzzyResolution: true,
    },
    note: { fields: { body: 'text', title: 'text', payload: 'json' }, resultShape: { externalId: 'text' } },
    deal: { fields: { title: 'text', amount: 'number' }, resultShape: { externalId: 'text' } },
  },
  supportsInPlaceUpdate: true,
};

const registeredFetch = staticCatalogFromManifests({ credentials: {} }).plugin('fetch_url');
if (registeredFetch === undefined) throw new Error('patterns oracle: the catalog registers fetch_url');
const PLUGINS: Record<string, PluginSpec> = {
  fetch_url: registeredFetch,
  find_files: { args: ['q'], priced: false, effects: { ai: true }, output: { kind: 'records', fields: { url: 'text', name: 'text' } } },
  echo: { args: ['q'], priced: false, effects: { ai: true }, output: { kind: 'value', type: 'text' } },
  summarise: { args: ['data'], priced: false, argTypes: { data: 'json' }, requiredArgs: ['data'], effects: { ai: true }, output: { kind: 'value', type: 'text' } },
};

export const PATTERNS_CATALOG = mockCatalogSnapshot({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: crmSchema },
  },
  credentials: { inbox_cred: { adapters: ['email'] }, crm_cred: { adapters: ['attio'] } },
  plugins: PLUGINS,
});

export const PATTERNS_PRELUDE = [
  'import { email, attio } from adapters',
  'import { inbox_cred, crm_cred } from credentials',
  'inbox = email(credentials: inbox_cred)',
  'crm = attio(credentials: crm_cred)',
  '',
].join('\n');

const COMPANIES = [
  { id: 'co-1', data: { name: 'Acme', stage: 'Seed', domain: 'acme.example', summary: 'anvils', employees: 12 } },
  { id: 'co-2', data: { name: 'Beta', stage: 'Series A', domain: 'beta.example', summary: 'boats', employees: 40 } },
];

/** The CRM: two companies, each with a note, a deal and a person; writes
 *  answered in order. Built fresh per run, so each engine meets it as new. */
function crmAdapter(): Adapter {
  let created = 0;
  const position = (recordType: string, recordId: string, data: Record<string, unknown>) =>
    ({ position: makeStablePosition({ adapterType: 'attio', recordType, recordId, data }) });
  const related = (fieldId: string, from: Record<string, unknown> | undefined): RelatedResult[] => {
    const owner = typeof from?.name === 'string' ? from.name : 'Acme';
    switch (fieldId) {
      case 'companies':
        return COMPANIES.map((c) => position('company', c.id, { ...c.data }));
      case 'notes':
        return [position('note', `n-${owner}`, { body: `${owner} note`, title: 'hello' })];
      case 'deals':
        return [position('deal', `d-${owner}`, { title: `${owner} deal`, amount: 100 })];
      case 'people':
        return [position('person', `p-${owner}`, { name: `${owner} founder`, email: `founder@${owner.toLowerCase()}.example` })];
      case 'company':
        return [position('company', 'co-1', { ...COMPANIES[0]!.data })];
      case 'bags':
        return [position('bag', 'b-1', { colour: 'red' })];
      default:
        return [];
    }
  };
  return {
    adapterType: 'attio',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async (typeId) =>
      typeId === 'company'
        ? {
            typeId: 'company',
            displayName: 'Company',
            references: [],
            fields: [
              { fieldId: 'name', displayName: 'name', kind: 'string' as const, writable: true, required: false },
              {
                fieldId: 'domain',
                displayName: 'domain',
                kind: 'string' as const,
                writable: true,
                required: false,
                functions: [
                  {
                    name: 'DOMAIN_OF',
                    displayName: 'Domain of',
                    summary: 'the domain of a text',
                    params: [{ name: 'text', kind: 'string' as const, doc: 'the text to read a domain from' }],
                  },
                ],
              },
            ],
          }
        : null,
    resolveEntity: async ({ recordType, record }) => ({
      candidates:
        recordType === 'company'
          ? COMPANIES.filter((c) => c.data.name === record.name).map((c) => ({ adapterType: 'attio', externalId: c.id, data: { ...c.data } }))
          : [],
    }),
    getFieldValue: async ({ position: at, fieldId }) => (positionData(at) as Record<string, unknown> | undefined)?.[fieldId] ?? null,
    getRelated: async ({ fieldId, position: from }) => related(fieldId, positionData(from) as Record<string, unknown> | undefined),
    createRecord: async () => ({ adapterType: 'attio', externalId: `ext-${++created}`, data: {} }),
    updateRecord: async (input) => ({ adapterType: 'attio', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
    deleteRecord: async () => ({}),
    linkRecords: async () => ({ created: true }),
    unlinkRecords: async () => ({ removed: true }),
    readRecord: async ({ externalId }) => ({ ...(COMPANIES.find((c) => c.id === externalId)?.data ?? {}) }),
    invokeFieldFunction: async ({ functionName, args }) => `${functionName.toLowerCase()}(${args.instructions})`,
  };
}

const ATTACHMENTS = [
  { filename: 'deck.pdf', contentType: 'application/pdf', data: fileRef('deck.pdf') },
  { filename: 'notes.txt', contentType: 'text/plain', data: fileRef('notes.txt') },
];

/** The inbox: the event's message, its attachments, its actor. */
function inboxAdapter(): Adapter {
  return {
    adapterType: 'email',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async ({ position: at, fieldId }) => (positionData(at) as Record<string, unknown> | undefined)?.[fieldId] ?? null,
    getRelated: async ({ fieldId }) =>
      fieldId === 'files' ? ATTACHMENTS.map((data) => ({ position: makeUnstablePosition({ adapterType: 'email', recordType: 'attachment', data: { ...data } }) })) : [],
    createRecord: async () => ({ adapterType: 'email', externalId: 'e-1', data: {} }),
    updateRecord: async (input) => ({ adapterType: 'email', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
    deleteRecord: async () => ({}),
    getActorCandidates: async () => [{ identity: { scheme: 'email', identifier: 'founder@acme.example' }, source: 'originator' as const }],
    extractActor: async () => ({ scheme: 'email', identifier: 'founder@acme.example', name: 'Ada Founder' }),
  };
}

/** What the scripted model answers: AI() its envelope, an extraction the
 *  case's replies in order (an empty answer once they run out). */
function scriptedHost(replies: readonly unknown[], park = makeFakeParkSink(), answers: Program['answers'] = {}) {
  const queue = [...replies];
  const crm = crmAdapter();
  const inbox = inboxAdapter();
  const host = makeTestHost({
    adapters: { resolve: ({ adapterType }) => (adapterType === 'attio' ? crm : inbox) },
    llm: {
      client: {
        call: async (request) =>
          request.label === 'movement-ai-expression'
            ? { parsedJson: { value: `answer to ${request.userMessage.slice(0, 24)}`, has_value: true } }
            : { parsedJson: queue.shift() ?? {} },
      },
      extractCall: {
        call: async () => ({
          parsedJson: queue.shift() ?? {},
          usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 80, cacheCreationTokens: 40 },
        }),
      },
      transforms: {
        invoke: async ({ plugin }) =>
          plugin === 'find_files'
            ? { records: (answers.records ?? [{ url: 'https://files.example/1', name: 'one' }, { url: 'https://files.example/2', name: 'two' }]) as never }
            : { text: `${plugin} says hello` },
      },
      arbitrateEntities: async () => ({ index: null }),
    },
    park: { sink: park.sink },
    files: {
      resolveFileText: async ({ file }) =>
        answers.unreadable !== undefined
          ? ({ unreadable: answers.unreadable } as never)
          : { text: `the text of ${String(Reflect.get(file, 'name'))}`, rawTextId: 'rt-1' },
    },
    lookup: { resolveActingUser: async (): Promise<ActingUser> => ({ id: 'user-1', email: 'ada@acme.example', name: 'Ada' }) },
  });
  // A malformed answer is the host's own (past the test host's mapping to a
  // principal): what the engine is handed when a host breaks its contract.
  if (answers.actingUser !== undefined) Reflect.set(host.lookup, 'resolveActingUser', async () => answers.actingUser);
  return process.env.PATTERNS_DEBUG === undefined ? host : logging(host, '');
}

/** `host` with each request it is asked written to stderr (PATTERNS_DEBUG). */
function logging<T extends object>(target: T, prefix: string): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      const value: unknown = Reflect.get(object, key, receiver);
      if (typeof key !== 'string') return value;
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          console.error(`    asked ${prefix}${key}`);
          return Reflect.apply(value, object, args);
        };
      }
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return logging(value, `${prefix}${key}.`);
      return value;
    },
  });
}

const EVENT_PAYLOAD = {
  subject: 'Acme raises a seed round',
  text: 'Acme Corp is raising 3 million. Beta Ltd too. See acme.example and https://beta.example/deck',
  user: 'founder@acme.example',
  amount: 3000000,
  deck: fileRef('deck.pdf'),
  meta: { label: 'Follow up', n: 2 },
};

// ── Running a program on both engines ────────────────────────────────────────

const TEAM = tenantIdOf('00000000-0000-0000-0000-0000000000f6');

function sourceOf(program: Program): string {
  if (program.file !== undefined) return PATTERNS_PRELUDE + program.file;
  return `${PATTERNS_PRELUDE}movement m(msg: <inbox-[:message]->>) {\n${program.body ?? ''}\n}`;
}

async function underEngine<T>(engine: 'ts' | 'rust', body: () => Promise<T>): Promise<T> {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = engine;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
    else process.env.MOVEMENT_ENGINE = previous;
  }
}

/** The parked state a resume program resumes: its first timer park on the
 *  TypeScript engine, as `program.resume` makes it. */
async function parkedState(program: Program): Promise<unknown> {
  const park = makeFakeParkSink();
  const catalog = program.files !== undefined ? { ...PATTERNS_CATALOG, files: program.files } : PATTERNS_CATALOG;
  const failed = await underEngine('ts', () =>
    runMovement({ ...runInput(program, catalog), host: scriptedHost(program.replies ?? [], park, program.answers) }).then(
      () => undefined,
      (error: unknown) => String(error),
    ),
  );
  const first = park.timerParks[0];
  if (first === undefined || program.resume === undefined) {
    throw new Error(`patterns oracle: a resume program never parked (${failed ?? 'it ran to its end'}): ${program.body ?? program.file}`);
  }
  return program.resume(JSON.parse(JSON.stringify(first.state)) as Record<string, unknown>);
}

/** The run's input but its host. */
function runInput(program: Program, catalog: typeof PATTERNS_CATALOG) {
  return {
    source: sourceOf(program),
    languageVersion: program.version ?? 3,
    ...(program.movementName !== undefined ? { movementName: program.movementName } : {}),
    event: { pipelineInputId: 'pi-patterns', adapterType: 'email', triggerType: 'webhook' as const, payload: { ...EVENT_PAYLOAD, ...program.payload } },
    catalog,
    teamId: TEAM,
    credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
  };
}

/** One engine's run of a program whose input JSON cannot carry (a lone
 *  surrogate), so the recorder refuses it: how it ended, and no requests. */
async function direct(engine: 'ts' | 'rust', program: Program): Promise<HostRecording> {
  const catalog = program.files !== undefined ? { ...PATTERNS_CATALOG, files: program.files } : PATTERNS_CATALOG;
  const outcome = await underEngine(engine, () =>
    runMovement({ ...runInput(program, catalog), host: scriptedHost(program.replies ?? [], undefined, program.answers) }).then(
      (result) => ({ result: JSON.parse(JSON.stringify(result)) as unknown }),
      (error: unknown) => ({ failure: recordedError(error) }),
    ),
  );
  return { kit: 'host', version: 2, entry: 'run', input: {}, methods: [], requests: [], ...outcome } as unknown as HostRecording;
}

/** One engine's run of `program`, recorded at the host boundary. */
async function recorded(engine: 'ts' | 'rust', program: Program, state?: unknown): Promise<HostRecording | undefined> {
  let kept: HostRecording | undefined;
  const catalog = program.files !== undefined ? { ...PATTERNS_CATALOG, files: program.files } : PATTERNS_CATALOG;
  // A run that never ends (a promise nothing settles) would end the process
  // silently: it is reported instead.
  let stalled: NodeJS.Timeout | undefined;
  const stall = new Promise<void>((resolve) => {
    stalled = setTimeout(resolve, 20_000);
  });
  await underEngine(engine, () =>
    Promise.race([
      stall,
      (state === undefined
        ? recordEntry({
            entry: 'run',
            input: { ...runInput(program, catalog), host: scriptedHost(program.replies ?? [], undefined, program.answers) },
            run: (input) => runMovement(input),
            keep: (recording) => {
              kept = recording;
            },
          })
        : recordEntry({
            entry: 'resume',
            input: { ...runInput(program, catalog), state: state as never, host: scriptedHost(program.replies ?? [], undefined, program.answers) },
            run: (input) => resumeMovement(input),
            keep: (recording) => {
              kept = recording;
            },
          })
      ).catch(() => undefined),
    ]),
  );
  clearTimeout(stalled);
  return kept;
}

/** What the Rust engine's admission did with the run it was just handed. */
function routing(): { routes: Routes; reasons: string[] } {
  const [first] = Object.keys(rustRunStats.notAdmitted);
  if (first !== undefined) {
    const reasons = Object.keys(rustRunStats.allReasons);
    if (BY_CONTRACT.includes(first)) return { routes: 'by_contract', reasons };
    if (UNRECORDABLE.includes(first)) return { routes: 'unrecordable', reasons };
    return { routes: 'refused', reasons };
  }
  if (Object.keys(rustRunStats.declined).length > 0) return { routes: 'declined', reasons: Object.keys(rustRunStats.declined) };
  // Never handed to the Rust engine (both entries refuse it first).
  if (rustRunStats.routed === 0) return { routes: 'unreached', reasons: [] };
  // This engine's own refusal met mid-run after an effect: a divergence,
  // which no pattern may say it routes.
  if (rustRunStats.unreproduced > 0) return { routes: 'declined', reasons: ['unreproduced_mid_run'] };
  // A run that ended mid-run in the TypeScript's own MOVENG_UNSUPPORTED,
  // mirrored, ran in Rust, counted apart: whole only where it ends as the
  // TypeScript's does, which the comparison below holds it to, and it says so.
  if (rustRunStats.mirroredFailure > 0) return { routes: 'whole', reasons: ['mirrored_failure'] };
  // Whole means the shim saw it run whole, not only that nothing refused.
  if (rustRunStats.ranWhole === 0) return { routes: 'declined', reasons: ['did_not_run_whole'] };
  return { routes: 'whole', reasons: [] };
}

/** How an entry ended, as the report keeps it. */
function ending(recording: HostRecording): unknown {
  if ('failure' in recording) return { failure: recording.failure };
  return { result: recording.result };
}

/** JSON with every object's keys sorted: a host reads a request's members,
 *  not their order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

/** Every request in the order made, what was answered before it, and its
 *  answer — each object's keys in the order the host was handed them. */
const requestsOf = (recording: HostRecording) =>
  JSON.stringify(recording.requests.map((r) => ({ path: `${r.family}.${r.method}`, args: r.args, after: r.after, ...('error' in r ? { error: r.error } : { answer: r.answer }) })));

/** The pattern a reason names: `function:fact` is `function:<id>`. */
export function patternOf(reason: string, patterns: readonly string[]): string | undefined {
  if (patterns.includes(reason)) return reason;
  return patterns.find((p) => {
    const at = p.indexOf('<');
    return at > 0 && reason.startsWith(p.slice(0, at)) && reason.length > at;
  });
}

interface CaseRecord {
  pattern: string;
  program: Program;
  routes: Routes;
  reasons: string[];
  /** For a whole run, which always passes the kit's verdict: whether the
   *  Rust run also made the TypeScript's requests and result exactly
   *  (`exact`), or only as the kit's matching rule allows (`kit`). */
  agreement?: 'exact' | 'kit' | 'check';
  requests: string[];
  ending: unknown;
}

/** Every reason the README's port list names (its tables' first column),
 *  from "The port list" to its version-4 section. */
export function portListReasons(readme: string): string[] {
  return [...portListStatus(readme).keys()];
}

/** Each reason the README's port list names, by the status its row starts
 *  its last column with: `Closed` (retired: nothing left to port) or `Open`. */
export function portListStatus(readme: string): Map<string, 'Closed' | 'Open'> {
  const from = readme.indexOf('### The port list');
  const to = readme.indexOf('### Language version 4: the port list');
  if (from === -1 || to === -1) throw new Error("patterns oracle: the README no longer spells the port list as this reads it");
  const status = new Map<string, 'Closed' | 'Open'>();
  for (const line of readme.slice(from, to).split('\n')) {
    const cell = /^\| ([^|]*)\|/.exec(line)?.[1];
    if (cell === undefined || cell.trim() === 'reason' || /^-+$/.test(cell.trim())) continue;
    const marked = /\*\*(Closed|Open)\*\*/.exec(line.slice(line.lastIndexOf('|', line.length - 2)))?.[1];
    if (marked !== 'Closed' && marked !== 'Open') throw new Error(`patterns oracle: the port list row for ${cell.trim()} says neither Closed nor Open`);
    for (const [, name] of cell.matchAll(/`([^`]+)`/g)) status.set(name!, marked);
  }
  return status;
}

/** Why a program the Rust engine refused or declined is wrong to be: a
 *  reason the port list has retired (marked Closed, or no longer named), or
 *  a contract category reached by a reason outside it. Nothing for a
 *  program that ends otherwise. */
export function retiredReasons(routes: Routes, reasons: readonly string[], status: ReadonlyMap<string, 'Closed' | 'Open'>): string[] {
  const listed = [...status.keys()];
  const statusOf = (reason: string) => {
    const pattern = patternOf(reason, listed);
    return pattern === undefined ? 'unlisted' : status.get(pattern)!;
  };
  switch (routes) {
    case 'refused':
    case 'declined':
      return reasons.filter((reason) => statusOf(reason) !== 'Open').map((reason) => `${routes} for ${reason}, which the port list ${statusOf(reason) === 'Closed' ? 'marks Closed' : 'no longer names'}`);
    case 'by_contract':
      return reasons.filter((reason) => !BY_CONTRACT.includes(reason) || statusOf(reason) !== 'Closed').map((reason) => `by_contract for ${reason}, which is not a Closed contract refusal`);
    case 'unrecordable':
      return reasons.filter((reason) => !UNRECORDABLE.includes(reason)).map((reason) => `unrecordable for ${reason}, which is not the shim's wire refusal`);
    case 'whole':
    case 'unreached':
      return [];
    default:
      return neverRoutes(routes);
  }
}

function neverRoutes(routes: never): never {
  throw new Error(`patterns oracle: no such routes ${String(routes)}`);
}

export async function writePatternsOracle(rand: Rand, write: (name: string, text: string) => void): Promise<void> {
  const readme = readFileSync(path.join(__dirname, '../../README.md'), 'utf8');
  const status = portListStatus(readme);
  const uncovered = [...status.keys()].filter((reason) => !PATTERNS.some((p) => p.reason === reason));
  if (uncovered.length > 0) throw new Error(`patterns oracle: the port list names reasons no pattern exercises: ${uncovered.join(', ')}`);
  const pick: Pick = (items) => items[Math.floor(rand() * items.length)]!;
  const cases: CaseRecord[] = [];
  const problems: string[] = [];
  const only = process.env.PATTERNS_ONLY !== undefined ? new RegExp(process.env.PATTERNS_ONLY) : undefined;
  for (const pattern of PATTERNS) {
    if (only !== undefined && !only.test(pattern.reason)) continue;
    for (const make of pattern.programs) {
      const program = make(pick);
      if (process.env.PATTERNS_DEBUG !== undefined) console.error('CASE', pattern.reason, JSON.stringify(program.body ?? program.file));
      const state = program.resume !== undefined ? await parkedState(program) : undefined;
      const ts = program.unrecordable === true ? await direct('ts', program) : await recorded('ts', program, state);
      if (process.env.PATTERNS_DEBUG !== undefined) console.error('  ts done');
      resetRustRunStats();
      resetRustEvalStats();
      const rust = program.unrecordable === true ? await direct('rust', program) : await recorded('rust', program, state);
      if (ts === undefined || rust === undefined) {
        problems.push(`${pattern.reason}: ${program.body ?? program.file}\n  the ${ts === undefined ? 'TypeScript' : 'Rust'} run kept no recording (it never ended within 20 s, or its input is not JSON)`);
        continue;
      }
      const { routes, reasons } = routing();
      const where = `${pattern.reason}: ${program.body ?? program.file}`;
      const checkFailed = (r: HostRecording) => 'failure' in r && /^MOVENG_(PARSE|CHECK|LANGUAGE_VERSION)$/.test(r.failure?.code ?? '');
      if (checkFailed(ts) !== (program.checks === false)) {
        problems.push(`${where}\n  ${checkFailed(ts) ? `does not check: ${'failure' in ts ? (ts.failure?.message ?? '') : ''}` : 'checks, yet says the checker refuses it'}`);
      }
      const names = reasons.some((r) => patternOf(r, [pattern.reason]) !== undefined);
      // A program the checker refuses ends at the check the Rust route makes
      // before its segment opens, as the TypeScript route does: it is
      // `unreached`, and says so (its own `routes`, or its pattern's); one
      // that ends where it does not say fails the generator.
      const expected = program.routes ?? pattern.routes;
      if (expected === 'unreached') {
        // The checker refuses every program holding it (the Rust engine's
        // admission may name it first, and both engines end at the check),
        // or both entries refuse it before it is routed at all.
        if (routes !== 'unreached') problems.push(`${where}\n  routes ${routes} (${reasons.join(', ')}), yet says it is unreached: one the checker refuses, or one never routed`);
        if (JSON.stringify(ending(ts)) !== JSON.stringify(ending(rust))) problems.push(`${where}\n  the check ended the engines differently`);
      } else {
        if (routes !== expected) problems.push(`${where}\n  routes ${routes} (${reasons.join(', ')}), the pattern says ${expected}`);
        // A program whose own routes say otherwise than its pattern's (a
        // form that declines for another reason) need not name it.
        if (routes !== 'whole' && !names && program.routes === undefined) problems.push(`${where}\n  ${routes} for ${reasons.join(', ')}, not for ${pattern.reason}`);
        for (const retired of retiredReasons(routes, reasons, status)) problems.push(`${where}\n  ${retired}`);
      }
      let agreement: CaseRecord['agreement'];
      if (expected === 'unreached') {
        agreement = 'check';
      } else if (routes === 'whole') {
        const same = requestsOf(ts) === requestsOf(rust) && JSON.stringify(canonical(ending(ts))) === JSON.stringify(canonical(ending(rust)));
        if (process.env.PATTERNS_DEBUG !== undefined && !same) {
          const [a, b] = [JSON.parse(requestsOf(ts)) as unknown[], JSON.parse(requestsOf(rust)) as unknown[]];
          const at = a.findIndex((r, i) => JSON.stringify(r) !== JSON.stringify(b[i]));
          console.error('DIFF', where, at, JSON.stringify(a[at]), '\n   vs', JSON.stringify(b[at]), a.length, b.length);
          console.error('  TS ENDING', JSON.stringify(ending(ts)).slice(0, 600));
          console.error('  RUST ENDING', JSON.stringify(ending(rust)).slice(0, 600));
        }
        // The kit's verdict on every whole run, not only where the two
        // recordings differ: the TypeScript recording replayed through the
        // Rust target must end with the same result (each write's
        // provenance, each extraction site's dataSources), not only after
        // the same requests.
        const verdict = await Promise.race([
          rustTarget.replay(ts),
          new Promise<{ kind: 'skipped'; reason: string }>((resolve) => setTimeout(() => resolve({ kind: 'skipped', reason: 'the replay never ended' }), 20_000)),
        ]);
        if (verdict.kind !== 'same') problems.push(`${where}\n  the engines disagree: ${verdict.kind === 'diverged' ? verdict.divergence : verdict.reason}`);
        else agreement = same ? 'exact' : 'kit';
      } else if (JSON.stringify(ending(ts)) !== JSON.stringify(ending(rust))) {
        problems.push(`${where}\n  refused, yet its fallback ended otherwise than the TypeScript run`);
      }
      cases.push({
        pattern: pattern.reason,
        program,
        routes,
        reasons,
        ...(agreement !== undefined ? { agreement } : {}),
        requests: ts.requests.map((r) => `${r.family}.${r.method}`),
        ending: ending(ts),
      });
    }
  }
  if (only !== undefined) {
    console.log(JSON.stringify(cases.map((c) => ({ pattern: c.pattern, routes: c.routes, reasons: c.reasons, ending: c.ending })), null, 1).slice(0, 20000));
  }
  // A pattern that says it reaches the engine proves it with at least one
  // program that does.
  for (const pattern of PATTERNS) {
    if (pattern.routes === 'unreached' || (only !== undefined && !only.test(pattern.reason))) continue;
    if (!cases.some((c) => c.pattern === pattern.reason && c.routes !== 'unreached')) {
      problems.push(`${pattern.reason}\n  says it routes ${pattern.routes}, yet none of its programs reaches the engine`);
    }
  }
  if (problems.length > 0) throw new Error(`patterns oracle: ${problems.length} problem(s)\n${problems.join('\n')}`);
  const patterns = PATTERNS.map(({ reason, routes, note }) => ({ reason, routes, note, programs: cases.filter((c) => c.pattern === reason).length }));
  write(
    'patterns.json',
    `{"seed":20261015,"prelude":${JSON.stringify(PATTERNS_PRELUDE)},"patterns":[\n${patterns.map((p) => JSON.stringify(p)).join(',\n')}\n],"cases":[\n${cases.map((c) => JSON.stringify(c)).join(',\n')}\n]}\n`,
  );
  console.log(`patterns.json: ${PATTERNS.length} patterns, ${cases.length} programs (${cases.filter((c) => c.routes === 'whole').length} whole on Rust)`);
}

