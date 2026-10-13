// Language version 5, Dancing Wren, on both engines (the main merge's mirror
// list). Each program runs under MOVEMENT_ENGINE=ts and =rust against the
// same fakes, and the two must agree on the result or the error, on every
// call the adapters received, and on how the Rust run ended.
//
// - `_resources` off an adapter's record: versions 1–4 read the record's
//   bundle through the event's adapter (the mirrored quirk included); under 5
//   the checker refuses the hop, and an engine that meets it anyway refuses
//   it before the host is asked for the reserved reference.
// - The knowledge graph's `Resources` edge: an ordinary edge, walked by its
//   name and sent to the adapter by its reserved field id (kg.ts
//   `surfaceReadAdapter`), its landing's `Name` / `URL` / `Type` read through
//   `getFieldValue` — on every version.

import { mockCatalogSnapshot, type InstanceSchema, type LanguageVersion } from 'movement-lang';
import { tenantIdOf } from 'engine-contracts';

import { containerAssociation, type Adapter } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';

import { makeStablePosition, makeUnstablePosition, positionData } from '../../translation_graph/types';
import { makeTestHost, endedInRust } from '../test_host';
import { runFailureCause, runMovement } from '../run';
import { MovementEngineError, isCheckFailure } from '../errors';
import { resetRustEvalStats, resetRustRunStats, rustRunStats } from '../rust_stats';

/** Diagnostic codes the checker is made to miss, so a run reaches the
 *  engine's own guard as a program the checker let by would. */
const mockCheckerMisses = new Set<string>();

jest.mock('movement-lang', () => {
  const actual = jest.requireActual('movement-lang');
  return {
    ...actual,
    checkProgramWithLink: (...args: unknown[]) => {
      const checked = actual.checkProgramWithLink(...args);
      return { ...checked, diagnostics: checked.diagnostics.filter((d: { code: string }) => !mockCheckerMisses.has(d.code)) };
    },
  };
});

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000d5');

/** What both engines read a resource landing's fields as (the knowledge
 *  graph's `KG_RESOURCE_FIELDS`). */
const RESOURCE_TYPE = 'Attached Resource';
const RESOURCE_FIELDS: Readonly<Record<string, string>> = { Name: 'name', URL: 'url', Type: 'type' };

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

