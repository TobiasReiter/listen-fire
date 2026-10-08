// Where the production host stores file text: the team's `raw_text` table for
// a firing, and nowhere durable for a test run.

const resolverStores: unknown[] = [];
/** What the file-text reader does when called: answer, or spend and then run
 *  out of budget (a transcription that met the cap partway). */
let fileTextSpends = false;
jest.mock('../file_text', () => ({
  makeFileTextResolver: (store: unknown) => {
    resolverStores.push(store);
    return async () => {
      if (fileTextSpends) {
        const spend = jest.requireActual('../../../../lib/run_spend');
        spend.reportRunCost({ source: { kind: 'model', name: 'whisper' }, microdollars: 700 });
        spend.assertRunBudget();
      }
      return { unreadable: 'no_text' };
    };
  },
}));

const postgresStore = { getOrCreateId: jest.fn(async () => 'pg-id') };
const postgresRawTextStore = jest.fn((_teamId: string) => postgresStore);
jest.mock('../raw_text_store', () => ({
  ...jest.requireActual('../raw_text_store'),
  postgresRawTextStore: (teamId: string) => postgresRawTextStore(teamId),
}));

import { tenantIdOf } from 'engine-contracts';
import { productionEngineHost } from '../engine_host';
import { inMemoryRawTextStore } from '../raw_text_store';
import type { Adapter } from '../../adapter';
import type { CapturedWrite } from '../../engine/dry_run_adapter';
import { userEditContext } from '../../mutation_context';
import { teamOfTenant } from '../tenant';

const MUTATION_CONTEXT = userEditContext('user-1');

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000e1');

beforeEach(() => {
  fileTextSpends = false;
  resolverStores.length = 0;
  postgresRawTextStore.mockClear();
});

describe('productionEngineHost — file text storage', () => {
  it("a firing's host stores file text in the team's raw_text table", () => {
    productionEngineHost({ teamId: teamOfTenant(TEAM_ID) });
    expect(postgresRawTextStore).toHaveBeenCalledWith(TEAM_ID);
    expect(resolverStores).toEqual([postgresStore]);
  });

  it('a host given an in-memory store never builds the Postgres one', () => {
    const rawText = inMemoryRawTextStore();
    productionEngineHost({ teamId: teamOfTenant(TEAM_ID), rawText });
    expect(postgresRawTextStore).not.toHaveBeenCalled();
    expect(resolverStores).toEqual([rawText]);
  });
});

describe('inMemoryRawTextStore', () => {
  it('gives test-run file text no id, as before the host boundary', async () => {
    const store = inMemoryRawTextStore();
    expect(await store.getOrCreateId('deck text')).toBeUndefined();
  });
});

