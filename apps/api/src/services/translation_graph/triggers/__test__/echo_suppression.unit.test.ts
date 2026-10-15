// Opt-in echo-suppression — the `suppress_self` 2-way-sync feature.
//
// Two surfaces under test:
//   1. `consultEchoSuppression` — the pure inbound decision (off / on+authored /
//      on+can't-answer / on+not-ours / on+indeterminate).
//   2. `KnowledgeGraphAdapter.didWeAuthor` — the KG's authorship answer, SCOPED
//      to this change's authorship (our automation write = ours; a human edit
//      of a record we once wrote = NOT ours).
//
// Both are pure (no DB / Redis), so the adapter is constructed directly.

import type { Adapter } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MutationContext } from 'movement-engine/services/translation_graph/mutation_context';

import { KnowledgeGraphAdapter, KG_ADAPTER_TYPE } from '../../adapters/knowledge_graph';
import {
  consultEchoSuppression,
  suppressSelfEnabled,
} from '../echo_suppression';

const TEAM = 'team-1' as TeamId;

function event(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    pipelineInputId: 'trigger:t1',
    adapterType: KG_ADAPTER_TYPE,
    triggerType: 'mutation',
    payload: {},
    ...overrides,
  };
}

/** A minimal adapter stub carrying just an adapterType + an optional
 *  didWeAuthor — enough for the consult. */
function adapterStub(
  didWeAuthor?: (input: { event: TriggerEvent }) => Promise<boolean | null>,
): Adapter {
  const a: Partial<Adapter> = { adapterType: 'stub-adapter' };
  if (didWeAuthor) a.didWeAuthor = didWeAuthor;
  return a as Adapter;
}

describe('suppressSelfEnabled — the opt-in flag read', () => {
  it('is OFF by default (absent, null, non-object, false)', () => {
    expect(suppressSelfEnabled(undefined)).toBe(false);
    expect(suppressSelfEnabled(null)).toBe(false);
    expect(suppressSelfEnabled({})).toBe(false);
    expect(suppressSelfEnabled('true')).toBe(false);
    expect(suppressSelfEnabled({ suppress_self: false })).toBe(false);
    // Only the literal boolean true counts — a truthy non-true is still off.
    expect(suppressSelfEnabled({ suppress_self: 'true' })).toBe(false);
    expect(suppressSelfEnabled({ suppress_self: 1 })).toBe(false);
  });

  it('is ON only for the literal boolean true', () => {
    expect(suppressSelfEnabled({ suppress_self: true })).toBe(true);
  });
});

describe('consultEchoSuppression — the inbound decision', () => {
  it('PROCEEDS when the flag is off (the default) — never even consults the adapter', async () => {
    const didWeAuthor = jest.fn();
    const disposition = await consultEchoSuppression({
      triggerConfig: {},
      sourceAdapter: adapterStub(didWeAuthor),
      event: event(),
      triggerId: 't1',
    });
    expect(disposition).toEqual({ kind: 'proceed' });
    expect(didWeAuthor).not.toHaveBeenCalled();
  });

  it('SUPPRESSES when on AND the adapter says we authored it', async () => {
    const disposition = await consultEchoSuppression({
      triggerConfig: { suppress_self: true },
      sourceAdapter: adapterStub(async () => true),
      event: event(),
      triggerId: 't1',
    });
    expect(disposition.kind).toBe('suppress');
  });

  it('PROCEEDS when on but the adapter says we did NOT author it (a human/external change)', async () => {
    const disposition = await consultEchoSuppression({
      triggerConfig: { suppress_self: true },
      sourceAdapter: adapterStub(async () => false),
      event: event(),
      triggerId: 't1',
    });
    expect(disposition).toEqual({ kind: 'proceed' });
  });

  it('NO-OPs when on but the adapter cannot answer (no didWeAuthor capability)', async () => {
    const disposition = await consultEchoSuppression({
      triggerConfig: { suppress_self: true },
      sourceAdapter: adapterStub(), // no didWeAuthor
      event: event(),
      triggerId: 't1',
    });
    expect(disposition.kind).toBe('no-op');
    if (disposition.kind === 'no-op') {
      expect(disposition.note).toContain('suppress_self');
    }
  });

  it('PROCEEDS (does not suppress) when the adapter returns null (indeterminate for this event)', async () => {
    const disposition = await consultEchoSuppression({
      triggerConfig: { suppress_self: true },
      sourceAdapter: adapterStub(async () => null),
      event: event(),
      triggerId: 't1',
    });
    expect(disposition).toEqual({ kind: 'proceed' });
  });

  it('FAILS OPEN to a no-op when didWeAuthor throws — never blocks a legitimate event', async () => {
    const disposition = await consultEchoSuppression({
      triggerConfig: { suppress_self: true },
      sourceAdapter: adapterStub(async () => {
        throw new Error('boom');
      }),
      event: event(),
      triggerId: 't1',
    });
    expect(disposition.kind).toBe('no-op');
  });
});

describe('KnowledgeGraphAdapter.didWeAuthor — scoped to THIS change', () => {
  // `didWeAuthor` answers from the event's own provenance, so no connection is
  // needed — the adapter never reaches the graph on this path.
  const adapter = new KnowledgeGraphAdapter({ teamId: TEAM });

  function kgEvent(context: MutationContext): TriggerEvent {
    return event({
      payload: {
        recordId: '00000000-0000-0000-0000-000000000001',
        nodeTypeId: 'nt-company',
        changeKind: 'update',
        changedFields: ['name'],
        context,
      },
    });
  }

  it('SUPPRESSES our own automated write — structured_input from a trigger', async () => {
    const result = await adapter.didWeAuthor({
      event: kgEvent({
        source: {
          type: 'structured_input',
          adapterType: KG_ADAPTER_TYPE,
          pipelineInputId: 'trigger:t1',
          triggerType: 'mutation',
        },
        occurredAt: new Date().toISOString(),
      }),
    });
    expect(result).toBe(true);
  });

  it('SUPPRESSES an extraction write that carries a translationGraphId', async () => {
    const result = await adapter.didWeAuthor({
      event: kgEvent({
        source: {
          type: 'extraction',
          adapterType: KG_ADAPTER_TYPE,
          translationGraphId: 'tg-7',
        },
        occurredAt: new Date().toISOString(),
      }),
    });
    expect(result).toBe(true);
  });

  it('does NOT suppress a human edit — user_edit fires normally (the over-suppression trap)', async () => {
    const result = await adapter.didWeAuthor({
      event: kgEvent({
        source: { type: 'user_edit', adapterType: KG_ADAPTER_TYPE },
        occurredAt: new Date().toISOString(),
        actorId: 'human-user-42',
      }),
    });
    expect(result).toBe(false);
  });

  it('does NOT suppress an interactive agent edit', async () => {
    const result = await adapter.didWeAuthor({
      event: kgEvent({
        source: { type: 'agent', adapterType: KG_ADAPTER_TYPE },
        occurredAt: new Date().toISOString(),
        actorId: 'agent-op',
      }),
    });
    expect(result).toBe(false);
  });

  it('does NOT suppress a structured_input with NO automation marker (provenance too weak)', async () => {
    const result = await adapter.didWeAuthor({
      event: kgEvent({
        source: { type: 'structured_input', adapterType: KG_ADAPTER_TYPE },
        occurredAt: new Date().toISOString(),
      }),
    });
    expect(result).toBe(false);
  });

  it('returns null for a non-mutation payload (cannot tell — defers to no-suppress)', async () => {
    const result = await adapter.didWeAuthor({ event: event({ payload: { not: 'a mutation' } }) });
    expect(result).toBeNull();
  });
});
