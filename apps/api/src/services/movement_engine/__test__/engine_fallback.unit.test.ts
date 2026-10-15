// The engine choice and its fallback as configuration, and what the engine
// reports of each run for the run host to keep on its row: which engine ran
// it, and the first reason the Rust engine's admission gave for not running it.

import { mockCatalogSnapshot, type InstanceSchema } from 'movement-lang';
import { tenantIdOf } from 'engine-contracts';

import type { Adapter } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { EngineHost } from 'movement-engine/services/movement_engine/host';

import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { positionData } from 'movement-engine/services/translation_graph/types';
import { MovementEngineError } from 'movement-engine/services/movement_engine/errors';
import { resumeMovement, runMovement, type RunMovementInput } from 'movement-engine/services/movement_engine/run';
import { assertEngineChoiceConfigured, engineFallback, refusalOutcome, runSegmentInRust, type EngineProtocol } from 'movement-engine/services/movement_engine/rust_engine';
import { openRunContext } from 'movement-engine/services/movement_engine/run_context';
import { resetRustRunStats, setRunEngineRecorder, type RunEngineRecord } from 'movement-engine/services/movement_engine/rust_stats';
import { credentialIdsFor, makeTestHost } from 'movement-engine/services/movement_engine/test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000d1');

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

const catalog = mockCatalogSnapshot({
  adapters: { email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema } },
  credentials: { dealflow_inbox: { adapters: ['email'] } },
});

const program = (...body: string[]) =>
  [
    'import { email } from adapters',
    'import { dealflow_inbox } from credentials',
    'inbox = email(credentials: dealflow_inbox)',
    'movement m(msg: <inbox-[:message]->>) {',
    ...body,
    '}',
  ].join('\n');

/** Admitted by the Rust engine. */
const ADMITTED = program('  subject = msg.`subject`', '  return UPPER(subject)');

const event: TriggerEvent = { pipelineInputId: 'pi-dry-run', adapterType: 'email', triggerType: 'webhook', payload: { subject: 'Acme', text: 'hi' } };
/** Declined at the wire whatever the program says (a `Map` does not cross as
 *  itself), so the Rust engine gives the same reason under every language version. */
const UNWIREABLE_EVENT: TriggerEvent = { ...event, payload: { subject: 'Acme', text: 'hi', seen: new Map() } };

