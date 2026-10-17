// patterns.json: what the Rust engine, the version 5 reference, does with
// each pattern of the language. Every program of patterns_table.ts runs
// once, in its version 5 spelling (the upgrade tool's own rewrites), on the
// Rust engine through the real entry points and the real shim against one
// scripted host, recorded at the host boundary (the conformance kit's
// recorder): every request it made, and how the entry ended.
//
// How a program ends (`ends`):
//   - `whole`: the engine ran it, to its result or its own runtime failure;
//   - `at_check`: the check refused it before a segment opened (it does not
//     parse, does not check, or is pinned to a version this release does
//     not run), with no host request made;
//   - `unsupported`: it checked clean, yet the engine refused it
//     (MOVENG_UNSUPPORTED) by a named reason: a checker or engine bug, which
//     the generator accepts only where the reachability test's list of open
//     gaps (reachability_gaps.ts) names it;
//   - `unrecordable`: the shim refused its event, which the eval wire cannot
//     carry as itself;
//   - `state_refused`: a resume whose parked state the engine refused (a
//     corrupt or foreign record) by a named reason, before it asked its host
//     for anything.
// A program that ends otherwise than its pattern (or itself) says fails the
// generator, and so does a shim fault: the committed file is the inventory,
// and the one-command report (patterns_report.ts, `pnpm engine:patterns`)
// reads it.
//
// Written by generate.ts (seed 20261015); deterministic: the scripted host
// answers from the program alone (a fixed clock, ids in order asked).

import { fromCatalogSnapshot, mockCatalogSnapshot, resolveFileFromSnapshot, type InstanceSchema, type PluginSpec } from '../../../../packages/movement-lang';
import { spelledFor } from '../../../../packages/movement-lang/checker/__test__/surface_spelling';
import { tenantIdOf } from '../../../../packages/engine-contracts';
import type { HostRecording } from '../../../../packages/engine-contracts/conformance';
import { recordEntry, recordedError } from '../../../../apps/api/src/services/movement_engine/conformance/recorder';
import { KNOWN_GAPS, reasonOf } from '../../../../apps/api/src/services/movement_engine/__test__/reachability_gaps';
import { resumeMovement, runMovement } from '../../../../packages/movement-engine/services/movement_engine/run';
import { EVENT_DOES_NOT_CROSS } from '../../../../packages/movement-engine/services/movement_engine/rust_engine';
import { resetRustRunStats, rustRunStats } from '../../../../packages/movement-engine/services/movement_engine/rust_stats';
import { credentialIdsFor, makeFakeParkSink, makeTestHost } from '../../../../packages/movement-engine/services/movement_engine/test_host';
import { staticCatalogFromManifests } from '../../../../apps/api/src/services/translation_graph/movement/catalog';
import type { ActingUser, Adapter, RelatedResult } from '../../../../packages/movement-engine/services/translation_graph/adapter';
import { containerAssociation } from '../../../../packages/movement-engine/services/translation_graph/adapter';
import { makeStablePosition, makeUnstablePosition, positionData } from '../../../../packages/movement-engine/services/translation_graph/types';

import { PATTERNS, type Ends, type Pick, type Program } from './patterns_table';

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

/** What every program's file starts with, in its version 5 spelling. */
export const PATTERNS_PRELUDE = [
  'import { email, attio } from adapters',
  'import { inbox_cred, crm_cred } from credentials',
  'inbox = connect email using inbox_cred',
  'crm = connect attio using crm_cred',
  '',
].join('\n');

const COMPANIES = [
  { id: 'co-1', data: { name: 'Acme', stage: 'Seed', domain: 'acme.example', summary: 'anvils', employees: 12 } },
  { id: 'co-2', data: { name: 'Beta', stage: 'Series A', domain: 'beta.example', summary: 'boats', employees: 40 } },
];

/** The CRM: two companies, each with a note, a deal and a person; writes
 *  answered in order. Built fresh per run, so each run meets it as new. */
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

