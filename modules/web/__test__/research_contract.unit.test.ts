import { emptyUsage, noteFetchFailure, outcomeOf } from '../research/contract';

// The one place both research engines decide `ResearchOutcome` — see
// 1_contract.md "Outcomes". A failed side fetch must never outrank a real
// answer; it only explains an answer that is otherwise empty.

describe('outcomeOf', () => {
  it('is resolved when everything is answered, even alongside a failed side fetch', () => {
    expect(outcomeOf({ answered: 'all', fetchFailed: true })).toBe('resolved');
    expect(outcomeOf({ answered: 'all', fetchFailed: false })).toBe('resolved');
  });

  it('is partial when some questions are answered, whatever the fetch state', () => {
    expect(outcomeOf({ answered: 'some', fetchFailed: true })).toBe('partial');
    expect(outcomeOf({ answered: 'some', fetchFailed: false })).toBe('partial');
  });

  it('is fetch_failed when nothing was answered and a fetch error explains why', () => {
    expect(outcomeOf({ answered: 'none', fetchFailed: true })).toBe('fetch_failed');
  });

  it('is no_match when nothing was answered and no fetch error explains why', () => {
    expect(outcomeOf({ answered: 'none', fetchFailed: false })).toBe('no_match');
  });
});

describe('noteFetchFailure', () => {
  it('records the failure on usage.notes without touching the outcome', () => {
    const usage = emptyUsage();
    const outcome = outcomeOf({ answered: 'all', fetchFailed: true });
    noteFetchFailure(usage, 'fetch https://example.com: url_not_accessible');

    expect(outcome).toBe('resolved');
    expect(usage.notes).toEqual([
      expect.stringContaining('fetch https://example.com: url_not_accessible'),
    ]);
  });

  it('appends to existing notes rather than replacing them', () => {
    const usage = emptyUsage();
    usage.notes = ['dropped a verification opener: foo'];
    noteFetchFailure(usage, 'fetch https://example.com: url_not_accessible');

    expect(usage.notes).toHaveLength(2);
    expect(usage.notes?.[0]).toBe('dropped a verification opener: foo');
  });
});
