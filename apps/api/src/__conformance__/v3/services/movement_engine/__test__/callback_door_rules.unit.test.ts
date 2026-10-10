// The two rules every door shares, tested once, where they live.
//
//   • `bindSuppliedValue` — the value-binding convention. A platform hands back
//     ONE value under a name of its own; the router puts it on the first
//     parameter nobody supplied. Nowhere to put it is a refusal, never a drop.
//   • `interactionServed` — whether the message's interactive purpose is done,
//     and so whether the door applies its platform after-effect. PROVISIONAL
//
// No store, no router: these are pure, and they are the part two doors must
// agree on.

import type { CallbackParamSpec, CallbackRecord } from '../callback_store';

import {
  bindSuppliedValue,
  callbackAckText,
  interactionServed,
  type CallbackFireOutcome,
} from '../callback_fire';

const DAY: CallbackParamSpec = { name: 'day', type: 'date' };
const NOTE: CallbackParamSpec = { name: 'note', type: 'text' };

function record(overrides: Partial<CallbackRecord> = {}): CallbackRecord {
  return {
    id: 'cb_abc',
    teamId: 'team-1',
    runId: 'run-1',
    address: 's1',
    params: [],
    state: { version: 1, address: 's1', bindingName: null, scopeChain: [] },
    calls: [],
    singleUse: true,
    expiresAt: null,
    status: 'live',
    createdAt: new Date('2026-07-31T09:00:00.000Z'),
    firedAt: null,
    revokedAt: null,
    ...overrides,
  } as CallbackRecord;
}

describe('bindSuppliedValue — one anonymous value, bound to the first unsupplied parameter', () => {
  it('binds to the only parameter', () => {
    expect(bindSuppliedValue([DAY], {}, '2026-08-15')).toEqual({
      ok: true,
      values: { day: '2026-08-15' },
    });
  });

  it('binds to the FIRST parameter in declaration order when several are free', () => {
    expect(bindSuppliedValue([DAY, NOTE], {}, '2026-08-15')).toEqual({
      ok: true,
      values: { day: '2026-08-15' },
    });
  });

  it('skips parameters already supplied by name', () => {
    expect(bindSuppliedValue([DAY, NOTE], { day: '2026-01-01' }, 'hello')).toEqual({
      ok: true,
      values: { day: '2026-01-01', note: 'hello' },
    });
  });

  it('supplying nothing is not binding anything — the values pass through untouched', () => {
    expect(bindSuppliedValue([DAY], { day: '2026-01-01' }, undefined)).toEqual({
      ok: true,
      values: { day: '2026-01-01' },
    });
    expect(bindSuppliedValue([], {}, undefined)).toEqual({ ok: true, values: {} });
  });

  it('REFUSES a value a zero-parameter callback has nowhere to put', () => {
    const bound = bindSuppliedValue([], {}, '2026-08-15');
    expect(bound.ok).toBe(false);
    if (bound.ok) throw new Error('expected a refusal');
    expect(bound.message).toMatch(/takes none/);
  });

  it('REFUSES when every parameter is already supplied — names what it takes', () => {
    const bound = bindSuppliedValue([DAY], { day: '2026-01-01' }, 'stray');
    expect(bound.ok).toBe(false);
    if (bound.ok) throw new Error('expected a refusal');
    expect(bound.message).toMatch(/day \(date\)/);
  });

  it('does not mutate the caller`s values', () => {
    const values: Record<string, unknown> = {};
    bindSuppliedValue([DAY], values, '2026-08-15');
    expect(values).toEqual({});
  });
});

describe('interactionServed — the shared after-effect predicate (PROVISIONAL)', () => {
  it('is true for a recorded fire on a SINGLE-USE callback: the message is spent', () => {
    expect(interactionServed({ kind: 'recorded', callback: record({ singleUse: true }) })).toBe(true);
  });

  it('is false for a repeatable callback: the controls are still live', () => {
    expect(interactionServed({ kind: 'recorded', callback: record({ singleUse: false }) })).toBe(false);
  });

  it.each<CallbackFireOutcome>([
    { kind: 'not_found' },
    { kind: 'closed', callback: record() },
    { kind: 'expired', callback: record() },
    { kind: 'mismatch', callback: record(), message: 'nope' },
  ])('is false for every refusal (%p) — closed-request-wins leaves the message alone', (outcome) => {
    expect(interactionServed(outcome)).toBe(false);
  });
});

describe('callbackAckText — one sentence, whatever the channel renders it in', () => {
  it('says what happened for each outcome, and never invents a silent success', () => {
    expect(callbackAckText({ kind: 'recorded', callback: record() })).toMatch(/recorded/);
    expect(callbackAckText({ kind: 'not_found' })).toMatch(/already closed/);
    expect(callbackAckText({ kind: 'closed', callback: record() })).toMatch(/already closed/);
    expect(callbackAckText({ kind: 'expired', callback: record() })).toMatch(/no longer available/);
    expect(
      callbackAckText({ kind: 'mismatch', callback: record(), message: "missing 'day'" }),
    ).toBe("That could not be recorded: missing 'day'");
  });
});