// ── Running a program ────────────────────────────────────────────────────────

const TEAM = tenantIdOf('00000000-0000-0000-0000-0000000000f6');

/** The version a program runs under: 5, the version the Rust engine is the
 *  reference for, unless it is pinned past it on purpose (a version this
 *  release does not run). */
const versionOf = (program: Program) => Math.max(program.version ?? 5, 5);

export function sourceOf(program: { body?: string; file?: string }): string {
  if (program.file !== undefined) return PATTERNS_PRELUDE + program.file;
  return `${PATTERNS_PRELUDE}movement m(msg: <inbox-[:message]->>) {\n${program.body ?? ''}\n}`;
}

function catalogOf(program: Program): typeof PATTERNS_CATALOG {
  return program.files !== undefined ? { ...PATTERNS_CATALOG, files: program.files } : PATTERNS_CATALOG;
}

/** `source` as version 5 spells it: the table writes its programs (and their
 *  library files) in the spelling versions 1–4 read, respelled here by the
 *  upgrade tool's own rewrites (the `MOV_V5_*` fixes, nothing else). */
function respelled(source: string, catalog: typeof PATTERNS_CATALOG): string {
  const resolveFile = resolveFileFromSnapshot(catalog);
  return spelledFor(5, source, fromCatalogSnapshot(catalog), resolveFile !== undefined ? { resolveFile } : {});
}

/** The program as it runs: its file (after the prelude) and its library
 *  files in their version 5 spelling, under the version it runs at. */
function spelledProgram(program: Program): Program {
  const files =
    program.files === undefined
      ? undefined
      : Object.fromEntries(Object.entries(program.files).map(([name, file]) => [name, { ...file, source: respelled(file.source, PATTERNS_CATALOG) }]));
  const { body: _body, file: _file, files: _files, ...rest } = program;
  const spelled = { ...rest, ...(files !== undefined ? { files } : {}), version: versionOf(program) };
  const source = respelled(sourceOf(program), catalogOf(spelled));
  if (!source.startsWith(PATTERNS_PRELUDE)) throw new Error(`patterns oracle: the upgrade rewrote the prelude of ${program.body ?? program.file}`);
  return { ...spelled, file: source.slice(PATTERNS_PRELUDE.length) };
}

/** The run's input but its host. */
function runInput(program: Program) {
  const catalog = catalogOf(program);
  return {
    source: sourceOf(program),
    languageVersion: versionOf(program),
    ...(program.movementName !== undefined ? { movementName: program.movementName } : {}),
    event: { pipelineInputId: 'pi-patterns', adapterType: 'email', triggerType: 'webhook' as const, payload: { ...EVENT_PAYLOAD, ...program.payload } },
    catalog,
    teamId: TEAM,
    credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
  };
}

/** The parked state a resume program resumes: its run's first timer park,
 *  as `program.resume` makes it. */
async function parkedState(program: Program): Promise<unknown> {
  const park = makeFakeParkSink();
  const failed = await runMovement({ ...runInput(program), host: scriptedHost(program.replies ?? [], park, program.answers) }).then(
    () => undefined,
    (error: unknown) => String(error),
  );
  const first = park.timerParks[0];
  if (first === undefined || program.resume === undefined) {
    throw new Error(`patterns oracle: a resume program never parked (${failed ?? 'it ran to its end'}): ${program.file}`);
  }
  return program.resume(JSON.parse(JSON.stringify(first.state)) as Record<string, unknown>);
}

/** A run of a program whose input JSON cannot carry, so the recorder
 *  refuses it: how it ended, and no requests. */
async function direct(program: Program): Promise<HostRecording> {
  const outcome = await runMovement({ ...runInput(program), host: scriptedHost(program.replies ?? [], undefined, program.answers) }).then(
    (result) => ({ result: JSON.parse(JSON.stringify(result)) as unknown }),
    (error: unknown) => ({ failure: recordedError(error) }),
  );
  return { kit: 'host', version: 2, entry: 'run', input: {}, methods: [], requests: [], ...outcome } as unknown as HostRecording;
}

