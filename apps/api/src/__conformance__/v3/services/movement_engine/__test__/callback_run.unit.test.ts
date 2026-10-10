// The engine half of the callback primitive: MINT, the `Called` edge's two
// read modes, and the FIRE that resumes the run at the callback's body.
//
// Every claim here is about the interpreter, so the store is a fake sink (the
// real one is pinned by callback_store.integration.test.ts). What this file
// pins is the shape of the seam:
//
//   · mint CAPTURES the enclosing scope, in the park machinery's own state
//     shape, keyed by the callback expression's lexical ADDRESS;
//   · `cb-[c:Called]->` reads the ledger LIVE (empty before any fire);
//   · `await cb-[:Called]->` resolves inline when a call already landed and
//     PARKS otherwise, registering its correlation;
//   · a fire runs the BODY at a frame of its own, with the fire-time values
//     bound, and does NOT continue the enclosing sequence — that continuation
//     is the main one, still parked.

import type { InstanceSchema } from 'movement-lang';
import type { Adapter, RuntimeCapabilities, WriteInput } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { CallbackSink } from '../callback_sink';
import type { CallbackCall } from '../callback_store';
import type { ParkedScopeState } from '../serialize';

import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { containerAssociation } from '../../translation_graph/adapter';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { runMovement, fireCallbackBody, type ParkSink } from '../run';

const TEAM_ID = '00000000-0000-0000-0000-000000000041' as TeamId;
const KG = 'kg';
const manualAdapter = createManualAdapter({ teamId: TEAM_ID });

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: false, edgeProperties: false }, resources: false };
}

function makeKgFake() {
  const creates: WriteInput[] = [];
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
    async getRelated() {
      return [];
    },
    async createRecord(write) {
      creates.push(write);
      return { adapterType: KG, externalId: `log-${creates.length}`, data: {} };
    },
    async updateRecord(input) {
      return { adapterType: KG, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates };
}

const kgSchema: InstanceSchema = {
  positions: { log: { properties: { text: 'text' }, edges: {} } },
  collections: { log: { target: 'log' } },
  writableRoots: {
    log: { fields: { text: 'text' }, resultShape: { externalId: 'text', text: 'text' } },
  },
};

const catalog = staticCatalogFromManifests({
  credentials: { kg_cred: { adapters: ['kg'] } },
  instanceSchemas: { kg: kgSchema },
});

function manualEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:manual-cb',
    adapterType: 'manual',
    triggerType: 'webhook',
    payload: { firedAt: '2026-07-31T09:00:00.000Z' },
    occurredAt: '2026-07-31T09:00:00.000Z',
  };
}

function makeResolver(byType: Record<string, Adapter>) {
  return ({ adapterType }: { adapterType: string }) => {
    const adapter = byType[adapterType];
    if (!adapter) throw new Error(`test: no fake adapter for '${adapterType}'`);
    return adapter;
  };
}

/** A fake store: records what was minted, serves a ledger the test controls. */
function makeFakeCallbackSink(ledger: Record<string, CallbackCall[]> = {}) {
  const mints: Array<{
    id: string;
    address: string;
    params: Array<{ name: string; type: string }>;
    state: ParkedScopeState;
    singleUse: boolean;
    expiresAt?: Date;
  }> = [];
  const correlations: Array<{ callbackId: string; address: string }> = [];
  let n = 0;
  const sink: CallbackSink = {
    async mint(input) {
      const id = `cb_fake${++n}`;
      mints.push({ id, ...input });
      return { id, url: `https://api.test/api/cb/${id}` };
    },
    async calls(callbackId) {
      return ledger[callbackId] ?? [];
    },
    async correlateAwait(input) {
      correlations.push(input);
    },
  };
  return { sink, mints, correlations, ledger };
}

/** A fake park sink: records the await parks (the only kind these tests hit). */
function makeFakeParkSink() {
  const awaitParks: Array<{ address: string; state: ParkedScopeState }> = [];
  const sink = {
    async recordJoin() {},
    async commitTimerPark() {},
    async commitAwaitPark(input: {
      address: string;
      state: unknown;
      correlate: (runId: string) => Promise<void>;
    }) {
      await input.correlate('run-1');
      awaitParks.push({ address: input.address, state: input.state as ParkedScopeState });
    },
    async decrementJoin() {
      return { closed: false };
    },
    async persistBranchExport() {},
    async collectBranchExports() {
      return [];
    },
    async cancelSubtrees() {},
  } as unknown as ParkSink;
  return { sink, awaitParks };
}

