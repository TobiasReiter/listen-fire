// The holdings projection's own arithmetic: `withHoldingsLens`, exercised
// directly on hand-built rows rather than through a tRPC procedure.
//
// It is what every surface that holds an opinion runs, and the default the
// API hands a caller who states none — a line means "what I hold in this
// company, due to this investment". So what is pinned here is the row
// contract that follows: value that arrived as shares
// in an acquirer sits on the acquirer's line, the company that was sold keeps
// only what still tracks it and reads as a position paid out, and the minted
// line states no invested figure and no MOIC because we never bought it.
//
// The one thing that varies is the merge rule, and it follows the AGGREGATION,
// not the projection: per company, several sales to one acquirer are a single
// holding in it; per investment, each source investment keeps a line of its
// own, because the question being asked is what THAT investment is worth now.
//
// Which companies are reported at all (the acquisition-consideration
// exclusion) lives in getBaseQuery and is covered by
// investmentsAcquisitionExclusion.

import type { AcquirerRef, LensRow } from '../portfolioLens';

import { applyPortfolioLens, withHoldingsLens } from '../portfolioLens';

interface Row extends LensRow {
  id: string;
}

function row(overrides: Partial<Row> & Pick<Row, 'id' | 'name'>): Row {
  return {
    acquired_by_legal_entity_id: null,
    acquirer: { id: null, name: null, slug: null, image_url: null },
    totalInvested: null,
    moic: null,
    retainedAll: 0,
    retainedInCompany: 0,
    totalValue: 0,
    holdsRetainedAssets: false,
    holdsTrackingAssets: false,
    carriesSwapValue: false,
    legal_entity_id: overrides.id,
    ...overrides,
  };
}

// What every surface passes as `deriveAcquirerRow`: a fresh line for the
// acquirer, carrying nothing from the row it was derived out of but its
// identity — no invested figure, no MOIC, no value until the projection puts
// the swapped holding on it.
function deriveAcquirerRow(_source: Row, acquirer: AcquirerRef): Row {
  return row({
    id: acquirer.id,
    name: acquirer.name,
    acquirer: { id: null, name: null, slug: null, image_url: null },
  });
}

function totalValueSum(rows: Row[]): number {
  return rows.reduce((sum, r) => sum + r.totalValue, 0);
}

/** $50k in; the whole position sold for shares in Company B worth $30k. */
function soldForShares(overrides: Partial<Row> = {}): Row {
  return row({
    id: 'a',
    name: 'Company A',
    acquired_by_legal_entity_id: 'b',
    acquirer: { id: 'b', name: 'Company B', slug: null, image_url: null },
    totalInvested: 50000,
    moic: 0.6,
    retainedAll: 30000,
    retainedInCompany: 0,
    totalValue: 30000,
    holdsRetainedAssets: true,
    holdsTrackingAssets: false,
    ...overrides,
  });
}

describe('withHoldingsLens — rows nothing has moved off', () => {
  it('leaves a row with no acquirer untouched', () => {
    const rows = [
      row({ id: 'a', name: 'Company A', retainedAll: 100, totalValue: 100, moic: 2, totalInvested: 50 }),
    ];

    const result = withHoldingsLens({ rows, mergeByCompany: false, deriveAcquirerRow });

    expect(result).toEqual(rows);
  });

  it('leaves a row untouched when nothing moved (retainedAll === retainedInCompany)', () => {
    const rows = [
      row({
        id: 'a',
        name: 'Company A',
        acquired_by_legal_entity_id: 'b',
        acquirer: { id: 'b', name: 'Company B', slug: null, image_url: null },
        totalInvested: 50,
        moic: 2,
        retainedAll: 100,
        retainedInCompany: 100,
        totalValue: 100,
      }),
    ];

    const result = withHoldingsLens({ rows, mergeByCompany: false, deriveAcquirerRow });

    expect(result).toEqual(rows);
  });
});

