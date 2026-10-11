// handles.json: language version 4's write handles (Luminous Owl) run on the
// TypeScript engine, which tests/handles_oracle.rs holds the Rust engine to
// (PLAN-07A Task 4c). Written by generate.ts; deterministic.
//
// Each case is a seeded program over one CRM holding two companies, written
// to through it and through a rehearsing (`dry_run`) instance of it:
//   - writes with an identity (`unique by`) and without one, which find a
//     company only when the CRM matches by its own rule (the world's
//     `finds: 'always'`), with `:` and `?:` fields;
//   - writes through a handle (`write h { … }`, `x = write h { … }`): the
//     handle updated in place;
//   - matches, named and guarded, that hit or miss, a write through what
//     one found; a judge (scripted per case) asked when the rules cannot
//     decide, or out;
//   - writes through a traversal landing, and per member of a MAP;
//   - reads off each handle, written into notes so the CRM receives them:
//     its fields (the record as found, for a field the write did not set),
//     `-[:@old]->` picked, tested, compared with the handle, walked twice,
//     and a block over it;
//   - now and then a sleep, so the run parks with every handle in scope.
//
// The world varies per case: whether the CRM matches by name or by its own
// rule (every company, whatever was asserted), whether it can read a record
// back (`readRecord`), and what the judge answers. A case records every call
// the CRM received, as its fake records them (a rehearsed instance's creates
// and updates are captured by the host's rehearsal, so the CRM never sees
// them), the run's writes as the result hands them back (each with its
// record as found, without the engine's own `old`), the trace, the parked
// state, and how the run ended.

import { checkAnswer, checkPinned } from '../../../../apps/api/src/services/movement_engine/program_check';
import { mockCatalogSnapshot, type InstanceSchema } from '../../../../packages/movement-lang';
import { tenantIdOf } from '../../../../packages/engine-contracts';
import { MovementEngineError } from '../../../../apps/api/src/services/movement_engine/errors';
import { runFailureCause, runMovement } from '../../../../apps/api/src/services/movement_engine/run';
import { credentialIdsFor, makeFakeParkSink, makeTestHost } from '../../../../apps/api/src/services/movement_engine/test_host';
import type { Adapter } from '../../../../apps/api/src/services/translation_graph/adapter';
import { containerAssociation } from '../../../../apps/api/src/services/translation_graph/adapter';
import { makeStablePosition, positionData } from '../../../../apps/api/src/services/translation_graph/types';

type Rand = () => number;

const crmSchema: InstanceSchema = {
  positions: {
    message: { properties: { subject: 'text' }, edges: {} },
    company: { properties: { name: 'text', domain: 'text' }, edges: { notes: { target: 'note', writable: true } } },
    note: { properties: { title: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  writableRoots: {
    company: { fields: { name: 'text', domain: 'text' }, resultShape: { externalId: 'text', name: 'text', domain: 'text' }, fuzzyResolution: true },
    note: { fields: { title: 'text' }, resultShape: { externalId: 'text', title: 'text' } },
  },
  supportsInPlaceUpdate: true,
};

export const HANDLES_CATALOG = mockCatalogSnapshot({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: crmSchema },
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: crmSchema },
  },
  credentials: { inbox_cred: { adapters: ['email'] }, acme_main: { adapters: ['attio'] } },
});

export const HANDLES_PRELUDE = [
  'import { email, attio } from adapters',
  'import { inbox_cred, acme_main } from credentials',
  'inbox = email(credentials: inbox_cred)',
  'movement m(msg: <inbox-[:message]->>) {',
  '  crm = attio(credentials: acme_main)',
  '  rehearsed = attio(credentials: acme_main, dry_run: true)',
  'BODY',
  '}',
].join('\n');

/** The CRM's companies before each run. */
export const HANDLES_COMPANIES = [
  { externalId: 'co-1', data: { name: 'Acme Incorporated', domain: 'old.example' } },
  { externalId: 'co-2', data: { name: 'Beta Ltd', domain: 'beta-old.example' } },
];

interface World {
  /** `byName`: a company whose name is the asserted one; `always`: every
   *  company, whatever was asserted (an adapter matching by its own rule). */
  finds: 'byName' | 'always';
  /** Whether the CRM reads a record back (`readRecord`). */
  reads: boolean;
  /** What the judge answers: a candidate's index, none, or an outage. */
  judge: 0 | 1 | null | 'outage';
}