const PRELUDE = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
`;

function movementRun(args: {
  source: string;
  kg: ReturnType<typeof makeKgFake>;
  callbacks: ReturnType<typeof makeFakeCallbackSink>;
  parks?: ReturnType<typeof makeFakeParkSink>;
}) {
  return runMovement({
    source: args.source,
    event: manualEvent(),
    teamId: TEAM_ID,
    catalog,
    resolveAdapter: makeResolver({ manual: manualAdapter, [KG]: args.kg.adapter }),
    callbackSink: args.callbacks.sink,
    ...(args.parks !== undefined ? { parkSink: args.parks.sink } : {}),
    dryRun: false,
  });
}

describe('mint', () => {
  const SOURCE = `${PRELUDE}
movement m(go: <runs-[:Invocation]->>) {
  greeting = "hello"
  cb = callback({ write graph-[:log]-> { text: greeting } })
  write graph-[:log]-> { text: cb.id }
}
listen to runs {} fire m
`;

  it('binds `.id` and `.url`, and does NOT run the body at mint time', async () => {
    const kg = makeKgFake();
    const callbacks = makeFakeCallbackSink();

    await movementRun({ source: SOURCE, kg, callbacks });

    // One write only: the body is DEFERRED, not run.
    expect(kg.creates).toHaveLength(1);
    expect(kg.creates[0].fields).toEqual({ text: 'cb_fake1' });
  });

  it('CAPTURES the enclosing scope at the callback expression’s lexical address', async () => {
    const kg = makeKgFake();
    const callbacks = makeFakeCallbackSink();

    await movementRun({ source: SOURCE, kg, callbacks });

    expect(callbacks.mints).toHaveLength(1);
    const [mint] = callbacks.mints;
    // `greeting` is stmt0, the callback is stmt1 — the address is the callback's.
    expect(mint.address).toBe('s1');
    expect(mint.state.version).toBe(1);
    expect(mint.state.address).toBe('s1');
    expect(mint.state.bindingName).toBeNull();
    // The closure carries what the body will read.
    const captured = JSON.parse(JSON.stringify(mint.state)) as ParkedScopeState;
    const movementScope = captured.scopeChain[captured.scopeChain.length - 1];
    expect(movementScope.bindings.greeting).toMatchObject({ kind: 'value', value: 'hello' });
  });

  it('`once` defaults TRUE, and the config overrides it', async () => {
    const kg = makeKgFake();
    const callbacks = makeFakeCallbackSink();
    const source = `${PRELUDE}
movement m(go: <runs-[:Invocation]->>) {
  a = callback({ write graph-[:log]-> { text: "a" } })
  b = callback({ write graph-[:log]-> { text: "b" } }, { once: FALSE, ttl: 2d })
}
listen to runs {} fire m
`;

    await movementRun({ source, kg, callbacks });

    expect(callbacks.mints.map((m) => m.singleUse)).toEqual([true, false]);
    expect(callbacks.mints[0].expiresAt).toBeUndefined();
    // 2d out, give or take the test's own clock.
    const ttl = callbacks.mints[1].expiresAt!.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(47 * 60 * 60 * 1000);
    expect(ttl).toBeLessThan(49 * 60 * 60 * 1000);
  });

  it('records the fire-time signature in DECLARATION order', async () => {
    const kg = makeKgFake();
    const callbacks = makeFakeCallbackSink();
    const source = `${PRELUDE}
movement m(go: <runs-[:Invocation]->>) {
  cb = callback((when: <date>, note: <text>) => { write graph-[:log]-> { text: note } })
}
listen to runs {} fire m
`;

    await movementRun({ source, kg, callbacks });

    expect(callbacks.mints[0].params).toEqual([
      { name: 'when', type: 'date' },
      { name: 'note', type: 'text' },
    ]);
  });

  it('a body-less callback mints the same way — an empty body, not a variant', async () => {
    const kg = makeKgFake();
    const callbacks = makeFakeCallbackSink();
    const source = `${PRELUDE}
movement m(go: <runs-[:Invocation]->>) {
  cb = callback()
  write graph-[:log]-> { text: cb.url }
}
listen to runs {} fire m
`;

    await movementRun({ source, kg, callbacks });

    expect(callbacks.mints).toHaveLength(1);
    expect(callbacks.mints[0].params).toEqual([]);
    expect(kg.creates[0].fields).toEqual({ text: 'https://api.test/api/cb/cb_fake1' });
  });

  it('without a callback sink the mint is a LOUD refusal, never a silent skip', async () => {
    const kg = makeKgFake();
    await expect(
      runMovement({
        source: SOURCE,
        event: manualEvent(),
        teamId: TEAM_ID,
        catalog,
        resolveAdapter: makeResolver({ manual: manualAdapter, [KG]: kg.adapter }),
        dryRun: false,
      }),
    ).rejects.toThrow(/callback/i);
  });
});

describe('the Called edge — read synchronously', () => {
  const SOURCE = `${PRELUDE}