describe('withHoldingsLens — the two lines a share-for-share sale leaves', () => {
  it('empties the sold company and mints the acquirer a line for the shares', () => {
    const rows = [soldForShares()];
    // The projection mutates rows in place, so the pre-projection total has to
    // be captured before the call — after, `rows` and `result` share objects.
    const totalBefore = totalValueSum(rows);

    const result = withHoldingsLens({ rows, mergeByCompany: true, deriveAcquirerRow });

    expect(result).toHaveLength(2);
    const [sold, acquirer] = result;

    // Company A: the money we put in, nothing still held, and — since no cash
    // came back — nothing returned on it.
    expect(sold.id).toBe('a');
    expect(sold.totalInvested).toBe(50000);
    expect(sold.retainedAll).toBeCloseTo(0, 6);
    expect(sold.totalValue).toBeCloseTo(0, 6);
    expect(sold.moic).toBe(0);
    // Nothing tracks Company A any more, so there is nothing left to come.
    expect(sold.holdsRetainedAssets).toBe(false);

    // Company B: the holding, and blanks wherever the column is about money we
    // put in — we never bought this company.
    expect(acquirer.id).toBe('b');
    expect(acquirer.name).toBe('Company B');
    expect(acquirer.retainedAll).toBeCloseTo(30000, 6);
    expect(acquirer.retainedInCompany).toBeCloseTo(30000, 6);
    expect(acquirer.totalValue).toBeCloseTo(30000, 6);
    expect(acquirer.totalInvested).toBeNull();
    expect(acquirer.moic).toBeNull();
    expect(acquirer.carriesSwapValue).toBe(true);
    expect(acquirer.holdsRetainedAssets).toBe(true);

    expect(totalValueSum(result)).toBeCloseTo(totalBefore, 6);
  });

  it('measures the sold company on the cash it actually returned', () => {
    // The same deal with $9k of cash alongside the shares.
    const rows = [soldForShares({ totalValue: 39000 })];

    const [sold] = withHoldingsLens({ rows, mergeByCompany: true, deriveAcquirerRow });

    expect(sold.totalValue).toBeCloseTo(9000, 6);
    expect(sold.moic).toBeCloseTo(9000 / 50000, 6);
  });

  it('keeps a partly-sold company on its own line for what still tracks it', () => {
    const rows = [soldForShares({ retainedAll: 30000, retainedInCompany: 12000, holdsTrackingAssets: true })];

    const [sold, acquirer] = withHoldingsLens({ rows, mergeByCompany: true, deriveAcquirerRow });

    expect(sold.retainedAll).toBeCloseTo(12000, 6);
    expect(sold.holdsRetainedAssets).toBe(true);
    expect(acquirer.retainedAll).toBeCloseTo(18000, 6);
  });
});

