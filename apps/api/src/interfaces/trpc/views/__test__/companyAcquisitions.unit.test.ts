// The acquirer page's acquisitions list: each position a fund took in the
// acquirer, valued against what that fund paid for the company it gave up.
// Rows and engine figures are synthetic; the query side is covered by the
// acquisition-exclusion integration suite.

import type { AcquisitionRow, ValuationDeps } from '../portfolio/acquisitions';

import { valueAcquisitions } from '../portfolio/acquisitions';
import AssetType from '../../../../generated/kysely/valuations/AssetType';
import CurrencyIsoCode from '../../../../generated/kysely/valuations/CurrencyIsoCode';

const EXIT_DATE = new Date('2025-03-25T00:00:00.000Z');
const FX_DATE = new Date('2026-01-01T00:00:00.000Z');
const ACQUIRED = { id: 'acquired-co', name: 'Example Target Ltd', slug: 'example-target' };

function row(overrides: Partial<AcquisitionRow> & Pick<AcquisitionRow, 'fund'>): AcquisitionRow {
  return {
    investmentId: `consideration-${overrides.fund.id}`,
    acquiredCompany: ACQUIRED,
    date: EXIT_DATE,
    received: [],
    ...overrides,
  };
}

function deps(costs: Record<string, number | null>): jest.Mocked<ValuationDeps> {
  return {
    costOf: jest.fn(async ({ fundId }) => costs[fundId] ?? null),
    pricesFor: jest.fn(async (_assetIds: string[]) => ({
      'acquirer-shares': { price: 10, currency: CurrencyIsoCode.EUR, date: FX_DATE },
    })),
    // EUR→USD 1.1 on the valuation date, 1.2 on the day the cash arrived.
    rate: jest.fn(async ({ from, date }) => {
      if (from === CurrencyIsoCode.USD) return 1;
      return date.getTime() === FX_DATE.getTime() ? 1.1 : 1.2;
    }),
  };
}

const shares = (quantity: number) => ({
  assetId: 'acquirer-shares',
  assetName: 'Ordinary Shares',
  assetType: AssetType.EQUITY,
  quantity,
  currency: null,
  date: EXIT_DATE,
});

describe('valueAcquisitions', () => {
  it('values one acquisition received by two funds, each against its own cost', async () => {
    const d = deps({ 'fund-a': 5000, 'fund-b': 2000 });
    const result = await valueAcquisitions(
      [
        row({ fund: { id: 'fund-a', name: 'Example Fund I' }, received: [shares(1000)] }),
        row({
          fund: { id: 'fund-b', name: 'Example Fund II' },
          received: [
            shares(100),
            {
              assetId: 'eur-cash',
              assetName: 'EUR',
              assetType: AssetType.CURRENCY,
              quantity: 500,
              currency: CurrencyIsoCode.EUR,
              date: EXIT_DATE,
            },
          ],
        }),
      ],
      { currency: CurrencyIsoCode.USD, fxDate: FX_DATE, deps: d },
    );

    expect(result).toHaveLength(2);
    const [a, b] = result;

    expect(a.fund).toEqual({ id: 'fund-a', name: 'Example Fund I' });
    expect(a.acquiredCompany).toEqual(ACQUIRED);
    expect(a.date).toBe(EXIT_DATE.toISOString());
    expect(a.sharesReceived).toEqual([
      { assetId: 'acquirer-shares', assetName: 'Ordinary Shares', quantity: 1000 },
    ]);
    expect(a.acquiredCompanyCost).toBe(5000);
    expect(a.valueNow).toBeCloseTo(1000 * 10 * 1.1, 6);
    expect(a.cashReceived).toBeNull();
    expect(a.multiple).toBeCloseTo(11000 / 5000, 6);
    expect(a.currency).toBe(CurrencyIsoCode.USD);

    // Shares float at the valuation date's rate; the cash keeps its own day's.
    expect(b.acquiredCompanyCost).toBe(2000);
    expect(b.valueNow).toBeCloseTo(100 * 10 * 1.1, 6);
    expect(b.cashReceived).toBeCloseTo(500 * 1.2, 6);
    expect(b.sharesReceived).toHaveLength(1);
    expect(b.multiple).toBeCloseTo((1100 + 600) / 2000, 6);

    expect(d.costOf.mock.calls.map(([args]) => args)).toEqual([
      { acquiredCompanyId: ACQUIRED.id, fundId: 'fund-a' },
      { acquiredCompanyId: ACQUIRED.id, fundId: 'fund-b' },
    ]);
  });

  it('leaves value and multiple empty when the shares have no price', async () => {
    const d = deps({ 'fund-a': 5000 });
    d.pricesFor.mockResolvedValue({});
    const [a] = await valueAcquisitions(
      [row({ fund: { id: 'fund-a', name: 'Example Fund I' }, received: [shares(1000)] })],
      { currency: CurrencyIsoCode.USD, fxDate: FX_DATE, deps: d },
    );

    expect(a.valueNow).toBeNull();
    expect(a.multiple).toBeNull();
    expect(a.acquiredCompanyCost).toBe(5000);
  });

  it('returns nothing, and asks the engine nothing, for a company with no acquisitions', async () => {
    const d = deps({});
    await expect(
      valueAcquisitions([], { currency: CurrencyIsoCode.USD, fxDate: FX_DATE, deps: d }),
    ).resolves.toEqual([]);
    expect(d.costOf).not.toHaveBeenCalled();
    expect(d.pricesFor).not.toHaveBeenCalled();
  });
});
