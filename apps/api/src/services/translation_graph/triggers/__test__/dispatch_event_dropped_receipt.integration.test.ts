// The shared inbound-dispatch tail (`dispatchDiscriminableEvent` in
// `dispatch_event.ts`) used to unconditionally mark the stored receipt
// 'dispatched' after calling `dispatchTriggerByIdEvent`, even when the router
// DROPPED the event (actor-unregistered ownership gate, opt-in echo
// suppression) and had already marked the receipt 'suppressed' with a reason.
// That clobbered the audit trail back to 'dispatched' / failure_reason=null —
// the security behaviour was fine (the drop return precedes movement
// execution), but the visible trace was lost.
//
// This drives the REAL dispatch path — `dispatchDiscriminableEvent` — end to
// end against the real DB (only the adapter-resolution seam is faked, per the
// convention in `typed_event_dispatch.integration.test.ts`) and asserts the
// stored `trigger_event` row keeps its suppressed outcome rather than being
// overwritten.

import { randomUUID } from 'node:crypto';

jest.mock('../../adapters/resolve', () => {
  const actual = jest.requireActual('../../adapters/resolve');
  return { ...actual, resolveAdapter: jest.fn() };
});

import { sql } from 'kysely';
import { SUPPRESS_SELF_KEY } from 'movement-lang';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import type { PipelineConfigurationId } from '../../../../generated/kysely/public/PipelineConfiguration';
import type { Adapter, DiscriminableEvent } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';

