// T5 — acting-user + actor meta resolution chains.
//
// `@user_email` / `@user_name` / `@user_id` resolve through:
//   1. Source adapter's `getActorCandidates` (a pure parse of the event
//      into ordered `ActorCandidate[]`) handed to Listen-Fire's
//      `resolveActingUser`, which runs the creator-override → originator
//      → relay → creator-fallback → null chain against the DB.
//   2. `null` — `@user_*` fields collapse to null.
//
// `@actor_email` / `@actor_name` / `@actor_id` resolve through:
//   1. Source adapter's `extractActor` (pure parse of the event payload;
//      async only for remoteability).
//   2. `null` — `@actor_*` fields collapse to null.

import type {
  ActorCandidate,
  ActorIdentity,
  Adapter,
  RuntimeCapabilities,
} from '../adapter';
import type { Expression } from '../../knowledge_pipeline/output_v3/expression';
import type { TriggerEvent } from '../triggers/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

import { type SourcePosition, makeUnstablePosition } from '../types';

const dbQueue: Array<unknown> = [];
function setDbRow(row: unknown) {
  dbQueue.push(row);
}
function mockChainable(): object {
  const handler: ProxyHandler<object> = {
    get(_t: object, prop: string | symbol): unknown {
      if (prop === 'executeTakeFirst') return async () => dbQueue.shift() ?? null;
      if (prop === 'execute') return async () => [];
      if (prop === 'then') return undefined;
      return () => mockChainable();
    },
  };
  return new Proxy({}, handler);
}
jest.mock('../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(() => mockChainable()),
  getAutomationsQb: jest.fn(() => mockChainable()),
  getQb: jest.fn(() => mockChainable()),
  getCoreQb: jest.fn(() => mockChainable()),
}));

import {
  evaluateExpression,
  type ExpressionEvalContext,
} from '../engine/expression';

function permissiveCaps(): RuntimeCapabilities {
  return {
    traversal: { incoming: false, edgeProperties: false },
    resources: false,
  };
}

function makeAdapter(opts: {
  candidates?: ActorCandidate[];
  actor?: ActorIdentity | null;
  throws?: boolean;
  candidatesSpy?: jest.Mock;
  extractActorSpy?: jest.Mock;
  noCandidates?: boolean;
}): Adapter {
  const getActorCandidates = opts.candidatesSpy
    ?? jest.fn(async () => {
      if (opts.throws) throw new Error('boom');
      return opts.candidates ?? [];
    });
  const extractActor = opts.extractActorSpy
    ?? jest.fn(async () => opts.actor ?? null);
  const adapter: Adapter & { candidatesSpy: jest.Mock; actorSpy: jest.Mock } = {
    adapterType: 'email',
    supportedTriggers: [] as never[],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() { return []; },
    async describe() { return null; },
    async resolveEntity() { return { candidates: [] }; },
    async getFieldValue() { return null; },
    async getRelated() { return []; },
    async createRecord() { return { adapterType: 'email', externalId: 'stub', data: {} }; },
    async updateRecord() { return { adapterType: 'email', externalId: 'updated', data: {}, association: 'none' }; },
    async deleteRecord() { return {}; },
    getActorCandidates,
    extractActor,
    candidatesSpy: getActorCandidates as jest.Mock,
    actorSpy: extractActor as jest.Mock,
  };
  if (opts.noCandidates) delete (adapter as Partial<Adapter>).getActorCandidates;
  return adapter;
}

const ORIGINATOR: ActorCandidate = {
  identity: { identifier: 'ada@example.com', scheme: 'email', email: 'ada@example.com' },
  source: 'originator',
};

function makeCtx(input: {
  adapter: Adapter;
  trigger?: TriggerEvent;
}): ExpressionEvalContext {
  const position: SourcePosition = makeUnstablePosition({
    adapterType: 'email',
    recordType: null,
    data: {},
  });
  return {
    sourceAdapter: input.adapter,
    position,
    meta: {},
    trigger: input.trigger,
    teamId: 'team-1' as unknown as TeamId,
  };
}