function pick<T>(rand: Rand, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

const NAMES = ['Acme Incorporated', 'Beta Ltd', 'Newco'];
const DOMAINS = ['new.example', 'old.example', 'second.example', 'third.example'];

/** A program's statements, written by `Program` as it goes. */
class Program {
  private lines: string[] = [];
  private next = 0;
  /** Names bound to a write's handle, readable anywhere below. */
  private handles: string[] = [];
  private parked = false;

  constructor(private readonly rand: Rand) {}

  private fresh(prefix: string): string {
    return `${prefix}${this.next++}`;
  }

  private emit(indent: string, line: string): void {
    this.lines.push(`${indent}${line}`);
  }

  /** A note whose title is what the program reads, so the CRM receives it. */
  private note(indent: string, title: string): void {
    this.emit(indent, `write crm-[:notes]-> { title: ${title} }`);
  }

  /** One reading of handle `h`, written into a note. */
  private read(indent: string, h: string): void {
    const rand = this.rand;
    const roll = rand();
    if (roll < 0.12) return this.note(indent, `COALESCE(${h}.\`domain\`, "none")`);
    if (roll < 0.22) return this.note(indent, `COALESCE(${h}.\`name\`, "none")`);
    if (roll < 0.32) return this.note(indent, `IF EXISTS(${h}-[:@old]->) THEN "matched" ELSE "created" END`);
    if (roll < 0.42) return this.note(indent, `IF FIRST(${h}-[:@old]->) == ${h} THEN "self" ELSE "other" END`);
    if (roll < 0.52) return this.note(indent, `COALESCE(FIRST(${h}-[:@old]->).\`domain\`, "none")`);
    if (roll < 0.58) return this.note(indent, `COALESCE(${h}.externalId, "none")`);
    if (roll < 0.64) return this.note(indent, `"\${COUNT(${h}-[:@old]->)}"`);
    if (roll < 0.68) {
      const w = this.fresh('w');
      return this.note(indent, `COALESCE(FIRST(${h}-[${w}:@old WHERE ${w}.\`domain\` == "${pick(rand, DOMAINS)}"]->).\`name\`, "none")`);
    }
    if (roll < 0.72) {
      const w = this.fresh('w');
      return this.note(indent, `IF EXISTS(${h}-[${w}:@old WHERE ${w}.\`name\` == ${h}.\`name\`]->) THEN "kept" ELSE "not" END`);
    }
    if (roll < 0.76) {
      // A parent link carries what the parent's own write got back, never
      // the record it found.
      return this.emit(indent, `write ${h}-[:notes]-> { title: COALESCE(${h}.\`domain\`, "none") }`);
    }
    if (roll < 0.8) {
      // The chain walked in two steps, as a hop off a call does not parse.
      const was = this.fresh('was');
      this.emit(indent, `${was} = FIRST(${h}-[:@old]->)`);
      this.emit(indent, `if ${was} != null {`);
      this.note(`${indent}  `, `COALESCE(${was}.\`domain\`, "none")`);
      this.note(`${indent}  `, `IF ${was} == ${h} THEN "same" ELSE "distinct" END`);
      this.note(`${indent}  `, `IF EXISTS(${was}-[:@old]->) THEN "older" ELSE "first" END`);
      this.note(`${indent}  `, `COALESCE(FIRST(${was}-[:@old]->).\`domain\`, "none")`);
      this.emit(indent, '}');
      return;
    }
    if (roll < 0.9) {
      const w = this.fresh('w');
      this.emit(indent, `${h}-[${w}:@old]-> {`);
      this.note(`${indent}  `, `COALESCE(${w}.\`domain\`, "none")`);
      this.emit(indent, '}');
      return;
    }
    const w = this.fresh('w');
    this.emit(indent, `${h}-[${w}:@old WHERE ${w}.\`domain\` == "${pick(rand, DOMAINS)}"]-> {`);
    this.note(`${indent}  `, `COALESCE(${w}.\`name\`, "none")`);
    this.emit(indent, '}');
  }

  /** A field line of a company: `name` as asserted, `domain` set or filled. */
  private fields(name: string): string {
    const mode = this.rand() < 0.25 ? '?:' : ':';
    return `name: ${name}, domain ${mode} "${pick(this.rand, DOMAINS)}"`;
  }

  private statement(indent: string, depth: number): void {
    const rand = this.rand;
    const roll = rand();
    const instance = rand() < 0.25 ? 'rehearsed' : 'crm';
    const name = `"${pick(rand, NAMES)}"`;
    if (roll < 0.22 || this.handles.length === 0) {
      const h = this.fresh('h');
      const fuzzy = rand() < 0.15 ? 'FUZZY ' : '';
      this.emit(indent, `${h} = write ${instance}-[:companies]-> { unique by (${fuzzy}\`name\`), ${this.fields(name)} }`);
      this.handles.push(h);
      return;
    }
    if (roll < 0.32) {
      const h = this.fresh('h');
      this.emit(indent, `${h} = write ${instance}-[:companies]-> { ${this.fields(name)} }`);
      this.handles.push(h);
      return;
    }
    if (roll < 0.47) return this.read(indent, pick(rand, this.handles));
    if (roll < 0.57) {
      const h = pick(rand, this.handles);
      if (rand() < 0.5) {
        this.emit(indent, `write ${h} { domain: "${pick(rand, DOMAINS)}" }`);
      } else {
        const x = this.fresh('x');
        this.emit(indent, `${x} = write ${h} { domain ${rand() < 0.25 ? '?:' : ':'} "${pick(rand, DOMAINS)}" }`);
        this.note(indent, `IF ${x} == ${h} THEN "same" ELSE "distinct" END`);
        this.handles.push(x);
      }
      return;
    }
    if (roll < 0.7) {
      const m = this.fresh('m');
      const fuzzy = rand() < 0.2;
      this.emit(indent, `${m} = match crm-[:companies]-> { unique by (${fuzzy ? 'FUZZY ' : ''}\`name\`), name: ${name} }`);
      this.note(indent, `IF ${m} == null THEN "absent" ELSE COALESCE(${m}.\`domain\`, "none") END`);
      this.emit(indent, `if ${m} != null {`);
      if (rand() < 0.6) {
        const x = this.fresh('x');
        this.emit(`${indent}  `, `${x} = write ${m} { domain: "${pick(rand, DOMAINS)}" }`);
        this.note(`${indent}  `, `COALESCE(${m}.\`domain\`, "none")`);
        this.read(`${indent}  `, x);
      } else {
        this.note(`${indent}  `, `COALESCE(${m}.\`name\`, "none")`);
      }
      this.emit(indent, '}');
      return;
    }
    if (roll < 0.78 && depth === 0) {
      const c = this.fresh('c');
      const x = this.fresh('x');
      this.emit(indent, `crm-[${c}:companies]-> {`);
      this.emit(`${indent}  `, `${x} = write ${c} { domain: "${pick(rand, DOMAINS)}" }`);
      this.read(`${indent}  `, x);
      this.emit(indent, '}');
      return;
    }
    if (roll < 0.86 && depth === 0) {
      const o = this.fresh('o');
      this.emit(indent, `MAP(["${pick(rand, NAMES)}", "${pick(rand, NAMES)}"], (n) => {`);
      this.emit(`${indent}  `, `${o} = write ${instance}-[:companies]-> { unique by (\`name\`), ${this.fields('n')} }`);
      this.read(`${indent}  `, o);
      this.emit(indent, '})');
      return;
    }
    if (roll < 0.92 && depth === 0) {
      this.emit(indent, 'if TRUE {');
      this.statement(`${indent}  `, depth + 1);
      this.emit(indent, '}');
      return;
    }
    if (!this.parked && depth === 0 && rand() < 0.5) {
      this.parked = true;
      this.emit(indent, 'await sleep(1h)');
      return;
    }
    this.read(indent, pick(rand, this.handles));
  }

  body(): string {
    const count = 2 + Math.floor(this.rand() * 6);
    for (let i = 0; i < count; i++) this.statement('  ', 0);
    return this.lines.join('\n');
  }
}

function world(rand: Rand): World {
  return {
    finds: rand() < 0.35 ? 'always' : 'byName',
    reads: rand() < 0.8,
    judge: pick(rand, [0, 1, null, 'outage'] as const),
  };
}

/** The CRM as the world says, recording each call it receives. */
function crm(w: World, calls: unknown[]): Adapter {
  const stored = new Map(HANDLES_COMPANIES.map((c) => [c.externalId, { ...c.data } as Record<string, unknown>]));
  let created = 0;
  const companies = () => [...stored.entries()].map(([externalId, data]) => ({ adapterType: 'attio', externalId, data: { ...data } }));
  const adapter: Adapter = {
    adapterType: 'attio',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    async resolveEntity({ recordType, record }) {
      calls.push(['resolveEntity', recordType, record]);
      if (recordType !== 'company') return { candidates: [] };
      const all = companies();
      return { candidates: w.finds === 'always' ? all : all.filter((c) => c.data.name === record.name) };
    },
    async getFieldValue({ position, fieldId }) {
      return (positionData(position) as Record<string, unknown> | undefined)?.[fieldId] ?? null;
    },
    async getRelated({ fieldId }) {
      calls.push(['getRelated', fieldId]);
      if (fieldId !== 'companies') return [];
      return companies().map((c) => ({
        position: makeStablePosition({ adapterType: 'attio', recordType: 'company', recordId: c.externalId, data: c.data }),
      }));
    },
    async createRecord(input) {
      calls.push(['createRecord', input.recordType, input.fields, ...(input.parentLinks?.length ? [input.parentLinks] : [])]);
      created += 1;
      return { adapterType: 'attio', externalId: `ext-${created}`, data: {} };
    },
    async updateRecord(input) {
      calls.push(['updateRecord', input.externalId, input.fields]);
      const current = stored.get(input.externalId);
      if (current !== undefined) Object.assign(current, input.fields);
      return { adapterType: 'attio', externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    deleteRecord: async () => ({}),
  };
  if (w.reads) {
    adapter.readRecord = async ({ externalId, fieldIds }) => {
      calls.push(['readRecord', externalId, fieldIds ?? null]);
      const data = stored.get(externalId);
      return data === undefined ? null : { ...data };
    };
  }
  return adapter;
}

const inbox: Adapter = {
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

/** A value as JSON writes it: what a JSON host would have received. */
function json(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

export async function writeHandlesOracle(rand: Rand, write: (name: string, text: string) => void): Promise<void> {
  const cases: string[] = [];
  let refused = 0;
  for (let i = 0; i < 1000; i++) {
    const text = new Program(rand).body();
    const w = world(rand);
    const source = HANDLES_PRELUDE.replace('BODY', text);
    let check: unknown;
    try {
      check = checkAnswer(checkPinned({ source, catalog: HANDLES_CATALOG, languageVersion: 4 }));
    } catch {
      refused += 1;
      continue;
    }
    const calls: unknown[] = [];
    const trace: unknown[] = [];
    const park = makeFakeParkSink();
    const adapter = crm(w, calls);
    const judge = w.judge;
    let outcome: unknown;
    let writes: unknown = null;
    try {
      const result = await runMovement({
        source,
        languageVersion: 4,
        event: { pipelineInputId: 'p', adapterType: 'email', triggerType: 'webhook', payload: { subject: 'Acme' } },
        catalog: HANDLES_CATALOG,
        teamId: tenantIdOf('00000000-0000-0000-0000-0000000000c4'),
        credentialIds: credentialIdsFor(HANDLES_CATALOG, (name) => `cred-${name}`),
        host: makeTestHost({
          adapters: { resolve: ({ adapterType }) => (adapterType === 'attio' ? adapter : inbox) },
          llm: {
            arbitrateEntities: async () =>
              judge === 'outage' ? { index: null, judgeUnavailable: 'anthropic 529', cost: [] } : { index: judge, cost: [] },
          },
          park: { sink: park.sink },
          trace: trace as never[],
        }),
      });
      outcome = { completed: true, parked: result.parked === true };
      writes = json(result.writes.map(({ old: _old, ...record }) => record));
    } catch (error) {
      outcome = { error: ending(error) };
    }
    const parked = park.timerParks.map((p) => ({ address: p.address, state: JSON.stringify(p.state), wakeAt: p.wakeAt }));
    cases.push(JSON.stringify({ body: text, world: w, check, calls: json(calls), writes, trace: json(trace), parked, outcome }));
  }
  write(
    'handles.json',
    `{"catalog":${JSON.stringify(HANDLES_CATALOG)},"prelude":${JSON.stringify(HANDLES_PRELUDE)},"companies":${JSON.stringify(HANDLES_COMPANIES)},"cases":[\n${cases.join(',\n')}\n]}\n`,
  );
  console.log(`handles.json: ${cases.length} cases (${refused} refused by the checker and left out)`);
}