/** A run of `program` (or its resume of `state`), recorded at the host
 *  boundary. */
async function recorded(program: Program, state?: unknown): Promise<HostRecording | undefined> {
  let kept: HostRecording | undefined;
  const keep = (recording: HostRecording) => {
    kept = recording;
  };
  const host = scriptedHost(program.replies ?? [], undefined, program.answers);
  // A run that never ends (a promise nothing settles) would end the process
  // silently: it is reported instead.
  let stalled: NodeJS.Timeout | undefined;
  const stall = new Promise<void>((resolve) => {
    stalled = setTimeout(resolve, 20_000);
  });
  await Promise.race([
    stall,
    (state === undefined
      ? recordEntry({ entry: 'run', input: { ...runInput(program), host }, run: (input) => runMovement(input), keep })
      : recordEntry({ entry: 'resume', input: { ...runInput(program), state: state as never, host }, run: (input) => resumeMovement(input), keep })
    ).catch(() => undefined),
  ]);
  clearTimeout(stalled);
  return kept;
}

const STATE_REFUSED = /^MOVENG_UNSUPPORTED: this run's parked state does not read \(([^)]+)\)$/;

/** How a run just made ended, and the reason a refusal names. */
function endOf(recording: HostRecording): { ends: Ends; reason?: string } {
  if (!('failure' in recording) || recording.failure === undefined) return { ends: 'whole' };
  const { code, message } = recording.failure;
  if (code === 'MOVENG_PARSE' || code === 'MOVENG_CHECK' || code === 'MOVENG_LANGUAGE_VERSION') return { ends: 'at_check' };
  if (code !== 'MOVENG_UNSUPPORTED') return { ends: 'whole' };
  if (rustRunStats.unsupported[EVENT_DOES_NOT_CROSS] !== undefined) return { ends: 'unrecordable', reason: EVENT_DOES_NOT_CROSS };
  // A resume's parked state the engine cannot read fails the resume naming
  // why (crates/movement-engine/src/run.rs): a refusal of the state, not of
  // the program.
  const refused = recording.entry === 'resume' ? STATE_REFUSED.exec(message)?.[1] : undefined;
  if (refused !== undefined) return { ends: 'state_refused', reason: refused };
  return { ends: 'unsupported', reason: reasonOf(message) };
}

/** The unsupported-version refusal names the CURRENT language version
 *  (`"Dancing Wren" (5)`), which changes every release: an ending is written
 *  to patterns.json with that name and number masked, the message's shape
 *  otherwise exact. */
function maskCurrentVersion<T>(failure: T): T {
  if (failure === null || typeof failure !== 'object') return failure;
  const f = failure as { code?: string; message?: string };
  if (f.code !== 'MOVENG_LANGUAGE_VERSION' || typeof f.message !== 'string') return failure;
  return { ...f, message: f.message.replace(/"[A-Z][a-z]+ [A-Z][a-z]+" \(\d+\)/g, '"<current version name>" (<current version number>)') } as T;
}

/** How an entry ended, as the report keeps it. */
function ending(recording: HostRecording): unknown {
  if ('failure' in recording) return { failure: maskCurrentVersion(recording.failure) };
  return { result: recording.result };
}

export interface CaseRecord {
  pattern: string;
  /** As it ran: its version 5 spelling. */
  program: Program;
  ends: Ends;
  /** What an `unsupported`, `unrecordable` or `state_refused` ending names. */
  reason?: string;
  requests: string[];
  ending: unknown;
}

/** Every program of the table run, as recorded, and what is wrong with the
 *  record (PATTERNS_ONLY, a pattern-name pattern, runs only those). */
