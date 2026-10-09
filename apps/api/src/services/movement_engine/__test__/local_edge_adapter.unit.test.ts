// The engine's own store for a local node's edge, and the key it blocks
// candidates by.
//
// The key is the part with judgement in it, so it is pinned here rather than
// inferred from a write's end-to-end behaviour: two names meet only when they
// share a word that names a THING, never one that names a KIND of thing. Get
// that wrong in either direction and the cost is invisible — a duplicate
// nobody sees, or an LLM call burned comparing two unrelated companies that
// happen to both be AI.

import type { Binding } from '../expression';
import type { UniquenessConstraints } from '../../translation_graph/uniqueness';
import {
  LOCAL_ADAPTER_TYPE,
  LOCAL_CANDIDATE_CAP,
  distinctiveTokens,
  identityValuesEqual,
  localEdgeAdapter,
  localRecordLock,
  sharesDistinctiveToken,
} from '../local_edge_adapter';
import { EffectLocks } from '../effect_locks';

const MUTATION_CONTEXT = { source: { adapterType: 'local' } } as never;

function landing(fields: Record<string, unknown>): Binding {
  return { kind: 'nodePosition', fields, fieldOrder: Object.keys(fields), fieldProvenance: {}, edges: {} };
}

function store(...initial: Binding[]) {
  const edge = { kind: 'landed' as const, landings: [...initial] };
  return { edge, store: localEdgeAdapter({ edge, edgeName: 'companies' }) };
}

const byName = (fuzzy: boolean): UniquenessConstraints => ({
  any: [{ all: [{ field: 'name', ...(fuzzy ? { fuzzy: true } : {}) }] }],
});

describe('the distinctive-token key', () => {
  it('drops the words that name a kind rather than a thing', () => {
    expect(distinctiveTokens('Acme Robotics GmbH')).toEqual(['acme']);
    expect(distinctiveTokens('Faction AI')).toEqual(['faction']);
  });

  it('two companies sharing only the kind word never meet', () => {
    expect(sharesDistinctiveToken('Actions AI', 'Faction AI')).toBe(false);
  });

  it('a name and its shortening do meet — the judge decides the rest', () => {
    expect(sharesDistinctiveToken('Faction AI', 'Faction')).toBe(true);
  });

  it('punctuation and case are not differences', () => {
    expect(sharesDistinctiveToken('Acme Robotics GmbH', 'acme robotics')).toBe(true);
    expect(sharesDistinctiveToken('Acme, Inc.', 'ACME')).toBe(true);
  });

  it('a name that is nothing but kind words falls back to exactness', () => {
    expect(sharesDistinctiveToken('AI Labs', 'AI Labs')).toBe(true);
    expect(sharesDistinctiveToken('AI Labs', 'Tech Group')).toBe(false);
  });

  it('an absent value identifies nothing', () => {
    expect(identityValuesEqual(undefined, undefined)).toBe(false);
    expect(identityValuesEqual('', 'x')).toBe(false);
    expect(sharesDistinctiveToken(undefined, 'Acme')).toBe(false);
  });

  it('a multi-valued field compares by its values', () => {
    expect(sharesDistinctiveToken(['Acme Robotics'], 'acme')).toBe(true);
  });

  describe('a bare domain fallback name', () => {
    // Prod incident: `name` falls back to a bare domain for several
    // unrelated companies, and punctuation stripping alone turns every one
    // of them into the shared, non-generic token "com".
    it('two different domains under the same TLD share no token', () => {
      expect(distinctiveTokens('oriqx.com')).toEqual(['oriqx']);
      expect(distinctiveTokens('pavoai.com')).toEqual(['pavoai']);
      expect(sharesDistinctiveToken('oriqx.com', 'pavoai.com')).toBe(false);
    });

    it('the same domain with a scheme, a `www.` subdomain and a path still matches', () => {
      expect(sharesDistinctiveToken('oriqx.com', 'https://www.oriqx.com/about')).toBe(true);
    });

    it('a multi-label TLD (`co.uk`) also drops only its final label', () => {
      expect(distinctiveTokens('foo.co.uk')).toEqual(['foo']);
      expect(sharesDistinctiveToken('foo.co.uk', 'bar.co.uk')).toBe(false);
    });
  });
});