movement m(go: <runs-[:Invocation]->>) {
  cb = callback((note: <text>) => { write graph-[:log]-> { text: note } })
  cb-[c:Called]-> {
    write graph-[:log]-> { text: c.note }
  }
}
listen to runs {} fire m
`;

  it('reads ZERO calls before anything fires — an empty traversal, not a special state', async () => {
    const kg = makeKgFake();
    const callbacks = makeFakeCallbackSink();

    await movementRun({ source: SOURCE, kg, callbacks });

    expect(kg.creates).toHaveLength(0);
  });

  it('a repeatable callback ACCUMULATES — one iteration per recorded call', async () => {
    const kg = makeKgFake();
    const callbacks = makeFakeCallbackSink({
      cb_fake1: [
        { at: '2026-07-31T10:00:00.000Z', values: { note: 'first' } },
        { at: '2026-07-31T11:00:00.000Z', values: { note: 'second' } },
      ],
    });

    await movementRun({ source: SOURCE, kg, callbacks });

    expect(kg.creates.map((w) => w.fields)).toEqual([{ text: 'first' }, { text: 'second' }]);
  });

  it('the landing carries `At` alongside the parameters', async () => {
    const kg = makeKgFake();
    const callbacks = makeFakeCallbackSink({
      cb_fake1: [{ at: '2026-07-31T10:00:00.000Z', values: { note: 'x' } }],
    });
    const source = `${PRELUDE}
movement m(go: <runs-[:Invocation]->>) {
  cb = callback((note: <text>) => { write graph-[:log]-> { text: note } })
  cb-[c:Called]-> {
    write graph-[:log]-> { text: c.At }
  }
}
listen to runs {} fire m
`;

    await movementRun({ source, kg, callbacks });

    expect(kg.creates[0].fields).toEqual({ text: '2026-07-31T10:00:00.000Z' });
  });
});

describe('the Called edge — awaited', () => {
  const SOURCE = `${PRELUDE}
movement m(go: <runs-[:Invocation]->>) {
  cb = callback({ write graph-[:log]-> { text: "body ran" } })
  c = await FIRST(cb-[:Called]->)
  write graph-[:log]-> { text: "continued" }
}
listen to runs {} fire m
`;

  it('PARKS when nothing has fired, registering the correlation the wake drives off', async () => {
    const kg = makeKgFake();
    const callbacks = makeFakeCallbackSink();
    const parks = makeFakeParkSink();

    const result = await movementRun({ source: SOURCE, kg, callbacks, parks });

    expect(result.parked).toBe(true);
    // The await is stmt1 (the callback mint is stmt0).
    expect(parks.awaitParks.map((p) => p.address)).toEqual(['s1']);
    expect(callbacks.correlations).toEqual([{ callbackId: 'cb_fake1', address: 's1' }]);
    // Nothing past the await ran.
    expect(kg.creates).toHaveLength(0);
  });

  it('resolves INLINE when a call already landed — the resumed shortcut', async () => {
    const kg = makeKgFake();
    const callbacks = makeFakeCallbackSink({
      cb_fake1: [{ at: '2026-07-31T10:00:00.000Z', values: {} }],
    });
    const parks = makeFakeParkSink();

    const result = await movementRun({ source: SOURCE, kg, callbacks, parks });

    expect(result.parked).toBeFalsy();
    expect(parks.awaitParks).toHaveLength(0);
    expect(kg.creates.map((w) => w.fields)).toEqual([{ text: 'continued' }]);
  });
});

describe('fire — resume the run at the callback body', () => {
  const SOURCE = `${PRELUDE}
