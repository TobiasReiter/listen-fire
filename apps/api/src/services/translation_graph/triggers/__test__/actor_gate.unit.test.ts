// Ownership gating for inbound events (message-write-unification §6.4b):
// a gated adapter's inbound event is processed only when its actor
// resolves to a REGISTERED team user. The bot is never a registered user,
// so self-echo drops for free; an unregistered human drops by the same
// rule. The resolver is called WITHOUT trigger context — creator
// override / fallbackToCreatorIfActorUnregistered must not pass the gate.

import type { Adapter, ActingUser, ActorCandidate } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { TeamId } from '../../../../generated/kysely/core/Team';

import { consultActorGate, inboundActorGateEnabled } from '../actor_gate';

const TEAM_ID = 'team-1' as TeamId;

const event = (adapterType: string): TriggerEvent => ({
  pipelineInputId: 'trigger:t1',
  adapterType,
  triggerType: 'webhook',
  payload: { type: 'message', user: 'U123' },
  occurredAt: new Date().toISOString(),
});

const adapterWith = (candidates: ActorCandidate[]): Adapter =>
  ({ adapterType: 'slack', getActorCandidates: async () => candidates } as unknown as Adapter);

const registered: ActingUser = { id: 'u-1', email: 'ada@example.com', name: 'Ada' } as ActingUser;

describe('inboundActorGateEnabled — the manifest fact', () => {
  it('is on for slack and off for attio (pins the real manifests)', () => {
    expect(inboundActorGateEnabled('slack')).toBe(true);
    expect(inboundActorGateEnabled('attio')).toBe(false);
  });
});

describe('consultActorGate', () => {
  const candidate: ActorCandidate = {
    identity: { identifier: 'U123', scheme: 'email', adapterType: 'slack', email: 'ada@example.com' },
    source: 'originator',
  };

  it('proceeds when the actor resolves to a registered user', async () => {
    const gate = await consultActorGate({
      teamId: TEAM_ID,
      sourceAdapter: adapterWith([candidate]),
      event: event('slack'),
      resolve: async () => registered,
    });
    expect(gate).toEqual({ kind: 'proceed' });
  });

  it('drops when the actor does not resolve (unregistered human)', async () => {
    const gate = await consultActorGate({
      teamId: TEAM_ID,
      sourceAdapter: adapterWith([candidate]),
      event: event('slack'),
      resolve: async () => null,
    });
    expect(gate.kind).toBe('drop');
    if (gate.kind === 'drop') expect(gate.reason).toContain('registered');
  });

  it('drops when there are no candidates at all (the bot self-echo shape)', async () => {
    let sawCandidates: ActorCandidate[] | undefined;
    const gate = await consultActorGate({
      teamId: TEAM_ID,
      sourceAdapter: adapterWith([]),
      event: event('slack'),
      resolve: async ({ getCandidates }) => {
        sawCandidates = await getCandidates();
        return sawCandidates.length > 0 ? registered : null;
      },
    });
    expect(sawCandidates).toEqual([]);
    expect(gate.kind).toBe('drop');
  });

  it('passes NO trigger context to the resolver (override/fallback cannot reopen the loop)', async () => {
    let sawTrigger: unknown = 'unset';
    await consultActorGate({
      teamId: TEAM_ID,
      sourceAdapter: adapterWith([candidate]),
      event: event('slack'),
      resolve: async (input) => {
        sawTrigger = (input as { trigger?: unknown }).trigger;
        return registered;
      },
    });
    expect(sawTrigger).toBeUndefined();
  });

  it('an ungated adapter proceeds without consulting the resolver', async () => {
    let resolved = false;
    const gate = await consultActorGate({
      teamId: TEAM_ID,
      sourceAdapter: adapterWith([candidate]),
      event: event('attio'),
      resolve: async () => { resolved = true; return registered; },
    });
    expect(gate).toEqual({ kind: 'proceed' });
    expect(resolved).toBe(false);
  });

  it('a throwing resolver drops (fail closed — the receipt stays replayable)', async () => {
    const gate = await consultActorGate({
      teamId: TEAM_ID,
      sourceAdapter: adapterWith([candidate]),
      event: event('slack'),
      resolve: async () => { throw new Error('users.info exploded'); },
    });
    expect(gate.kind).toBe('drop');
    if (gate.kind === 'drop') expect(gate.reason).toContain('could not be resolved');
  });

  it('an outage during candidate lookup (users.info throws) drops with the lookup-failure ' +
    'reason, NOT the unregistered-sender reason — even through the real resolveActingUser ' +
    'chain (no `resolve` override)', async () => {
    const outageAdapter: Adapter = {
      adapterType: 'slack',
      getActorCandidates: async () => {
        throw new Error('missing_scope');
      },
    } as unknown as Adapter;
    const gate = await consultActorGate({
      teamId: TEAM_ID,
      sourceAdapter: outageAdapter,
      event: event('slack'),
    });
    expect(gate.kind).toBe('drop');
    if (gate.kind === 'drop') {
      expect(gate.reason).toContain('could not be resolved');
      expect(gate.reason).not.toContain('does not resolve to a registered');
    }
  });
});
