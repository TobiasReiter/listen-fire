// The listen's RESOLVED ADDRESS — position path + config hops, names→ids.
//
// REAL: `resolveListenAddress` / `canonicalAddress` / `addressHops` over a
// faked `membersAt` (the walk's member source, two hops: bases then one
// base's tables). The fixture is deliberately NOT Airtable-shaped in its ids
// (a fixture matching one adapter's shape cannot tell derived from
// hardcoded).

import type { ListenConfigKey } from '../../adapter';

import {
  addressHops,
  canonicalAddress,
  positionConsumedHopKeys,
  resolveListenAddress,
  resolvedAddressOfJson,
} from '../listen_address';

const LISTEN_CONFIG: ListenConfigKey[] = [
  { key: 'shelf', required: true, narrows: { collection: 'Shelf', matchField: 'Id' } },
  { key: 'crate', required: true, narrows: { collection: 'Crate', matchField: 'Id' } },
];

// Two shelves; only shelf-1's crates are enumerable (the walk opens exactly
// the shelf that got pinned — a wrong pin must not fan out).
const membersAt = jest.fn(
  async (input: { steps: readonly unknown[]; recordType: string }) => {
    if (input.recordType === 'Shelf' && input.steps.length === 0) {
      return [
        { name: 'North Wall', data: { Name: 'North Wall', Id: 'shf_north' } },
        { name: 'South Wall', data: { Name: 'South Wall', Id: 'shf_south' } },
      ];
    }
    if (input.recordType === 'Crate' && input.steps.length === 1) {
      const filter = (input.steps[0] as { expressionFilter?: unknown }).expressionFilter;
      const pinned = JSON.stringify(filter ?? {});
      if (pinned.includes('shf_north')) {
        return [
          { name: 'Apples', data: { Name: 'Apples', Id: 'crt_apples' } },
          { name: 'Pears', data: { Name: 'Pears', Id: 'crt_pears' } },
        ];
      }
    }
    return [];
  },
);

beforeEach(() => membersAt.mockClear());

describe('addressHops', () => {
  it('yields only the narrows-declaring keys, in declaration order', () => {
    const hops = addressHops([
      { key: 'events' },
      ...LISTEN_CONFIG,
    ]);
    expect(hops.map((h) => h.key)).toEqual(['shelf', 'crate']);
  });

  it('is empty for adapters that declare no hops', () => {
    expect(addressHops([{ key: 'channels' }])).toEqual([]);
    expect(addressHops(undefined)).toEqual([]);
  });
});