movement m(go: <runs-[:Invocation]->>) {
  greeting = "hello"
  cb = callback((note: <text>) => { write graph-[:log]-> { text: "${'$'}{greeting}: ${'$'}{note}" } })
  c = await FIRST(cb-[:Called]->)
  write graph-[:log]-> { text: "continued" }
}
listen to runs {} fire m
`;

  /** Park the run, then fire against the captured state — the real sequence. */
  async function parkThenFire(values: Record<string, unknown>, callIndex = 0) {
    const kg = makeKgFake();
    const callbacks = makeFakeCallbackSink();
    const parks = makeFakeParkSink();
    const parked = await movementRun({ source: SOURCE, kg, callbacks, parks });
    expect(parked.parked).toBe(true);

    const fireKg = makeKgFake();
    const fired = await fireCallbackBody({
      source: SOURCE,
      event: manualEvent(),
      teamId: TEAM_ID,
      catalog,
      resolveAdapter: makeResolver({ manual: manualAdapter, [KG]: fireKg.adapter }),
      callbackSink: callbacks.sink,
      parkSink: parks.sink,
      // The stored state, JSON round-tripped exactly as the DB would.
      state: JSON.parse(JSON.stringify(callbacks.mints[0].state)) as ParkedScopeState,
      values,
      callIndex,
    });
    return { fired, fireKg, parks, callbacks };
  }

  it('runs the BODY with the fire-time values bound, over the captured closure', async () => {
    const { fired, fireKg } = await parkThenFire({ note: 'ship it' });

    expect(fired.parked).toBeFalsy();
    // `greeting` came from the capture; `note` from the fire.
    expect(fireKg.creates.map((w) => w.fields)).toEqual([{ text: 'hello: ship it' }]);
  });

  it('does NOT continue the enclosing sequence — the main continuation stays parked', async () => {
    const { fireKg, parks } = await parkThenFire({ note: 'x' });

    // "continued" is what the MAIN continuation writes past its await; a fire
    // must not run it, and must not re-park the main leaf either. (`greeting`
    // is stmt0, the callback stmt1, the await stmt2.)
    expect(fireKg.creates.map((w) => w.fields)).not.toContainEqual({ text: 'continued' });
    expect(parks.awaitParks.map((p) => p.address)).toEqual(['s2']);
  });

  it('a body-less fire runs nothing and completes quietly (the recorded call IS the effect)', async () => {
    const source = `${PRELUDE}
movement m(go: <runs-[:Invocation]->>) {
  cb = callback()
  c = await FIRST(cb-[:Called]->)
  write graph-[:log]-> { text: "continued" }
}
listen to runs {} fire m
`;
    const kg = makeKgFake();
    const callbacks = makeFakeCallbackSink();
    const parks = makeFakeParkSink();
    await movementRun({ source, kg, callbacks, parks });

    const fireKg = makeKgFake();
    const fired = await fireCallbackBody({
      source,
      event: manualEvent(),
      teamId: TEAM_ID,
      catalog,
      resolveAdapter: makeResolver({ manual: manualAdapter, [KG]: fireKg.adapter }),
      callbackSink: callbacks.sink,
      parkSink: parks.sink,
      state: JSON.parse(JSON.stringify(callbacks.mints[0].state)) as ParkedScopeState,
      values: {},
      callIndex: 0,
    });

    expect(fired.parked).toBeFalsy();
    expect(fireKg.creates).toHaveLength(0);
  });

  it('a THROWING body fails the fire, and the failure carries what it did write', async () => {
    const source = `${PRELUDE}