function fakeEmail(): Adapter {
  return {
    adapterType: 'email',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async (input) => {
      const data = positionData(input.position);
      return typeof data === 'object' && data !== null ? Reflect.get(data, input.fieldId) : undefined;
    },
    getRelated: async () => [],
    createRecord: async () => ({ adapterType: 'email', externalId: 'r1', data: {} }),
    updateRecord: async (input) => ({ adapterType: 'email', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
    deleteRecord: async () => ({}),
  };
}

function inputOf(source: string, host: EngineHost, runId?: string): RunMovementInput {
  return {
    source,
    event,
    teamId: TEAM_ID,
    catalog,
    credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
    host,
    ...(runId !== undefined ? { runId } : {}),
  };
}


async function underConfig<T>(config: { engine?: 'ts' | 'rust'; fallback?: 'ts' | 'none' }, body: () => Promise<T>): Promise<T> {
  const previous = { engine: process.env.MOVEMENT_ENGINE, fallback: process.env.MOVEMENT_ENGINE_FALLBACK };
  const set = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  set('MOVEMENT_ENGINE', config.engine);
  set('MOVEMENT_ENGINE_FALLBACK', config.fallback);
  try {
    return await body();
  } finally {
    set('MOVEMENT_ENGINE', previous.engine);
    set('MOVEMENT_ENGINE_FALLBACK', previous.fallback);
  }
}

const recorded: RunEngineRecord[] = [];

const run = (source: string, runId = 'run-1', runEvent: TriggerEvent = event) =>
  runMovement({ ...inputOf(source, makeTestHost({ adapters: { resolve: () => fakeEmail() } }), runId), event: runEvent });

beforeEach(() => {
  resetRustRunStats();
  recorded.length = 0;
  setRunEngineRecorder((record) => recorded.push(record));
});

afterEach(() => setRunEngineRecorder(undefined));

describe('the engine settings, checked at boot', () => {
  it('reads the fallback as ts unless it is none, and refuses anything else', () => {
    expect(engineFallback({})).toBe('ts');
    expect(engineFallback({ MOVEMENT_ENGINE_FALLBACK: 'none' })).toBe('none');
    expect(() => engineFallback({ MOVEMENT_ENGINE_FALLBACK: 'rust' })).toThrow('MOVEMENT_ENGINE_FALLBACK is "rust"');
  });

  it('refuses a bad fallback, and none without the Rust engine chosen', () => {
    expect(() => assertEngineChoiceConfigured({ MOVEMENT_ENGINE_FALLBACK: 'maybe' })).toThrow('MOVEMENT_ENGINE_FALLBACK is "maybe"');
    expect(() => assertEngineChoiceConfigured({ MOVEMENT_ENGINE_FALLBACK: 'none' })).toThrow('needs MOVEMENT_ENGINE=rust');
    expect(() => assertEngineChoiceConfigured({ MOVEMENT_ENGINE: 'ts', MOVEMENT_ENGINE_FALLBACK: 'none' })).toThrow('needs MOVEMENT_ENGINE=rust');
    expect(() => assertEngineChoiceConfigured({ MOVEMENT_ENGINE: 'rust', MOVEMENT_ENGINE_FALLBACK: 'none' })).not.toThrow();
    expect(() => assertEngineChoiceConfigured({ MOVEMENT_ENGINE: 'rust', MOVEMENT_ENGINE_FALLBACK: 'ts' })).not.toThrow();
    expect(() => assertEngineChoiceConfigured({})).not.toThrow();
  });
});

describe('the engine a run records', () => {
  it('records ts and the first reason Rust would refuse it for, under MOVEMENT_ENGINE=ts', async () => {
    await underConfig({ engine: 'ts' }, () => run(ADMITTED, 'run-refused', UNWIREABLE_EVENT));
    await underConfig({ engine: 'ts' }, () => run(ADMITTED, 'run-admitted'));
    expect(recorded).toEqual([
      { runId: 'run-refused', engine: 'ts', reason: 'event_does_not_cross' },
      { runId: 'run-admitted', engine: 'ts', reason: 'admitted' },
    ]);
  });

  it('records rust and no reason for a run the Rust engine ran', async () => {
    await underConfig({ engine: 'rust' }, () => run(ADMITTED));
    expect(recorded).toEqual([{ runId: 'run-1', engine: 'rust', reason: 'admitted' }]);
  });

  it('records ts and the refusal for a run the Rust engine refused and TypeScript ran', async () => {
    const result = await underConfig({ engine: 'rust', fallback: 'ts' }, () => run(ADMITTED, 'run-1', UNWIREABLE_EVENT));
    expect(result.movementName).toBe('m');
    expect(recorded).toEqual([{ runId: 'run-1', engine: 'ts', reason: 'event_does_not_cross' }]);
  });

  it('records nothing for a run with no id', async () => {
    await underConfig({ engine: 'ts' }, () => runMovement(inputOf(ADMITTED, makeTestHost({ adapters: { resolve: () => fakeEmail() } }))));
    expect(recorded).toEqual([]);
  });
});

describe('MOVEMENT_ENGINE_FALLBACK=none', () => {
  it('fails a refused run with the reason, and runs nothing on TypeScript', async () => {
    const failure = await underConfig({ engine: 'rust', fallback: 'none' }, () => run(ADMITTED, 'run-1', UNWIREABLE_EVENT)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MovementEngineError);
    expect(failure).toMatchObject({ code: 'MOVENG_UNSUPPORTED', details: { reason: 'event_does_not_cross' } });
    expect(String(failure)).toBe(
      'MovementEngineError: MOVENG_UNSUPPORTED: the Rust engine does not run this movement (event_does_not_cross), and MOVEMENT_ENGINE_FALLBACK=none leaves no other engine to run it',
    );
    expect(recorded).toEqual([{ runId: 'run-1', engine: 'rust', reason: 'event_does_not_cross' }]);
  });

  it('runs a run the Rust engine admits as it does with a fallback', async () => {
    const result = await underConfig({ engine: 'rust', fallback: 'none' }, () => run(ADMITTED));
    expect(result.movementName).toBe('m');
    expect(recorded).toEqual([{ runId: 'run-1', engine: 'rust', reason: 'admitted' }]);
  });

  it('fails a resume the Rust engine refuses, and records the refusal', async () => {
    const host = makeTestHost({ adapters: { resolve: () => fakeEmail() } });
    const failure = await underConfig({ engine: 'rust', fallback: 'none' }, () =>
      resumeMovement({ ...inputOf(ADMITTED, host, 'run-resume'), event: UNWIREABLE_EVENT, state: { version: 1 } as never, answer: true }),
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'MOVENG_UNSUPPORTED', details: { reason: 'event_does_not_cross' } });
    expect(recorded).toEqual([{ runId: 'run-resume', engine: 'rust', reason: 'event_does_not_cross' }]);
  });

  it('fails a run the engine admits and then declines, recording the decline', async () => {
    const host = makeTestHost({ adapters: { resolve: () => fakeEmail() } });
    const context = await openRunContext({ host, teamId: TEAM_ID, languageVersion: 3, spend: {} });
    const engine: EngineProtocol = {
      start: () => ({ done: { declined: 'test_decline' } }),
      answer: () => {
        throw new Error('test: nothing to answer');
      },
      finish: () => undefined,
    };
    await underConfig({ engine: 'rust', fallback: 'none' }, async () => {
      const outcome = await runSegmentInRust({ input: inputOf(ADMITTED, host, 'run-declined'), context }, engine);
      expect(outcome).toEqual({ declined: 'test_decline' });
      expect(refusalOutcome('test_decline')).toMatchObject({ code: 'MOVENG_UNSUPPORTED', details: { reason: 'test_decline' } });
    });
    expect(recorded).toEqual([{ runId: 'run-declined', engine: 'rust', reason: 'test_decline' }]);
  });

  it('records no rehearsal', async () => {
    const host = makeTestHost({ adapters: { resolve: () => fakeEmail() } });
    await underConfig({ engine: 'ts' }, () => runMovement({ ...inputOf(ADMITTED, host, 'run-rehearsal'), dryRun: true }));
    expect(recorded).toEqual([]);
  });
});