// The engine never holds a live adapter: it resolves an instance to data and an
// opaque id, then calls it by method, and the host dispatches into the live
// one inside the segment it was resolved for.
describe('productionEngineHost — adapter instances', () => {
  function liveAdapter(writes: string[]): Adapter {
    return {
      adapterType: 'attio',
      supportedTriggers: ['webhook'],
      runtimeCapabilities: () => ({ traversal: { incoming: true, edgeProperties: false }, resources: false }),
      listEntryPoints: async () => [],
      describe: async () => null,
      resolveEntity: async () => ({ candidates: [] }),
      getFieldValue: async () => null,
      getRelated: async () => [],
      readRecord: async ({ externalId }) => ({ id: externalId }),
      createRecord: async (input) => {
        writes.push(input.recordType);
        return { adapterType: 'attio', externalId: 'live-1', data: {} };
      },
      updateRecord: async (input) => ({ adapterType: 'attio', externalId: input.externalId, data: {}, association: 'none' }),
      deleteRecord: async () => ({}),
    };
  }

  it('resolves an instance to data, and answers each call by method', async () => {
    const live = liveAdapter([]);
    const host = productionEngineHost({ teamId: teamOfTenant(TEAM_ID), resolveLive: () => live });
    const { segmentId } = await host.segment.open({ teamId: TEAM_ID, languageVersion: 2 });
    const resolved = await host.adapters.resolve({ adapterType: 'attio', role: 'target', segmentId });
    expect(resolved).toMatchObject({
      adapterType: 'attio',
      capabilities: { traversal: { incoming: true, edgeProperties: false }, resources: false },
    });
    expect(resolved.methods).toEqual(expect.arrayContaining(['describe', 'readRecord', 'createRecord']));
    expect(resolved.methods).not.toContain('linkRecords');
    // The same resolution answers to the same id, whichever role asks.
    const again = await host.adapters.resolve({ adapterType: 'attio', role: 'source', segmentId });
    expect(again.instance).toBe(resolved.instance);

    const call = { segmentId, instance: resolved.instance };
    expect(await host.adapters.call({ ...call, method: 'readRecord', args: { recordType: 'companies', externalId: 'c-1' } })).toEqual({
      result: { id: 'c-1' },
    });
    // A method the instance lacks, and a closed segment, come back as data.
    expect(
      await host.adapters.call({
        ...call,
        method: 'linkRecords',
        args: {
          edgeName: 'e',
          from: { recordType: 'a', externalId: '1' },
          to: { recordType: 'b', externalId: '2' },
          mutationContext: MUTATION_CONTEXT,
        },
      }),
    ).toEqual({ error: { kind: 'adapter_error', message: "the 'attio' adapter does not implement linkRecords" } });
    await host.segment.close({ segmentId });
    expect(await host.adapters.call({ ...call, method: 'describe', args: { typeId: 't' } })).toEqual({
      error: { kind: 'adapter_error', message: expect.stringMatching(/no open segment/) },
    });
  });

  it('a rehearsed instance captures its writes into the sink and never reaches the live one', async () => {
    const writes: string[] = [];
    const captured: CapturedWrite[] = [];
    const host = productionEngineHost({
      teamId: teamOfTenant(TEAM_ID),
      resolveLive: () => liveAdapter(writes),
      writeSink: (write) => captured.push(write),
    });
    const { segmentId } = await host.segment.open({ teamId: TEAM_ID, languageVersion: 2 });
    const live = await host.adapters.resolve({ adapterType: 'attio', role: 'target', segmentId });
    const rehearsed = await host.adapters.resolve({
      adapterType: 'attio',
      role: 'target',
      segmentId,
      dryRun: true,
    });
    expect(rehearsed.instance).not.toBe(live.instance);
    const answer = await host.adapters.call({
      segmentId,
      instance: rehearsed.instance,
      method: 'createRecord',
      args: { recordType: 'companies', fields: { name: 'Acme' }, mutationContext: MUTATION_CONTEXT },
    });
    expect(answer).toMatchObject({ result: { adapterType: 'attio' } });
    expect(writes).toEqual([]);
    expect(captured).toEqual([{ kind: 'create', adapterType: 'attio', recordType: 'companies', fields: { name: 'Acme' } }]);
    await host.segment.close({ segmentId });
  });

  it('keys an instance by its resolution, for the segment’s team, and refuses a segment that is not open', async () => {
    const asked: Array<{ teamId: string; credentialsId?: string }> = [];
    // A fresh live object every time it is asked, as a registry without a cache would hand out.
    const host = productionEngineHost({
      teamId: teamOfTenant(TEAM_ID),
      resolveLive: ({ teamId, credentialsId }) => {
        asked.push({ teamId, ...(credentialsId !== undefined ? { credentialsId } : {}) });
        return liveAdapter([]);
      },
    });
    const { segmentId } = await host.segment.open({ teamId: TEAM_ID, languageVersion: 2 });
    const first = await host.adapters.resolve({
      adapterType: 'attio',
      credentialsId: 'cred-a',
      constructionArgs: { workspace: 'w', region: 'eu' },
      role: 'target',
      segmentId,
    });
    const same = await host.adapters.resolve({
      adapterType: 'attio',
      credentialsId: 'cred-a',
      constructionArgs: { region: 'eu', workspace: 'w' },
      role: 'source',
      segmentId,
    });
    const other = await host.adapters.resolve({ adapterType: 'attio', credentialsId: 'cred-b', role: 'target', segmentId });
    expect(same.instance).toBe(first.instance);
    expect(other.instance).not.toBe(first.instance);
    // Constructed once per resolution, for the team the segment was opened for.
    expect(asked).toEqual([
      { teamId: TEAM_ID, credentialsId: 'cred-a' },
      { teamId: TEAM_ID, credentialsId: 'cred-b' },
    ]);

    await host.segment.close({ segmentId });
    await expect(host.adapters.resolve({ adapterType: 'attio', role: 'target', segmentId })).rejects.toThrow(
      `no open segment '${segmentId}'`,
    );
    await expect(
      host.adapters.resolve({ adapterType: 'attio', role: 'target', segmentId: 'never-opened' }),
    ).rejects.toThrow("no open segment 'never-opened'");
  });
});

// A priced call refused past its budget answers the refusal as data, with what
// it spent before the refusal — nothing thrown crosses to the engine.
describe('productionEngineHost — priced calls past the budget', () => {
  it('answers a budget refusal carrying what the call spent first', async () => {
    fileTextSpends = true;
    const host = productionEngineHost({ teamId: teamOfTenant(TEAM_ID) });
    const answer = await host.files.resolveFileText({
      segmentId: 'seg-1',
      file: { __brand: 'FileRef', name: 'call.mp3' },
      budget: { remainingMicrodollars: 500 },
    });
    expect(answer).toEqual({
      error: { kind: 'budget', message: expect.any(String) },
      cost: [{ source: 'model:whisper', microdollars: 700 }],
    });
  });
});