const triggerEvent: TriggerEvent = {
  pipelineInputId: 'pi-1',
  adapterType: 'email',
  triggerType: 'webhook',
  triggerEntryId: 'te-1',
  payload: { sender: 'ada@example.com' },
};

beforeEach(() => {
  dbQueue.length = 0;
});

describe('@user_* resolution chain (T5)', () => {
  it('candidate resolves to a team user → that user lands in @user_email', async () => {
    const adapter = makeAdapter({ candidates: [ORIGINATOR] });
    // The resolver loads the trigger row first, then resolves the
    // originator candidate against `user_email`.
    setDbRow({ id: 't-1', kind: 'CUSTOM_EMAIL', config: {}, created_by_user_id: null });
    setDbRow({ id: 'u-1', email: 'ada@example.com', username: 'Ada' });
    const ctx = makeCtx({ adapter, trigger: triggerEvent });
    const expr: Expression = { type: 'meta', key: 'user_email' };
    expect(await evaluateExpression(expr, ctx)).toBe('ada@example.com');
  });

  it('candidate resolves → @user_name and @user_id work too', async () => {
    const adapter = makeAdapter({ candidates: [ORIGINATOR] });
    setDbRow({ id: 't-1', kind: 'CUSTOM_EMAIL', config: {}, created_by_user_id: null });
    setDbRow({ id: 'u-1', email: 'ada@example.com', username: 'Ada' });
    const ctx = makeCtx({ adapter, trigger: triggerEvent });
    expect(await evaluateExpression({ type: 'meta', key: 'user_name' }, ctx)).toBe('Ada');
    expect(await evaluateExpression({ type: 'meta', key: 'user_id' }, ctx)).toBe('u-1');
  });

  it('no candidate matches → @user_email is null (no framework creator fallback in T5)', async () => {
    const adapter = makeAdapter({ candidates: [ORIGINATOR] });
    setDbRow({ id: 't-1', kind: 'CUSTOM_EMAIL', config: {}, created_by_user_id: 'u-creator' });
    setDbRow(null); // originator lookup misses
    const ctx = makeCtx({ adapter, trigger: triggerEvent });
    // The dispatcher would have rejected before reaching here in
    // production. The resolver returns null so any in-flight field
    // mappings collapse cleanly.
    expect(await evaluateExpression({ type: 'meta', key: 'user_email' }, ctx))
      .toBeNull();
  });

  it('getActorCandidates throws → @user_email is null (resolver swallows, doesn\'t bubble)', async () => {
    const adapter = makeAdapter({ throws: true });
    setDbRow({ id: 't-1', kind: 'CUSTOM_EMAIL', config: {}, created_by_user_id: null });
    const ctx = makeCtx({ adapter, trigger: triggerEvent });
    expect(await evaluateExpression({ type: 'meta', key: 'user_email' }, ctx))
      .toBeNull();
  });

  it('no trigger on context → @user_email is null (defensive — ad-hoc evaluations)', async () => {
    const adapter = makeAdapter({ candidates: [ORIGINATOR] });
    const ctx = makeCtx({ adapter });
    expect(await evaluateExpression({ type: 'meta', key: 'user_email' }, ctx))
      .toBeNull();
  });

  it('adapter without getActorCandidates → @user_email is null', async () => {
    const adapter = makeAdapter({ noCandidates: true });
    setDbRow({ id: 't-1', kind: 'CUSTOM_EMAIL', config: {}, created_by_user_id: null });
    const ctx = makeCtx({ adapter, trigger: triggerEvent });
    expect(await evaluateExpression({ type: 'meta', key: 'user_email' }, ctx))
      .toBeNull();
  });

  it('caches the resolution — getActorCandidates called once for many @user_* references', async () => {
    const adapter = makeAdapter({ candidates: [ORIGINATOR] });
    setDbRow({ id: 't-1', kind: 'CUSTOM_EMAIL', config: {}, created_by_user_id: null });
    setDbRow({ id: 'u-1', email: 'ada@example.com', username: 'Ada' });
    const spy = (adapter as Adapter & { candidatesSpy: jest.Mock }).candidatesSpy;
    const ctx = makeCtx({ adapter, trigger: triggerEvent });
    await evaluateExpression({ type: 'meta', key: 'user_email' }, ctx);
    await evaluateExpression({ type: 'meta', key: 'user_name' }, ctx);
    await evaluateExpression({ type: 'meta', key: 'user_id' }, ctx);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('threads the trigger row into resolveActingUser so config + createdByUserId drive fallback', async () => {
    // No candidate matches and fallback is on → the resolver must reach
    // the trigger's creator row, proving the trigger row was threaded in.
    const adapter = makeAdapter({ candidates: [ORIGINATOR] });
    setDbRow({
      id: 't-7',
      kind: 'SLACK',
      config: { fallbackToCreatorIfActorUnregistered: true },
      created_by_user_id: 'creator-7',
    });
    setDbRow(null); // originator lookup misses
    setDbRow({ id: 'creator-7', email: 'creator7@example.com', username: 'c7' }); // creator load
    const ctx = makeCtx({ adapter, trigger: triggerEvent });
    expect(await evaluateExpression({ type: 'meta', key: 'user_id' }, ctx))
      .toBe('creator-7');
  });
});

describe('@actor_* resolution chain (T5)', () => {
  it('adapter returns actor → that actor lands in @actor_email / @actor_name / @actor_id', async () => {
    const adapter = makeAdapter({
      actor: {
        identifier: 'external@example.com',
        scheme: 'email',
        email: 'external@example.com',
        name: 'External Sender',
      },
    });
    const ctx = makeCtx({ adapter, trigger: triggerEvent });
    expect(await evaluateExpression({ type: 'meta', key: 'actor_email' }, ctx))
      .toBe('external@example.com');
    expect(await evaluateExpression({ type: 'meta', key: 'actor_name' }, ctx))
      .toBe('External Sender');
    expect(await evaluateExpression({ type: 'meta', key: 'actor_id' }, ctx))
      .toBe('external@example.com');
  });

  it('falls back to identifier when scheme=email but email field is unset', async () => {
    const adapter = makeAdapter({
      actor: { identifier: 'plain@example.com', scheme: 'email' },
    });
    const ctx = makeCtx({ adapter, trigger: triggerEvent });
    expect(await evaluateExpression({ type: 'meta', key: 'actor_email' }, ctx))
      .toBe('plain@example.com');
  });

  it('returns null for @actor_email when scheme is opaque and email is unset', async () => {
    const adapter = makeAdapter({
      actor: { identifier: 'U123', scheme: 'opaque' },
    });
    const ctx = makeCtx({ adapter, trigger: triggerEvent });
    expect(await evaluateExpression({ type: 'meta', key: 'actor_email' }, ctx))
      .toBeNull();
    // @actor_id still resolves to the slack id regardless.
    expect(await evaluateExpression({ type: 'meta', key: 'actor_id' }, ctx))
      .toBe('U123');
  });

  it('caches the actor — extractActor called once for many @actor_* references', async () => {
    const adapter = makeAdapter({
      actor: { identifier: 'a@b.com', scheme: 'email', email: 'a@b.com', name: 'A' },
    });
    const spy = (adapter as Adapter & { actorSpy: jest.Mock }).actorSpy;
    const ctx = makeCtx({ adapter, trigger: triggerEvent });
    await evaluateExpression({ type: 'meta', key: 'actor_email' }, ctx);
    await evaluateExpression({ type: 'meta', key: 'actor_name' }, ctx);
    await evaluateExpression({ type: 'meta', key: 'actor_id' }, ctx);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('adapter without extractActor → @actor_* all null', async () => {
    const adapter = makeAdapter({});
    // Strip extractActor to mimic non-implementing adapters.
    delete (adapter as Partial<Adapter>).extractActor;
    const ctx = makeCtx({ adapter, trigger: triggerEvent });
    expect(await evaluateExpression({ type: 'meta', key: 'actor_email' }, ctx))
      .toBeNull();
    expect(await evaluateExpression({ type: 'meta', key: 'actor_id' }, ctx))
      .toBeNull();
  });
});