describe('withHoldingsLens — merging follows the aggregation', () => {
  it('per company: merges the shares into the acquirer line we already had', () => {
    const companyA = soldForShares();
    // We also put $10k into Company B directly, and it has doubled.
    const companyB = row({
      id: 'b',
      name: 'Company B',
      totalInvested: 10000,
      moic: 2,
      retainedAll: 20000,
      retainedInCompany: 20000,
      totalValue: 20000,
      holdsRetainedAssets: true,
      holdsTrackingAssets: true,
    });
    const rows = [companyA, companyB];
    const totalBefore = totalValueSum(rows);
    const deriveSpy = jest.fn(deriveAcquirerRow);

    const result = withHoldingsLens({
      rows,
      mergeByCompany: true,
      deriveAcquirerRow: deriveSpy,
    });

    // No new line minted: the shares join the line we already had.
    expect(result).toHaveLength(2);
    expect(deriveSpy).not.toHaveBeenCalled();

    const acquirer = result.find((r) => r.id === 'b');
    if (!acquirer) throw new Error('expected the acquirer line to survive');
    expect(acquirer.retainedAll).toBeCloseTo(50000, 6);
    expect(acquirer.totalValue).toBeCloseTo(50000, 6);
    // The money we put into Company B is still the money we put into it...
    expect(acquirer.totalInvested).toBe(10000);
    // ...but half this line's value arrived as someone else's proceeds, so a
    // ratio against that money would flatter it into meaninglessness.
    expect(acquirer.moic).toBeNull();

    expect(totalValueSum(result)).toBeCloseTo(totalBefore, 6);
  });

  it('per company: several sales to the same acquirer are one holding in it', () => {
    const companyA = soldForShares({ id: 'a', name: 'Company A', retainedAll: 10000, totalValue: 10000 });
    const companyC = soldForShares({ id: 'c', name: 'Company C', retainedAll: 20000, totalValue: 20000 });
    const rows = [companyA, companyC];
    const totalBefore = totalValueSum(rows);

    const result = withHoldingsLens({ rows, mergeByCompany: true, deriveAcquirerRow });

    const acquirerLines = result.filter((r) => r.id === 'b');
    expect(acquirerLines).toHaveLength(1);
    expect(acquirerLines[0].retainedAll).toBeCloseTo(30000, 6);
    expect(result).toHaveLength(3);

    expect(result.find((r) => r.id === 'a')?.retainedAll).toBeCloseTo(0, 6);
    expect(result.find((r) => r.id === 'c')?.retainedAll).toBeCloseTo(0, 6);
    expect(totalValueSum(result)).toBeCloseTo(totalBefore, 6);
  });

  it('per investment: each source investment mints an acquirer line of its own', () => {
    // Two investments into the same company, both sold in the same deal — the
    // per-investment list is asking what each one turned into, so collapsing
    // them onto one line would lose the answer.
    const first = soldForShares({ id: 'a', name: 'Company A', retainedAll: 10000, totalValue: 10000 });
    const second = soldForShares({ id: 'a', name: 'Company A', retainedAll: 20000, totalValue: 20000 });
    const rows = [first, second];
    const totalBefore = totalValueSum(rows);

    const result = withHoldingsLens({ rows, mergeByCompany: false, deriveAcquirerRow });

    const acquirerLines = result.filter((r) => r.id === 'b');
    expect(acquirerLines).toHaveLength(2);
    expect(acquirerLines.map((line) => line.retainedAll).sort((x, y) => x - y)).toEqual([
      10000, 20000,
    ]);
    expect(result).toHaveLength(4);

    expect(totalValueSum(result)).toBeCloseTo(totalBefore, 6);
  });
});

// The lens is a lever on the API: the surfaces that hold an opinion just never
// offer it. Which makes the identity case worth pinning — asking for
// `investment` must hand back exactly the rows that went in, untouched.
describe('applyPortfolioLens — the choice between the two answers', () => {
  it('investment: hands the rows back untouched, with no acquirer line minted', () => {
    const rows = [soldForShares()];
    const totalBefore = totalValueSum(rows);

    const result = applyPortfolioLens({
      lens: 'investment',
      rows,
      mergeByCompany: true,
      deriveAcquirerRow,
    });

    expect(result).toEqual(rows);
    expect(result.map((r) => r.id)).toEqual(['a']);
    // Everything the holdings projection would have moved is still here.
    expect(result[0].retainedAll).toBe(30000);
    expect(result[0].retainedInCompany).toBe(0);
    expect(result[0].moic).toBe(0.6);
    expect(totalValueSum(result)).toBeCloseTo(totalBefore, 6);
  });

  it('holdings: is the projection, and the totals match the investment lens', () => {
    const investmentRows = [soldForShares()];
    const holdingsRows = [soldForShares()];

    const asInvestments = applyPortfolioLens({
      lens: 'investment',
      rows: investmentRows,
      mergeByCompany: true,
      deriveAcquirerRow,
    });
    const asHoldings = applyPortfolioLens({
      lens: 'holdings',
      rows: holdingsRows,
      mergeByCompany: true,
      deriveAcquirerRow,
    });

    expect(asHoldings.map((r) => r.id)).toEqual(['a', 'b']);
    expect(asHoldings.find((r) => r.id === 'b')?.retainedAll).toBe(30000);
    expect(totalValueSum(asHoldings)).toBeCloseTo(totalValueSum(asInvestments), 6);
  });
});