movement m(go: <runs-[:Invocation]->>) {
  cb = callback({ ERROR("no") })
  c = await FIRST(cb-[:Called]->)
}
listen to runs {} fire m
`;
    const kg = makeKgFake();
    const callbacks = makeFakeCallbackSink();
    const parks = makeFakeParkSink();
    await movementRun({ source, kg, callbacks, parks });

    const fireKg = makeKgFake();
    await expect(
      fireCallbackBody({
        source,
        event: manualEvent(),
        teamId: TEAM_ID,
        catalog,
        resolveAdapter: makeResolver({ manual: manualAdapter, [KG]: fireKg.adapter }),
        callbackSink: callbacks.sink,
        parkSink: parks.sink,
        state: JSON.parse(JSON.stringify(callbacks.mints[0].state)) as ParkedScopeState,
        values: {},
        callIndex: 0,
      }),
    ).rejects.toThrow(/no/);
    // The main await leaf is untouched — a failed side entry must not kill it.
    expect(parks.awaitParks.map((p) => p.address)).toEqual(['s1']);
  });

  it('each call gets its OWN body frame, so repeated fires never collide', async () => {
    const first = await parkThenFire({ note: 'one' }, 0);
    const second = await parkThenFire({ note: 'two' }, 1);
    expect(first.fired.parked).toBeFalsy();
    expect(second.fired.parked).toBeFalsy();
    expect(second.fireKg.creates.map((w) => w.fields)).toEqual([{ text: 'hello: two' }]);
  });
});

// ── The canonical body: answering a request (callback-primitive layer 3) ────
//
// The mission's own example. Nothing here is ask-specific machinery: the body
// is an ORDINARY linked write, so what this pins is that a captured request
// handle rehydrates into one — the write reaches the adapter as the LANDING
// type with the request as its parent link, which is exactly the shape the ask
// adapter's Response branch reads.

describe('a callback body that ANSWERS a request', () => {
  const ASK = 'ask';

  const askSchema: InstanceSchema = {
    positions: { 'Check Response': { properties: { Answer: 'boolean' }, edges: {} } },
    collections: { Check: { target: 'Check' } },
    writableRoots: {
      Check: {
        fields: { Prompt: 'text' },
        resultShape: { externalId: 'text', url: 'text', Prompt: 'text' },
        requiredFields: ['Prompt'],
        edges: {
          Response: {
            target: 'Check Response',
            writable: true,
            awaitable: true,
            watchable: true,
            resolvesEmpty: true,
          },
        },
      },
    },
    createShapes: {
      'Check Response': {
        fields: { Answer: 'boolean' },
        resultShape: { externalId: 'text', Answer: 'boolean' },
        requiredFields: ['Answer'],
      },
    },
  };

  function makeAskFake() {
    const creates: WriteInput[] = [];
    const adapter: Adapter = {
      adapterType: ASK,
      supportedTriggers: [],
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
      async getRelated() {
        return [];
      },
      async createRecord(write) {
        creates.push(write);
        return {
          adapterType: ASK,
          externalId: 'ask-1',
          recordType: write.recordType,
          data: write.recordType === 'Check' ? { Url: 'https://x/api/asks/ask_tok' } : { Answer: true },
        };
      },
      async updateRecord(input) {
        return { adapterType: ASK, externalId: input.externalId, data: {}, association: containerAssociation(input) };
      },
      async deleteRecord() {
        return {};
      },
    };
    return { adapter, creates };
  }

  const base = staticCatalogFromManifests({
    credentials: { kg_cred: { adapters: ['kg'] } },
    instanceSchemas: { kg: kgSchema },
  });
  const askCatalog = {
    ...base,
    instantiate: (name: string, args?: Record<string, unknown>) =>
      name === ASK ? askSchema : base.instantiate(name, args as never),
  };

  const SOURCE = `import { manual, ask, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
qa = ask()

movement m(go: <runs-[:Invocation]->>) {
  a = write qa-[:Check]-> { Prompt: "Ship it?" }
  cb = callback({ write a-[:Response]-> { Answer: TRUE } })
  write graph-[:log]-> { text: cb.id }
}
listen to runs {} fire m
`;

  it('the request handle CAPTURES, and the fired body writes the answer along its own edge', async () => {
    const kg = makeKgFake();
    const ask = makeAskFake();
    const callbacks = makeFakeCallbackSink();

    const minted = await runMovement({
      source: SOURCE,
      event: manualEvent(),
      teamId: TEAM_ID,
      catalog: askCatalog,
      resolveAdapter: makeResolver({ manual: manualAdapter, [KG]: kg.adapter, [ASK]: ask.adapter }),
      callbackSink: callbacks.sink,
      dryRun: false,
    });
    expect(minted.parked).toBeFalsy();
    // The request was raised; the ANSWER was not — the body is deferred.
    expect(ask.creates.map((w) => w.recordType)).toEqual(['Check']);

    const fireAsk = makeAskFake();
    await fireCallbackBody({
      source: SOURCE,
      event: manualEvent(),
      teamId: TEAM_ID,
      catalog: askCatalog,
      resolveAdapter: makeResolver({
        manual: manualAdapter,
        [KG]: makeKgFake().adapter,
        [ASK]: fireAsk.adapter,
      }),
      callbackSink: callbacks.sink,
      state: JSON.parse(JSON.stringify(callbacks.mints[0].state)) as ParkedScopeState,
      values: {},
      callIndex: 0,
    });

    expect(fireAsk.creates).toHaveLength(1);
    const [answer] = fireAsk.creates;
    // The LANDING type as the record type, the request as the parent link —
    // the coordinates the ask adapter answers from.
    expect(answer.recordType).toBe('Check Response');
    expect(answer.fields).toEqual({ Answer: true });
    expect(answer.parentLinks).toMatchObject([
      { recordType: 'Check', externalId: 'ask-1', edgeName: 'Response' },
    ]);
  });
});
