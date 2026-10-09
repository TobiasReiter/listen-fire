// The computed `valuations` edge: Legal Entity / Investment
// -[:valuations WHERE date == "…" AND currency == "…"]-> one Valuation node,
// via POST /valuations/compute. Covers the WHERE-input parser, the aggregation
// math, the empty-set-without-a-complete-filter rule, and the full getRelated
// round-trip with a mocked compute response.

// logger → services/context → casl crashes at module load; stub it (mirrors the
// sibling read test).
jest.mock('../../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
// Credentials load hits the DB + decrypt; stub the two seams so requireCreds
// resolves to a fake connection without a database.
jest.mock('../../../../lib/kysely', () => {
  const qb = () => ({
    selectFrom: () => ({
      where: () => ({
        select: () => ({
          executeTakeFirstOrThrow: async () => ({ id: 'cred-1', credentials: Buffer.from('x') }),
        }),
      }),
    }),
  });
  return { getQb: qb, getCoreQb: qb, getAutomationsQb: qb };
});
jest.mock('../../../../lib/credentials', () => ({
  decryptToken: async () => JSON.stringify({ apiKey: 'k', baseUrl: 'http://vals.test/api/v1' }),
}));

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { Expression } from '#shared/expression/types';

import {
  NATIVE_VALUATIONS_ADAPTER_TYPE,
  createNativeValuationsAdapter,
  parseValuationCriteria,
  aggregateComputeValuation,
} from '../native_valuations';
import { makeStablePosition } from '../../types';

const adapter = () =>
  createNativeValuationsAdapter({ teamId: 'team-1' as TeamId, credentialsId: 'cred-1' });

const legalEntity = (id = 'le-1') =>
  makeStablePosition({
    adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
    recordType: 'Legal Entity',
    recordId: id,
    data: { id, name: 'NewCo' },
  });

const eq = (prop: string, value: string): Expression => ({
  type: 'compare',
  op: 'eq',
  left: { type: 'property', propertyTypeId: prop },
  right: { type: 'static', value },
});
const and = (...ops: Expression[]): Expression => ({ type: 'logical', op: 'and', operands: ops });

const computeEntry = (invested: number, unrealized: number, realized: number, total: number) => ({
  invested: { valuation_date_value: invested },
  unrealized: { valuation_date_value: unrealized },
  realized: { valuation_date_value: realized },
  total: { valuation_date_value: total },
});

describe('parseValuationCriteria', () => {
  it('extracts date + currency from an AND of eq predicates (either operand order)', () => {
    expect(parseValuationCriteria(and(eq('date', '2026-06-30'), eq('currency', 'USD')))).toEqual({
      date: '2026-06-30',
      currency: 'USD',
    });
    // reversed operands (literal on the left)
    const reversed: Expression = and(
      { type: 'compare', op: 'eq', left: { type: 'static', value: 'EUR' }, right: { type: 'property', propertyTypeId: 'currency' } },
      eq('date', '2026-01-01'),
    );
    expect(parseValuationCriteria(reversed)).toEqual({ date: '2026-01-01', currency: 'EUR' });
  });

  it('returns null when the WHERE is absent or either input is missing', () => {
    expect(parseValuationCriteria(undefined)).toBeNull();
    expect(parseValuationCriteria(eq('date', '2026-06-30'))).toBeNull(); // no currency
    expect(parseValuationCriteria(eq('currency', 'USD'))).toBeNull(); // no date
    expect(parseValuationCriteria(and(eq('date', '2026-06-30'), eq('strategy', 'FIFO')))).toBeNull();
  });
});

describe('aggregateComputeValuation', () => {
  it('sums the as-of figures across investments and recomputes the ratios', () => {
    const agg = aggregateComputeValuation([
      computeEntry(100, 120, 30, 150),
      computeEntry(100, 60, 40, 100),
    ]);
    expect(agg).toEqual({
      invested: 200,
      unrealized: 180,
      realized: 70,
      total: 250,
      gain: 50,
      moic: 1.25,
      gain_pct: 0.25,
      irr: null,
    });
  });

  it('leaves ratios null when nothing was invested (empty result)', () => {
    const agg = aggregateComputeValuation([]);
    expect(agg).toMatchObject({ invested: 0, total: 0, gain: 0, moic: null, gain_pct: null });
  });
});

describe('NativeValuationsAdapter.listEntryPoints — the Valuation entry', () => {
  it('publishes Valuation as a CHILD type: readable:false, reached only via `valuations`', async () => {
    // The root cannot enumerate valuations — each is COMPUTED from a Legal
    // Entity / Investment as of a date + currency the hop's WHERE supplies —
    // so the entry must not claim a root collection (its meta read was
    // silently empty and its snapshot threw). The position derives from the
    // `valuations` edge's reachability; the entry stays published so the
    // name resolver and `describe` still know the type.
    const entries = await adapter().listEntryPoints();
    const valuation = entries.find((e) => e.typeId === 'Valuation');
    expect(valuation).toBeDefined();
    expect(valuation?.readable).toBe(false);
    expect(valuation?.writable).toBe(false);
  });
});

describe('NativeValuationsAdapter.getRelated — valuations edge', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the empty set when the hop WHERE lacks date or currency', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const noWhere = await adapter().getRelated({
      position: legalEntity(),
      fieldId: 'Valuations',
      direction: 'outgoing',
    });
    const dateOnly = await adapter().getRelated({
      position: legalEntity(),
      fieldId: 'Valuations',
      direction: 'outgoing',
      where: eq('date', '2026-06-30'),
    });
    expect(noWhere).toEqual([]);
    expect(dateOnly).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled(); // never hits compute without both inputs
  });

  it('computes one aggregated Valuation node when date + currency are present', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ data: [computeEntry(100, 120, 30, 150), computeEntry(100, 60, 40, 100)] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const results = await adapter().getRelated({
      position: legalEntity('le-42'),
      fieldId: 'Valuations',
      direction: 'outgoing',
      where: and(eq('date', '2026-06-30'), eq('currency', 'USD')),
    });

    // Legal Entity is valued as an investee → investment_profile_id selector.
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      investment_profile_id: 'le-42',
      as_of_date: '2026-06-30',
      target_currency: 'USD',
    });

    expect(results).toHaveLength(1);
    const pos = results[0].position;
    expect(pos.recordType).toBe('Valuation');
    // date + currency echoed onto the node so the engine's WHERE re-check keeps it.
    const data = (pos.identity as { kind: 'stable'; data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      date: '2026-06-30',
      currency: 'USD',
      invested: 200,
      total: 250,
      moic: 1.25,
    });
  });

  it('uses the investment_ids selector for an Investment source', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [computeEntry(50, 80, 0, 80)] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    await adapter().getRelated({
      position: makeStablePosition({
        adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
        recordType: 'Investment',
        recordId: 'inv-9',
        data: { id: 'inv-9' },
      }),
      fieldId: 'Valuations',
      direction: 'outgoing',
      where: and(eq('date', '2026-06-30'), eq('currency', 'USD')),
    });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ investment_ids: ['inv-9'], target_currency: 'USD' });
  });
});