const graphSchema: InstanceSchema = {
  positions: {
    Company: {
      properties: { name: 'text' },
      edges: { Resources: { target: RESOURCE_TYPE, resources: true } },
      deletable: true,
    },
    [RESOURCE_TYPE]: { properties: { Name: 'text', URL: 'text', Type: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'Company' } },
  writableRoots: {},
};

const crmSchema: InstanceSchema = {
  positions: { note: { properties: { body: 'text' }, edges: {} } },
  collections: { notes: { target: 'note' } },
  writableRoots: { note: { fields: { body: 'text' }, resultShape: { externalId: 'text', body: 'text' } } },
};

const credentialArg = [{ name: 'credentials', kind: 'credential' as const, required: true }];
const catalog = mockCatalogSnapshot({
  adapters: {
    email: { constructionArgs: credentialArg, schema: emailSchema },
    kg: { constructionArgs: credentialArg, schema: graphSchema },
    crm: { constructionArgs: credentialArg, schema: crmSchema },
  },
  credentials: { dealflow_inbox: { adapters: ['email'] }, graph_main: { adapters: ['kg'] }, crm_main: { adapters: ['crm'] } },
});

const PRELUDE = [
  'import { email, kg, crm } from adapters',
  'import { dealflow_inbox, graph_main, crm_main } from credentials',
  'inbox = email(credentials: dealflow_inbox)',
  'graph = kg(credentials: graph_main)',
  'notes = crm(credentials: crm_main)',
  '',
].join('\n');

const movement = (...body: string[]) => [PRELUDE, 'movement m(msg: <inbox-[:message]->>) {', ...body, '}'].join('\n');

type Call = [string, unknown];

/** The email system: its record's bundle answers the reserved reference. */
function fakeEmail(calls: Call[]): Adapter {
  return {
    adapterType: 'email',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: true }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    async getFieldValue(input) {
      calls.push(['email.getFieldValue', input.fieldId]);
      const data = positionData(input.position);
      return typeof data === 'object' && data !== null ? Reflect.get(data, input.fieldId) : undefined;
    },
    async getRelated(input) {
      calls.push(['email.getRelated', input.fieldId]);
      if (input.fieldId !== '_resources') return [];
      return [
        { position: makeStablePosition({ adapterType: 'email', recordType: 'resource', recordId: 'r-1', data: { externalId: 'att-1', type: 'FILE', name: 'pitch.pdf', data: { filename: 'pitch.pdf' } } }) },
      ];
    },
    createRecord: async () => ({ adapterType: 'email', externalId: 'x', data: {} }),
    updateRecord: async (input) => ({ adapterType: 'email', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
    deleteRecord: async () => ({}),
  };
}

/** The knowledge graph as main's adapter answers: the resources edge only by
 *  its reserved field id (a walk by the name `Resources` would be a team's
 *  ontology edge, which this graph has none of), and a resource landing's
 *  fields off the landing itself. */
function fakeGraph(calls: Call[]): Adapter {
  return {
    adapterType: 'kg',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: true }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    async getFieldValue(input) {
      calls.push(['kg.getFieldValue', [input.position.recordType, input.fieldId]]);
      const data = positionData(input.position) as Record<string, unknown> | null | undefined;
      if (input.position.recordType === RESOURCE_TYPE) return data?.[RESOURCE_FIELDS[input.fieldId] ?? input.fieldId] ?? null;
      return data?.[input.fieldId] ?? null;
    },
    async getRelated(input) {
      calls.push(['kg.getRelated', [input.position.recordType, input.fieldId]]);
      if (input.fieldId === 'companies') {
        return [{ position: makeStablePosition({ adapterType: 'kg', recordType: 'Company', recordId: 'n-acme', data: { name: 'Acme' } }) }];
      }
      if (input.fieldId === '_resources') {
        return [
          { position: makeUnstablePosition({ adapterType: 'kg', recordType: RESOURCE_TYPE, data: { name: 'deck.pdf', url: 'https://files.test/deck.pdf', type: 'FILE' } }) },
          { position: makeUnstablePosition({ adapterType: 'kg', recordType: RESOURCE_TYPE, data: { name: 'notes', url: 'https://files.test/notes', type: 'TEXT' } }) },
        ];
      }
      return [];
    },
    createRecord: async () => ({ adapterType: 'kg', externalId: 'x', data: {} }),
    updateRecord: async (input) => ({ adapterType: 'kg', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
    deleteRecord: async () => ({}),
  };
}

/** A system that records what it is asked to write. */
function fakeCrm(calls: Call[]): Adapter {
  let minted = 0;
  return {
    ...fakeEmail(calls),
    adapterType: 'crm',
    async createRecord(input) {
      calls.push(['crm.createRecord', input.fields]);
      minted += 1;
      return { adapterType: 'crm', externalId: `crm-${minted}`, data: { ...input.fields } };
    },
  };
}

function webhook(): TriggerEvent {
  return { pipelineInputId: 'pi-rust-dancing-wren', adapterType: 'email', triggerType: 'webhook', payload: { subject: 'Acme' } };
}

interface Outcome {
  calls: Call[];
  result?: unknown;
  error?: unknown;
}

async function runOn(engine: 'ts' | 'rust', source: string, languageVersion: LanguageVersion): Promise<Outcome> {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = engine;
  const calls: Call[] = [];
  try {
    const result = await runMovement({
      source,
      event: webhook(),
      teamId: TEAM_ID,
      catalog,
      languageVersion,
      host: makeTestHost({
        adapters: {
          resolve: ({ adapterType }) => (adapterType === 'kg' ? fakeGraph(calls) : adapterType === 'crm' ? fakeCrm(calls) : fakeEmail(calls)),
        },
      }),
    });
    return { calls, result };
  } catch (error) {
    return { calls, error };
  } finally {
    if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
    else process.env.MOVEMENT_ENGINE = previous;
  }
}

const messageOf = (error: unknown) => {
  const cause = runFailureCause(error);
  return cause instanceof Error ? `${cause.constructor.name}: ${cause.message}` : String(cause);
};

/** The program on both engines under `languageVersion`: the same result or
 *  error, the same adapter calls, and the Rust run ending as the error says
 *  (whole, mirrored or at the check), never refused by admission. */
async function agree(source: string, languageVersion: LanguageVersion): Promise<Outcome> {
  const ts = await runOn('ts', source, languageVersion);
  resetRustEvalStats();
  resetRustRunStats();
  const rust = await runOn('rust', source, languageVersion);
  expect(rustRunStats).toMatchObject({ ...endedInRust(rust.error), notAdmitted: {}, declined: {} });
  expect(rust.calls).toEqual(ts.calls);
  if (ts.error !== undefined) {
    expect(rust.error).toBeDefined();
    expect(messageOf(rust.error)).toBe(messageOf(ts.error));
  } else {
    expect(rust.error).toBeUndefined();
    expect(rust.result).toEqual(ts.result);
  }
  return ts;
}

afterEach(() => mockCheckerMisses.clear());

describe('`_resources` off an adapter record, by language version', () => {
  const source = movement('  names = msg-[f:_resources]-> {', '    return f.`name`', '  }', '  return names');

  it('versions 1 to 4 read the bundle through the event\'s adapter on both engines, whole on Rust', async () => {
    for (const version of [1, 2, 3, 4] as const) {
      const ts = await agree(source, version);
      expect(ts.error).toBeUndefined();
      expect(ts.calls).toContainEqual(['email.getRelated', '_resources']);
      expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 1 });
    }
  });

  it('version 5 ends at the check on both engines (MOV_RESOURCES_NOT_EXTRACTED)', async () => {
    const ts = await agree(source, 5);
    expect(isCheckFailure(ts.error)).toBe(true);
    expect(messageOf(ts.error)).toContain('MOV_RESOURCES_NOT_EXTRACTED');
    expect(ts.calls).toEqual([]);
  });

  it('version 5, past a checker that missed it: both engines refuse alike, and neither asks for the reserved reference', async () => {
    mockCheckerMisses.add('MOV_RESOURCES_NOT_EXTRACTED');
    const ts = await agree(source, 5);
    const cause = runFailureCause(ts.error);
    expect(cause).toBeInstanceOf(MovementEngineError);
    expect(cause instanceof MovementEngineError ? cause.code : undefined).toBe('MOVENG_UNSUPPORTED');
    expect(messageOf(ts.error)).toContain("'-[:_resources]->' is read only off an extraction's result since language version 5");
    expect(ts.calls.filter(([method]) => method === 'email.getRelated')).toEqual([]);
    expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 0, mirroredFailure: 1 });
  });
});

describe("the knowledge graph's `Resources` edge, on every version", () => {
  const source = movement(
    '  graph-[c:companies]->-[f:Resources]-> {',
    '    write notes-[:notes]-> { body: "${f.`Name`}|${f.`URL`}|${f.`Type`}" }',
    '  }',
  );

  it('walks by its reserved field id and reads Name, URL and Type to the same values on both engines, whole on Rust', async () => {
    for (const version of [4, 5] as const) {
      const ts = await agree(source, version);
      expect(ts.error).toBeUndefined();
      expect(ts.calls.filter(([method]) => method === 'crm.createRecord')).toEqual([
        ['crm.createRecord', { body: 'deck.pdf|https://files.test/deck.pdf|FILE' }],
        ['crm.createRecord', { body: 'notes|https://files.test/notes|TEXT' }],
      ]);
      // Sent by its address, never by its name.
      expect(ts.calls).toContainEqual(['kg.getRelated', ['Company', '_resources']]);
      expect(ts.calls).not.toContainEqual(['kg.getRelated', ['Company', 'Resources']]);
      expect(ts.calls).toContainEqual(['kg.getFieldValue', [RESOURCE_TYPE, 'URL']]);
      expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 1 });
    }
  });
});
