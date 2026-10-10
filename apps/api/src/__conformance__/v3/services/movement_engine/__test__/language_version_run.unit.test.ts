// The language-version pin through the REAL interpreter and the authoring
// gate:
//
//   1. a run compiles and executes under its pin, and the pin is the run
//      context every adapter call sees (`currentLanguageVersion()`);
//   2. a pin this release does not support is refused — before the source is
//      read, naming the version and the fix, never run as the current one;
//   3. a deprecated pin runs, with a warning on the run's own trace;
//   4. validation (`diagnoseMovementSource`) honours the same pin.

import { CURRENT_LANGUAGE_VERSION, type InstanceSchema, type LanguageRelease } from 'movement-lang';
import { runMovement } from '../run';
import { currentLanguageVersion } from '../run_scope';
import { MovementEngineError } from '../errors';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { diagnoseMovementSource } from '../../translation_graph/movement/authoring';
import type { Adapter, RuntimeCapabilities, UpdateInput } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { META_RECORD_TYPE, makeStablePosition } from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';
import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { containerAssociation } from '../../translation_graph/adapter';

// A release other than this one, so the deprecated path is reachable while
// this release deprecates nothing. Only the ENGINE's view is redirected; the
// checker inside movement-lang keeps this release's.
let mockRelease: LanguageRelease | undefined;
jest.mock('movement-lang', () => {
  const actual = jest.requireActual('movement-lang');
  return {
    ...actual,
    languageVersionDiagnostic: (version: number) =>
      actual.languageVersionDiagnostic(version, mockRelease ?? actual.THIS_RELEASE),
  };
});

const TEAM_ID = '00000000-0000-0000-0000-000000000041' as TeamId;
const KG = 'kg';
const manualAdapter = createManualAdapter({ teamId: TEAM_ID });

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: false, edgeProperties: false }, resources: false };
}

/** A KG fake that records the language version each write ran under. */
function makeKgFake() {
  const seenVersions: number[] = [];
  const updates: UpdateInput[] = [];
  const adapter: Adapter = {
    adapterType: KG,
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => permissiveCaps(),
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
    async getRelated(read) {
      if (read.position.recordType !== META_RECORD_TYPE) return [];
      return [
        { position: makeStablePosition({ adapterType: KG, recordType: 'company', recordId: 'n-1' }) },
      ];
    },
    async createRecord(write) {
      return { adapterType: KG, externalId: `new-${write.recordType}`, data: {} };
    },
    async updateRecord(input) {
      seenVersions.push(currentLanguageVersion());
      updates.push(input);
      return { adapterType: KG, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, seenVersions, updates };
}

const kgSchema: InstanceSchema = {
  positions: { company: { properties: { name: 'text', status: 'text' }, edges: {} } },
  collections: { company: { target: 'company' } },
  supportsInPlaceUpdate: true,
  writableRoots: {
    company: {
      fields: { name: 'text', status: 'text' },
      resultShape: { externalId: 'text', name: 'text', status: 'text' },
    },
  },
};

const catalog = staticCatalogFromManifests({
  credentials: { kg_cred: { adapters: ['kg'] } },
  instanceSchemas: { kg: kgSchema },
});

const SOURCE = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement reopen(go: <runs-[:Invocation]->>) {
  graph-[c:company]-> {
    write c { status: "Open" }
  }
}
listen to runs {} fire reopen
`;

function manualEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:manual-lv',
    adapterType: 'manual',
    triggerType: 'webhook',
    payload: { firedAt: new Date().toISOString() },
    occurredAt: new Date().toISOString(),
  };
}

function run(kg: ReturnType<typeof makeKgFake>, languageVersion?: number) {
  return runMovement({
    source: SOURCE,
    ...(languageVersion !== undefined ? { languageVersion } : {}),
    event: manualEvent(),
    teamId: TEAM_ID,
    catalog,
    resolveAdapter: ({ adapterType }) => {
      if (adapterType === 'manual') return manualAdapter;
      if (adapterType === KG) return kg.adapter;
      throw new Error(`test: no fake adapter for '${adapterType}'`);
    },
    dryRun: false,
  });
}

afterEach(() => {
  mockRelease = undefined;
});

describe('a run honours its language version pin', () => {
  it('runs under the pin, and every adapter call sees it', async () => {
    const kg = makeKgFake();
    const result = await run(kg, 1);
    expect(kg.updates).toHaveLength(1);
    expect(kg.seenVersions).toEqual([1]);
    expect(result.trace.some((e) => e.kind === 'warning')).toBe(false);
  });

  it('runs under the current version when given none (unchanged for every existing caller)', async () => {
    const kg = makeKgFake();
    await run(kg);
    expect(kg.seenVersions).toEqual([CURRENT_LANGUAGE_VERSION]);
  });

  it('outside a run there is no pin: the current version', () => {
    expect(currentLanguageVersion()).toBe(CURRENT_LANGUAGE_VERSION);
  });

  it('refuses a pin this release does not support, naming it and the fix, before writing anything', async () => {
    const kg = makeKgFake();
    const promise = run(kg, 99);
    await expect(promise).rejects.toBeInstanceOf(MovementEngineError);
    await expect(promise).rejects.toThrow(/MOVENG_LANGUAGE_VERSION: .*version 99.*To fix:/);
    expect(kg.updates).toEqual([]);
  });

  it('refuses a removed version BY NAME', async () => {
    mockRelease = { current: 3, supported: new Set([2, 3]), deprecated: new Set() };
    const kg = makeKgFake();
    await expect(run(kg, 1)).rejects.toThrow(/"Quiet Heron" \(1\)/);
    expect(kg.updates).toEqual([]);
  });

  it('runs a deprecated pin, with a warning on the run trace naming it', async () => {
    mockRelease = { current: 3, supported: new Set([1, 2, 3]), deprecated: new Set([1]) };
    const kg = makeKgFake();
    const result = await run(kg, 1);
    expect(kg.updates).toHaveLength(1);
    const warning = result.trace.find((e) => e.kind === 'warning');
    expect(warning).toMatchObject({ code: 'MOV_LANGUAGE_VERSION_DEPRECATED' });
    expect(warning && 'message' in warning ? warning.message : '').toMatch(
      /"Quiet Heron" \(1\).*will be removed/,
    );
  });
});

describe('validation honours the pin', () => {
  it('a supported pin validates the text as usual', () => {
    const validation = diagnoseMovementSource(SOURCE, { catalog, languageVersion: 1 });
    expect(validation.ok).toBe(true);
    expect(validation.firedMovements).toEqual(['reopen']);
  });

  it('an unsupported pin is the whole verdict — not a parse of the text under another version', () => {
    const validation = diagnoseMovementSource('this is not a movement {', {
      catalog,
      languageVersion: 99,
    });
    expect(validation.ok).toBe(false);
    expect(validation.diagnostics.map((d) => d.code)).toEqual(['MOV_LANGUAGE_VERSION_UNSUPPORTED']);
  });
});