import { getAutomationsQb, getCoreQb, getQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { dispatchDiscriminableEvent } from '../dispatch_event';
import { storeTriggerEvent, replayTriggerEvent } from '../event_store';
import { resolveAdapter } from '../../adapters/resolve';



const mockedResolve = resolveAdapter as jest.Mock;

async function seedTrigger(input: {
  teamId: TeamId;
  kind: string;
  config?: Record<string, unknown>;
}): Promise<{ triggerId: TriggerId; movementId: MovementId }> {
  const pipelineConfigurationId = randomUUID() as PipelineConfigurationId;
  await getQb(['pipeline_configuration'])
    .insertInto('pipeline_configuration')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({
      id: pipelineConfigurationId,
      team_id: input.teamId,
      name: `cfg-${pipelineConfigurationId.slice(0, 8)}`,
    } as any)
    .execute();

  const movementId = randomUUID() as MovementId;
  await getAutomationsQb(['movement'])
    .insertInto('movement')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({
      id: movementId,
      team_id: input.teamId,
      name: 'unused',
      // Never parsed — both gates under test return before `movementForTrigger`
      // ever loads this source.
      source: '// unused — the gate drops before this movement loads',
    } as any)
    .execute();

  const triggerId = randomUUID() as TriggerId;
  await getAutomationsQb(['trigger'])
    .insertInto('trigger')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({
      id: triggerId,
      team_id: input.teamId,
      pipeline_configuration_id: pipelineConfigurationId,
      name: `trigger-${input.kind}`,
      kind: input.kind,
      movement_id: movementId,
      fired_movement_name: 'unused',
      ...(input.config !== undefined
        ? { config: sql`${JSON.stringify(input.config)}::jsonb` }
        : {}),
    } as any)
    .execute();

  return { triggerId, movementId };
}

function makeEvent(): DiscriminableEvent {
  return {
    payload: { hello: 'world' },
    // No `actor` set — keeps the always-on native-echo check (a different,
    // unrelated drop path) out of play so the test isolates the gate under
    // test.
    occurredAt: new Date().toISOString(),
  };
}

async function loadReceipt(triggerId: TriggerId) {
  return getAutomationsQb(['trigger_event'])
    .selectFrom('trigger_event')
    .where('trigger_id', '=', triggerId)
    .selectAll()
    .executeTakeFirstOrThrow();
}

describe('dispatchDiscriminableEvent — dropped events keep their suppressed receipt', () => {
  let teamId: TeamId;

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({
        id: teamId,
        name: `dispatch-drop-it-${teamId.slice(0, 8)}`,
      } as any)
      .execute();
  });

  afterEach(async () => {
    // `trigger_event.team_id` is ON DELETE RESTRICT — clear it before the
    // shared harness deletes the team row.
    await sql`DELETE FROM automations.trigger_event WHERE team_id = ${teamId}`.execute(
      getQb([]),
    );
    await cleanupTeam(teamId);
    jest.clearAllMocks();
  });

  it('actor_unregistered (ownership gate): receipt ends suppressed, not clobbered back to dispatched', async () => {
    const { triggerId, movementId } = await seedTrigger({ teamId, kind: 'slack' });

    // Slack is a gated adapter (inboundActorGateEnabled). A fake with no
    // `getActorCandidates` makes the gate drop deterministically, no network.
    mockedResolve.mockResolvedValue({ adapterType: 'slack' } as unknown as Adapter);

    await dispatchDiscriminableEvent({
      triggerId,
      movementId,
      event: makeEvent(),
      adapterType: 'slack',
      triggerType: 'webhook',
      eventTypes: [],
      teamId,
    });

    const row = await loadReceipt(triggerId);
    expect(row.status).toBe('suppressed');
    expect(row.failure_reason).toMatch(/registered/);
    expect(row.failure_reason).not.toBeNull();
  });

  it('echo_suppressed (opt-in suppress_self): receipt ends suppressed, not clobbered back to dispatched', async () => {
    const { triggerId, movementId } = await seedTrigger({
      teamId,
      kind: 'attio',
      config: { [SUPPRESS_SELF_KEY]: true },
    });

    // attio is NOT actor-gated; a fake that confirms authorship (`didWeAuthor`
    // → true) makes echo-suppression drop deterministically, no network.
    const fakeAdapter: Partial<Adapter> = {
      adapterType: 'attio',
      didWeAuthor: async () => true,
    };
    mockedResolve.mockResolvedValue(fakeAdapter as unknown as Adapter);

    await dispatchDiscriminableEvent({
      triggerId,
      movementId,
      event: makeEvent(),
      adapterType: 'attio',
      triggerType: 'webhook',
      eventTypes: [],
      teamId,
    });

    const row = await loadReceipt(triggerId);
    expect(row.status).toBe('suppressed');
    expect(row.failure_reason).toMatch(/authored by our own write/);
    expect(row.failure_reason).not.toBeNull();
  });

  it('replay of a dropped event (dispatchStoredTriggerEvent tail): receipt ends suppressed, not clobbered back to dispatched', async () => {
    const { triggerId } = await seedTrigger({ teamId, kind: 'slack' });
    mockedResolve.mockResolvedValue({ adapterType: 'slack' } as unknown as Adapter);

    // Store the receipt directly (the receive-path shape), then drive the
    // OTHER tail — `dispatchStoredTriggerEvent`, via its replay entry — twice:
    // first dispatch (dropped by the ownership gate), then a replay while the
    // actor is STILL unregistered. Both go through the same tail; the receipt
    // must end 'suppressed', never overwritten to 'dispatched'/null.
    const triggerEvent: TriggerEvent = {
      pipelineInputId: `trigger:${triggerId}`,
      adapterType: 'slack',
      triggerType: 'webhook',
      payload: { hello: 'world' },
      occurredAt: new Date().toISOString(),
    };
    const { id: eventId } = await storeTriggerEvent({ teamId, triggerId, event: triggerEvent });

    const first = await replayTriggerEvent({ teamId, eventId });
    expect(first.replayed).toBe(true);
    let row = await loadReceipt(triggerId);
    expect(row.status).toBe('suppressed');
    expect(row.failure_reason).toMatch(/registered/);

    const second = await replayTriggerEvent({ teamId, eventId });
    expect(second.replayed).toBe(true);
    row = await loadReceipt(triggerId);
    expect(row.status).toBe('suppressed');
    expect(row.failure_reason).toMatch(/registered/);
    expect(row.failure_reason).not.toBeNull();
  });

  it('idempotency: a redelivery with the same idempotencyKey stores once and flags duplicate', async () => {
    const { triggerId } = await seedTrigger({ teamId, kind: 'slack' });
    const base: TriggerEvent = {
      pipelineInputId: `trigger:${triggerId}`,
      adapterType: 'slack',
      triggerType: 'webhook',
      payload: { hello: 'world' },
      idempotencyKey: 'Ev_DEDUP_TEST',
      occurredAt: new Date().toISOString(),
    };

    const first = await storeTriggerEvent({ teamId, triggerId, event: base });
    expect(first.duplicate).toBe(false);

    // Same delivery id (Slack retry) → no-op insert, flagged duplicate, same row.
    const second = await storeTriggerEvent({ teamId, triggerId, event: base });
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);

    const count = await getAutomationsQb(['trigger_event'])
      .selectFrom('trigger_event')
      .where('trigger_id', '=', triggerId)
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1);
  });

  it('idempotency: a NULL idempotencyKey is never deduped (distinct deliveries each store)', async () => {
    const { triggerId } = await seedTrigger({ teamId, kind: 'attio' });
    const base: TriggerEvent = {
      pipelineInputId: `trigger:${triggerId}`,
      adapterType: 'attio',
      triggerType: 'webhook',
      payload: { hello: 'world' },
      occurredAt: new Date().toISOString(),
    };

    const first = await storeTriggerEvent({ teamId, triggerId, event: base });
    const second = await storeTriggerEvent({ teamId, triggerId, event: base });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(false);
    expect(second.id).not.toBe(first.id);
  });
});