describe('resolveListenAddress', () => {
  it('resolves a full config-named address (ids validated against the members)', async () => {
    const result = await resolveListenAddress({
      listenConfig: LISTEN_CONFIG,
      config: { shelf: 'shf_north', crate: 'crt_apples', events: ['thing.created'] },
      positionValues: {},
      membersAt,
    });
    expect(result).toEqual({ ok: true, address: { shelf: 'shf_north', crate: 'crt_apples' } });
  });

  it('lets the POSITION supply the leading hop, resolving its display name to the id', async () => {
    const result = await resolveListenAddress({
      listenConfig: LISTEN_CONFIG,
      config: { crate: 'crt_pears' },
      positionValues: { shelf: 'North Wall' },
      membersAt,
    });
    expect(result).toEqual({ ok: true, address: { shelf: 'shf_north', crate: 'crt_pears' } });
  });

  it('accepts an id spelling in the position arg too', async () => {
    const result = await resolveListenAddress({
      listenConfig: LISTEN_CONFIG,
      config: { crate: 'crt_apples' },
      positionValues: { shelf: 'shf_north' },
      membersAt,
    });
    expect(result).toEqual({ ok: true, address: { shelf: 'shf_north', crate: 'crt_apples' } });
  });

  it('fails when neither the listen nor the position names a hop', async () => {
    const result = await resolveListenAddress({
      listenConfig: LISTEN_CONFIG,
      config: { crate: 'crt_apples' },
      positionValues: {},
      membersAt,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("'shelf'");
  });

  it('fails on a config id the connection cannot see, naming the known ids', async () => {
    const result = await resolveListenAddress({
      listenConfig: LISTEN_CONFIG,
      config: { shelf: 'shf_typo', crate: 'crt_apples' },
      positionValues: {},
      membersAt,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('shf_typo');
      expect(result.reason).toContain('shf_north');
    }
  });

  it('fails on a position name the connection cannot see, naming the known labels', async () => {
    const result = await resolveListenAddress({
      listenConfig: LISTEN_CONFIG,
      config: { crate: 'crt_apples' },
      positionValues: { shelf: 'East Wall' },
      membersAt,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('East Wall');
      expect(result.reason).toContain('North Wall');
    }
  });

  it('fails when the listen and the position disagree about a hop', async () => {
    const result = await resolveListenAddress({
      listenConfig: LISTEN_CONFIG,
      config: { shelf: 'shf_south', crate: 'crt_apples' },
      positionValues: { shelf: 'North Wall' },
      membersAt,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('disagrees');
  });

  it('agreeing restatement (listen id == position name) resolves cleanly', async () => {
    const result = await resolveListenAddress({
      listenConfig: LISTEN_CONFIG,
      config: { shelf: 'shf_north', crate: 'crt_pears' },
      positionValues: { shelf: 'North Wall' },
      membersAt,
    });
    expect(result).toEqual({ ok: true, address: { shelf: 'shf_north', crate: 'crt_pears' } });
  });

  it('a wrong pin never opens the container it mis-names (no fanout to diagnose)', async () => {
    await resolveListenAddress({
      listenConfig: LISTEN_CONFIG,
      config: { shelf: 'shf_typo', crate: 'crt_apples' },
      positionValues: {},
      membersAt,
    });
    // One walk: the root's shelves. The crate hop is never taken for a shelf
    // nobody has.
    expect(membersAt).toHaveBeenCalledTimes(1);
  });

  it('an adapter with no hops resolves to the empty address', async () => {
    const result = await resolveListenAddress({
      listenConfig: [{ key: 'channels' }],
      config: { channels: ['general'] },
      positionValues: {},
      membersAt,
    });
    expect(result).toEqual({ ok: true, address: {} });
    expect(membersAt).not.toHaveBeenCalled();
  });
});

describe('positionConsumedHopKeys', () => {
  it('the position consumes the LEADING hops it pins, and stops at the first it does not', () => {
    expect(
      positionConsumedHopKeys({ listenConfig: LISTEN_CONFIG, positionValues: { shelf: 'North Wall' } }),
    ).toEqual(new Set(['shelf']));
    expect(
      positionConsumedHopKeys({ listenConfig: LISTEN_CONFIG, positionValues: {} }),
    ).toEqual(new Set());
    // A pinned crate with no shelf addresses nothing — nothing is consumed.
    expect(
      positionConsumedHopKeys({ listenConfig: LISTEN_CONFIG, positionValues: { crate: 'Apples' } }),
    ).toEqual(new Set());
  });
});

describe('canonicalAddress', () => {
  it('is key-sorted and stable across spellings of one address', () => {
    expect(canonicalAddress({ crate: 'crt_apples', shelf: 'shf_north' })).toBe(
      canonicalAddress({ shelf: 'shf_north', crate: 'crt_apples' }),
    );
    expect(canonicalAddress({ shelf: 'shf_north', crate: 'crt_apples' })).toBe(
      'crate=crt_apples&shelf=shf_north',
    );
  });
});

describe('resolvedAddressOfJson', () => {
  it('reads a jsonb object cell, tolerates a serialized string, rejects the rest', () => {
    expect(resolvedAddressOfJson({ shelf: 'shf_north' })).toEqual({ shelf: 'shf_north' });
    expect(resolvedAddressOfJson('{"shelf":"shf_north"}')).toEqual({ shelf: 'shf_north' });
    expect(resolvedAddressOfJson(null)).toBeUndefined();
    expect(resolvedAddressOfJson({})).toBeUndefined();
    expect(resolvedAddressOfJson({ shelf: 3 })).toBeUndefined();
    expect(resolvedAddressOfJson(['shelf'])).toBeUndefined();
  });
});
