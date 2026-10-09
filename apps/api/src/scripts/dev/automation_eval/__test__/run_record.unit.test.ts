import type { MovementTraceEntry } from '../../../../services/movement_engine/expression';

import { runRecordOf } from '../run_record';

const run = { id: 'r1', status: 'success', failureReason: null };

// Entries as the engine writes them: the `extract` keyword attaches `entities`
// to its last entry; the `extract(…)` call (`form: 'call'`) records counts and,
// only for a misbehaving reply, a digest.
const keywordEntry = {
  kind: 'extraction',
  node: 'company',
  inputChars: 120,
  model: 'm1',
  emissions: { company: 1, founder: 2 },
  entities: { company: [{ fields: { name: 'Acme AI', website: null } }] },
} satisfies MovementTraceEntry;

const callEntry = {
  kind: 'extraction',
  form: 'call',
  node: 'Founder',
  inputChars: 300,
  model: 'm2',
  durationMs: 900,
  emissions: { Founder: 3 },
  empty: { Founder: 1 },
  dropped: { Founder: 1 },
  retried: ['founders.0.name: Required'],
  reply: { why: ['dropped_records', 'retried'], keys: ['founders'], sample: 'x'.repeat(500) },
} satisfies MovementTraceEntry;

describe('runRecordOf', () => {
  it('summarizes writes, extractions, untaken branches and errors compactly', () => {
    const record = runRecordOf(run, {
      body: {
        writes: [
          { target: 'attio:companies', action: 'create', committed: true, values: { name: 'Acme AI', blob: 'x'.repeat(500) } },
          { target: 'slack:messages', action: 'noop', committed: false, values: {} },
          { target: 'attio:companies', action: 'attach', committed: true },
        ],
        trace: [
          keywordEntry,
          { kind: 'gate', outcome: false },
          { kind: 'gate', outcome: true },
          { kind: 'warning', code: 'W1', message: 'careful' },
        ],
        errors: [{ message: 'boom' }],
      },
    });
    expect(record).toMatchObject({
      id: 'r1',
      inspected: true,
      branchesNotTaken: 1,
      warnings: ['W1: careful'],
      errors: ['boom'],
      extractions: [{ node: 'company', emissions: { company: 1, founder: 2 }, entities: { company: [{ name: 'Acme AI', website: null }] } }],
    });
    if (!record.inspected) throw new Error('expected an inspected record');
    expect(record.writes.map((w) => [w.system, w.recordType, w.outcome])).toEqual([
      ['attio', 'companies', 'created'],
      ['slack', 'messages', 'skipped'],
      ['attio', 'companies', 'updated'],
    ]);
    expect(record.writes[0]?.values.blob?.length).toBeLessThan(120);
  });

  it('keeps the counts and reply digest of an extract(…) call, which records no entity values', () => {
    const record = runRecordOf(run, { body: { writes: [], trace: [callEntry, { kind: 'extraction', form: 'call', node: 'X', inputChars: 0, skipped: 'empty_source', emissions: { X: 0 } } satisfies MovementTraceEntry], errors: [] } });
    if (!record.inspected) throw new Error('expected an inspected record');
    const [first, second] = record.extractions;
    expect(first).toMatchObject({
      node: 'Founder',
      form: 'call',
      model: 'm2',
      emissions: { Founder: 3 },
      empty: { Founder: 1 },
      dropped: { Founder: 1 },
      retried: ['founders.0.name: Required'],
      entities: {},
    });
    expect(first?.reply).toMatchObject({ why: ['dropped_records', 'retried'], keys: ['founders'] });
    expect(first?.reply?.sample.length).toBeLessThan(120);
    expect(second).toMatchObject({ skipped: 'empty_source', emissions: { X: 0 } });
    expect(second).not.toHaveProperty('empty');
  });

  it('caps the writes list and says how many it left out', () => {
    const writes = Array.from({ length: 30 }, () => ({ target: 'a:b', action: 'create', committed: true, values: {} }));
    const record = runRecordOf(run, { body: { writes, trace: [], errors: [] } });
    if (!record.inspected) throw new Error('expected an inspected record');
    expect(record.writes).toHaveLength(20);
    expect(record.writesOmitted).toBe(10);
  });

  it('records why a run could not be inspected', () => {
    expect(runRecordOf(run, { error: 'inspect-run 404' })).toMatchObject({ inspected: false, inspectError: 'inspect-run 404' });
    expect(runRecordOf(run, { body: { error: 'run r1 not found' } })).toMatchObject({ inspected: false });
  });
});