describe('the store over an edge’s landings', () => {
  it('a create appends, and the landing keeps its place', async () => {
    const s = store(landing({ name: 'First' }));
    const created = await s.store.adapter.createRecord({
      recordType: 'companies',
      fields: { name: 'Second' },
      mutationContext: MUTATION_CONTEXT,
    });
    expect(created.adapterType).toBe(LOCAL_ADAPTER_TYPE);
    expect(created.externalId).toBe('1');
    expect(s.edge.landings).toHaveLength(2);
    expect(s.edge.landings[0]).toEqual(landing({ name: 'First' }));
  });

  it('an update merges into the matched landing in place', async () => {
    const first = landing({ name: 'Acme' });
    const s = store(first);
    await s.store.adapter.updateRecord({
      recordType: 'companies',
      externalId: '0',
      fields: { site: 'acme.test' },
      mutationContext: MUTATION_CONTEXT,
    });
    expect(first.kind === 'nodePosition' && first.fields).toEqual({
      name: 'Acme',
      site: 'acme.test',
    });
    expect(s.edge.landings).toHaveLength(1);
  });

  it('blocks exactly by an exact component, and loosely by a fuzzy one', async () => {
    const s = store(landing({ name: 'Faction AI' }), landing({ name: 'Actions AI' }));
    const exact = await s.store.adapter.resolveEntity({
      record: { name: 'faction ai' },
      recordType: 'companies',
      candidates: [],
      constraints: byName(false),
    });
    expect(exact.candidates.map((c) => c.externalId)).toEqual(['0']);

    const fuzzy = await s.store.adapter.resolveEntity({
      record: { name: 'Faction' },
      recordType: 'companies',
      candidates: [],
      constraints: byName(true),
    });
    expect(fuzzy.candidates.map((c) => c.externalId)).toEqual(['0']);
  });

  it('a landing the run did not synthesise is never a candidate', async () => {
    const foreign: Binding = {
      kind: 'shapePosition',
      shape: 'S',
      node: 'n',
      fields: { name: 'Acme' },
      fieldProvenance: {},
    };
    const s = store(foreign, landing({ name: 'Acme' }));
    const resolved = await s.store.adapter.resolveEntity({
      record: { name: 'Acme' },
      recordType: 'companies',
      candidates: [],
      constraints: byName(false),
    });
    expect(resolved.candidates.map((c) => c.externalId)).toEqual(['1']);
  });

  it('no constraints means no candidates — every write creates', async () => {
    const s = store(landing({ name: 'Acme' }));
    const resolved = await s.store.adapter.resolveEntity({
      record: { name: 'Acme' },
      recordType: 'companies',
      candidates: [],
      constraints: { any: [] },
    });
    expect(resolved.candidates).toEqual([]);
  });

  it('the block is capped, and the store says when it was', async () => {
    const many = Array.from({ length: LOCAL_CANDIDATE_CAP + 5 }, () => landing({ name: 'Acme' }));
    const s = store(...many);
    const resolved = await s.store.adapter.resolveEntity({
      record: { name: 'Acme' },
      recordType: 'companies',
      candidates: [],
      constraints: byName(false),
    });
    expect(resolved.candidates).toHaveLength(LOCAL_CANDIDATE_CAP);
    expect(s.store.capped()).toBe(true);
  });

  it('a block that fits under the cap is not reported as capped', async () => {
    const s = store(landing({ name: 'Acme' }));
    await s.store.adapter.resolveEntity({
      record: { name: 'Acme' },
      recordType: 'companies',
      candidates: [],
      constraints: byName(false),
    });
    expect(s.store.capped()).toBe(false);
  });
});

describe('the lock an update of a landing holds', () => {
  const node = () => ({ kind: 'nodePosition' as const, fields: {}, fieldOrder: [], fieldProvenance: {}, edges: {} });

  it('names the record by its identity: one node, one lock; two nodes, two', () => {
    const a = node();
    const b = node();
    expect(localRecordLock(a)).toEqual(localRecordLock(a));
    expect(localRecordLock(a).name).not.toBe(localRecordLock(b).name);
    expect(localRecordLock(a).mode).toEqual({ kind: 'exclusive' });
  });

  it('makes two updates of one record take turns, and lets two records go together', async () => {
    const locks = new EffectLocks();
    const a = node();
    const b = node();
    const log: string[] = [];
    const effect = (name: string) => async () => {
      log.push(`${name} start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      log.push(`${name} end`);
    };
    await Promise.all([
      locks.withLocks([localRecordLock(a)], effect('a1')),
      locks.withLocks([localRecordLock(a)], effect('a2')),
    ]);
    expect(log).toEqual(['a1 start', 'a1 end', 'a2 start', 'a2 end']);
    log.length = 0;
    await Promise.all([
      locks.withLocks([localRecordLock(a)], effect('a')),
      locks.withLocks([localRecordLock(b)], effect('b')),
    ]);
    expect(log.slice(0, 2)).toEqual(['a start', 'b start']);
  });
});
