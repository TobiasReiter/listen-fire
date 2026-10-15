// A value that may be any of several closures — a body whose returns hand back
// different closures — called under language versions 3 and 4. The checker
// typed the call by the first return's closure alone, and the call RAN on
// whichever closure it reached: a record arrived in a text field, a number in
// a text parameter, and a missing argument failed at run time only on the
// path that reached the closure wanting it. That is why the refusals land from
// Dancing Wren (5) only, with upgrade warnings before it — the frozen
// behaviour is pinned here, and version 5 is refused at check.

import type { InstanceSchema } from 'movement-lang';
import type { Adapter, RuntimeCapabilities, WriteInput } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { runMovement } from '../run';

const TEAM_ID = '00000000-0000-0000-0000-000000000098' as TeamId;
const KG = 'kg';
const manualAdapter = createManualAdapter({ teamId: TEAM_ID });

function makeKgFake() {
  const creates: WriteInput[] = [];
  const adapter: Adapter = {
    adapterType: KG,
    supportedTriggers: ['webhook'],
    runtimeCapabilities: (): RuntimeCapabilities => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue() {
      return null;
    },
    async getRelated() {
      return [];
    },
    async createRecord(write) {
      creates.push(write);
      return { adapterType: KG, externalId: `rec-${creates.length}`, data: {} };
    },
    async updateRecord() {
      throw new Error('test: no updates');
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates };
}

const kgSchema: InstanceSchema = {
  positions: {
    note: { properties: { payload: 'json' }, edges: {} },
    company: { properties: { name: 'text' }, edges: {} },
  },
  collections: { note: { target: 'note' }, companies: { target: 'company' } },
  writableRoots: {
    note: { fields: { payload: 'json' }, resultShape: { externalId: 'text' } },
    company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
  },
};

const catalog = staticCatalogFromManifests({
  credentials: { kg_cred: { adapters: ['kg'] } },
  instanceSchemas: { kg: kgSchema },
});

const event: TriggerEvent = {
  pipelineInputId: 'trigger:manual-maybe-record',
  adapterType: 'manual',
  triggerType: 'webhook',
  payload: { firedAt: '2026-10-15T09:00:00.000Z' },
  occurredAt: '2026-10-15T09:00:00.000Z',
};


const PRE = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
`;
const CASES: Record<string, string> = {
  recordAsText: `movement recap(go: <runs-[:Invocation]->>) {
  c = FALSE
  mk = () => {
    if c {
      return () => "x"
    }
    return () => {
      co = write graph-[:companies]-> { name: "a" }
      return co
    }
  }
  g = mk()
  x = g()
  write graph-[:companies]-> { name: x }
}`,
  arity: `movement recap(go: <runs-[:Invocation]->>) {
  c = FALSE
  mk = () => {
    if c {
      return () => "x"
    }
    return (a: <number>) => a
  }
  g = mk()
  x = g()
  write graph-[:note]-> { payload: { x: x } }
}`,
  params: `movement recap(go: <runs-[:Invocation]->>) {
  c = FALSE
  mk = () => {
    if c {
      return (n: <number>) => n + 1
    }
    return (n: <text>) => CONCAT(n, "!")
  }
  g = mk()
  x = g(1)
  write graph-[:note]-> { payload: { x: x } }
}`,
};

async function runUnder(source: string, languageVersion: 3 | 4 | 5) {
  const kg = makeKgFake();
  const result = await runMovement({
    source: `${PRE}${source}\nlisten to runs {} fire recap\n`,
    event,
    teamId: TEAM_ID,
    catalog,
    movementName: 'recap',
    resolveAdapter: ({ adapterType }: { adapterType: string }) => {
      if (adapterType === 'manual') return manualAdapter;
      if (adapterType === KG) return kg.adapter;
      throw new Error(`test: no fake adapter for '${adapterType}'`);
    },
    dryRun: false,
    languageVersion,
  });
  return { result, kg };
}

describe('a call of one of several closures, under versions 3 and 4', () => {
  it.each([3, 4] as const)('under %i a record a later closure returns is written into a text field', async version => {
    const { kg } = await runUnder(CASES.recordAsText!, version);
    const written = kg.creates.map(c => c.fields.name);
    expect(written[0]).toBe('a');
    expect(written[1]).toMatchObject({ kind: 'handle' });
  });

  it.each([3, 4] as const)('under %i a number reaches a later closure\'s text parameter', async version => {
    const { kg } = await runUnder(CASES.params!, version);
    expect(kg.creates.map(c => c.fields.payload)).toEqual([{ x: '1!' }]);
  });

  it.each([3, 4] as const)('under %i a later closure\'s arity fails at run time, on the path that reaches it', async version => {
    await expect(runUnder(CASES.arity!, version)).rejects.toThrow(/takes 1 argument\(s\), got 0/);
  });

  it.each(Object.keys(CASES))('%s is refused at check under Dancing Wren (5)', async name => {
    await expect(runUnder(CASES[name]!, 5)).rejects.toThrow(/MOVENG_CHECK/);
  });
});