export async function runPatterns(rand: Rand): Promise<{ cases: CaseRecord[]; problems: string[] }> {
  const pick: Pick = (items) => items[Math.floor(rand() * items.length)]!;
  const cases: CaseRecord[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  const only = process.env.PATTERNS_ONLY !== undefined ? new RegExp(process.env.PATTERNS_ONLY) : undefined;
  for (const pattern of PATTERNS) {
    if (only !== undefined && !only.test(pattern.name)) continue;
    for (const make of pattern.programs) {
      const written = make(pick);
      const where = `${pattern.name}: ${JSON.stringify(written.body ?? written.file)}`;
      let program: Program;
      try {
        program = spelledProgram(written);
      } catch (error) {
        problems.push(`${where}\n  does not respell to version 5: ${String(error)}`);
        continue;
      }
      if (process.env.PATTERNS_DEBUG !== undefined) console.error('CASE', pattern.name, JSON.stringify(program.file));
      const key = JSON.stringify({ ...program, resume: program.resume?.toString() });
      if (seen.has(key)) problems.push(`${where}\n  spells the same at version 5 as another program of the table`);
      seen.add(key);
      const state = program.resume !== undefined ? await parkedState(program) : undefined;
      resetRustRunStats();
      const recording = program.unrecordable === true ? await direct(program) : await recorded(program, state);
      if (recording === undefined) {
        problems.push(`${where}\n  kept no recording (it never ended within 20 s, or its input is not JSON)`);
        continue;
      }
      if (rustRunStats.shimFaults > 0) problems.push(`${where}\n  a shim fault: ${JSON.stringify(ending(recording))}`);
      const { ends, reason } = endOf(recording);
      const expected = program.ends ?? pattern.ends;
      const said = 'failure' in recording ? ` (${JSON.stringify(recording.failure?.message ?? '')})` : '';
      if (ends !== expected) problems.push(`${where}\n  ends ${ends}${said}, yet says it ends ${expected}`);
      if (ends === 'unsupported' && !KNOWN_GAPS.includes(reason!)) {
        problems.push(`${where}\n  checks clean, yet the engine refuses it, by a gap reachability_gaps.ts does not list (a checker or engine bug)${said}`);
      }
      const { resume: _resume, ...stored } = program;
      cases.push({
        pattern: pattern.name,
        program: stored,
        ends,
        ...(reason !== undefined ? { reason } : {}),
        requests: recording.requests.map((r) => `${r.family}.${r.method}`),
        ending: ending(recording),
      });
    }
  }
  // A pattern proves where it ends with at least one program that ends so.
  for (const pattern of PATTERNS) {
    if (only !== undefined && !only.test(pattern.name)) continue;
    if (!cases.some((c) => c.pattern === pattern.name && c.ends === pattern.ends)) {
      problems.push(`${pattern.name}\n  says it ends ${pattern.ends}, yet none of its programs does`);
    }
  }
  return { cases, problems };
}

export async function writePatternsOracle(rand: Rand, write: (name: string, text: string) => void): Promise<void> {
  if (process.env.PATTERNS_ONLY !== undefined) throw new Error('patterns oracle: PATTERNS_ONLY runs a part of the table, which writes no patterns.json');
  const { cases, problems } = await runPatterns(rand);
  if (problems.length > 0) throw new Error(`patterns oracle: ${problems.length} problem(s)\n${problems.join('\n')}`);
  const patterns = PATTERNS.map(({ name, ends, note }) => ({ name, ends, note, programs: cases.filter((c) => c.pattern === name).length }));
  write(
    'patterns.json',
    `{"seed":20261015,"prelude":${JSON.stringify(PATTERNS_PRELUDE)},"patterns":[\n${patterns.map((p) => JSON.stringify(p)).join(',\n')}\n],"cases":[\n${cases.map((c) => JSON.stringify(c)).join(',\n')}\n]}\n`,
  );
  const count = (ends: Ends) => cases.filter((c) => c.ends === ends).length;
  console.log(
    `patterns.json: ${PATTERNS.length} patterns, ${cases.length} programs (${count('whole')} whole, ${count('at_check')} at the check, ${count('unsupported')} unsupported, ${count('unrecordable')} unrecordable, ${count('state_refused')} parked states refused)`,
  );
}
