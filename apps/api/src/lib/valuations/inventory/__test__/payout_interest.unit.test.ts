// A payout to a fund holding several cheques in one company belongs to the
// cheques whose interest it was paid on. Shares are one kind of interest; an
// SPV interest and a fund-of-funds commitment are others, and a payout on them
// must reach them rather than fall into "other" and vanish from every cheque.

import { rollUpHoldings } from '..';
import {
  getAssetHolderIdsForInvestments,
  getAssetsAndTransactionsForInvestments,
  recursiveGetTransactionsForAssets,
} from '../data';
import { AssetId, AssetTransfer, getInvesteeEntityKey, getInvestingEntityKey } from '../types';
import { logger } from 'movement-engine/services/logger';

jest.mock('../data', () => ({
  getAssetHolderIdsForInvestments: jest.fn(),
  getAssetsAndTransactionsForInvestments: jest.fn(),
  recursiveGetTransactionsForAssets: jest.fn(),
}));

const FUND_ID = 'fund-1';
const COMPANY = { id: 'company-1', name: 'Company A' };
const SPV_ID = 'spv-1';
const VEHICLE_ID = 'vehicle-1';
const BUYER_ID = 'buyer-1';

type Transfer = AssetTransfer['transfers'][number];

const ASSETS: Record<string, { name: string; type: string; issuer: string }> = {
  shares: { name: 'A Shares', type: 'EQUITY', issuer: COMPANY.id },
  spvPoints: { name: 'SPV Interest (A)', type: 'SPV_INTEREST_POINT', issuer: SPV_ID },
  lpFirst: { name: 'LP Interest Point 1', type: 'LP_INTEREST_POINT', issuer: VEHICLE_ID },
  lpSecond: { name: 'LP Interest Point 2', type: 'LP_INTEREST_POINT', issuer: VEHICLE_ID },
  commitFirst: { name: 'Commitment 1', type: 'FUND_OUTSTANDING_COMMITMENT', issuer: VEHICLE_ID },
  commitSecond: { name: 'Commitment 2', type: 'FUND_OUTSTANDING_COMMITMENT', issuer: VEHICLE_ID },
  unitsFirst: { name: 'Units 1', type: 'EQUITY_UNKNOWN_SHARES', issuer: COMPANY.id },
  unitsSecond: { name: 'Units 2', type: 'EQUITY_UNKNOWN_SHARES', issuer: COMPANY.id },
  usd: { name: 'USD', type: 'CURRENCY', issuer: '' },
};

function transfer(
  asset: keyof typeof ASSETS,
  numAssets: number,
  type: 'inflow' | 'outflow',
  senderId: string | null = null,
): Transfer {
  const { name, type: assetType, issuer } = ASSETS[asset];
  return {
    assetId: `asset-${asset}` as AssetId,
    assetName: name,
    assetType,
    assetIssuerId: issuer || null,
    senderId: senderId ?? (type === 'outflow' ? FUND_ID : issuer || null),
    numAssets,
    type,
    investingEntityId: FUND_ID as Transfer['investingEntityId'],
    investingEntityName: 'Our Fund',
    investees: [{ ...COMPANY, isAlsoIssuerOfAsset: issuer === COMPANY.id }],
  };
}

function transaction(
  id: string,
  date: string,
  transfers: Transfer[],
  investmentId: string | null = null,
): AssetTransfer {
  return {
    transaction_id: id,
    investment_id: investmentId,
    convertedToId: null,
    due_to_rights_from_asset_id: null,
    close_date: new Date(date),
    event_id: null,
    transfers,
  };
}

/** Value `investmentIds` over `walk`; return the cash attributed to them on
 *  `payoutDate`. */
async function received(
  investmentIds: string[],
  walk: AssetTransfer[],
  payoutDate: string,
): Promise<number> {
  const seeds = new Map<string, { assetIds: string[]; transactionIds: string[] }>();
  for (const txn of walk) {
    if (!txn.investment_id) continue;
    seeds.set(txn.investment_id, {
      assetIds: txn.transfers
        .filter((t) => t.assetType !== 'CURRENCY' && t.type === 'inflow')
        .map((t) => t.assetId),
      transactionIds: [txn.transaction_id],
    });
  }

  jest.mocked(getAssetHolderIdsForInvestments).mockResolvedValue([FUND_ID]);
  jest.mocked(getAssetsAndTransactionsForInvestments).mockResolvedValue({
    assetIds: new Set(investmentIds.flatMap((id) => seeds.get(id)?.assetIds ?? [])),
    transactionIds: new Set(investmentIds.flatMap((id) => seeds.get(id)?.transactionIds ?? [])),
  });
  jest.mocked(recursiveGetTransactionsForAssets).mockResolvedValue(walk);

  const { holdings } = await rollUpHoldings({ investmentIds, asOfDate: new Date('2026-09-29') });

  const cash = holdings
    .get(
      getInvestingEntityKey({ investingEntityId: FUND_ID, investingEntityName: 'Our Fund' }),
      getInvesteeEntityKey({ investeeEntityId: COMPANY.id, investeeEntityName: COMPANY.name }),
    )
    .entries()
    .find(([assetKey]) => assetKey.startsWith('asset-usd:'))?.[1];

  const onDate = (cash?.data.fromInvestment ?? [])
    .filter((flow) => flow.numAssets > 0 && flow.date.getTime() === new Date(payoutDate).getTime())
    .reduce((sum, flow) => sum + flow.numAssets, 0);
  return Math.round(onDate * 100) / 100;
}

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
});
afterEach(() => warn.mockRestore());

describe('payout on an SPV interest held beside direct shares', () => {
  const DIRECT = 'investment-direct';
  const SPV = 'investment-spv';
  const PAYOUT = 9_000;
  const PAYOUT_DATE = '2025-09-02';

  const directCheque = transaction(
    'txn-direct',
    '2020-01-01',
    [transfer('usd', 20_000, 'outflow'), transfer('shares', 100, 'inflow')],
    DIRECT,
  );
  const spvCheque = transaction(
    'txn-spv',
    '2021-01-01',
    [transfer('usd', 1_000, 'outflow'), transfer('spvPoints', 1_000, 'inflow')],
    SPV,
  );
  const spvPayout = transaction('txn-spv-payout', PAYOUT_DATE, [
    transfer('usd', PAYOUT, 'inflow', SPV_ID),
  ]);
  const walk = [directCheque, spvCheque, spvPayout];

  it('(A1) gives the SPV payer’s payout wholly to the SPV cheque, whether valued together or one at a time', async () => {
    const direct = await received([DIRECT], walk, PAYOUT_DATE);
    const spv = await received([SPV], walk, PAYOUT_DATE);
    const together = await received([DIRECT, SPV], walk, PAYOUT_DATE);

    expect(direct).toBe(0);
    expect(spv).toBe(PAYOUT);
    expect(together).toBe(PAYOUT);
    expect(direct + spv).toBe(together);
  });

  it('(A2) an SPV-only cheque valued alone receives its payout, not 0', async () => {
    // The direct cheque's own walk never reaches the SPV's payout; the SPV
    // cheque's does, and finds the direct shares sitting beside it as "other".
    expect(await received([SPV], walk, PAYOUT_DATE)).toBe(PAYOUT);
  });

  it('still splits a payout the company itself makes by the shares held', async () => {
    const companyPayout = transaction('txn-company-payout', PAYOUT_DATE, [
      transfer('usd', PAYOUT, 'inflow', COMPANY.id),
    ]);
    const companyWalk = [directCheque, spvCheque, companyPayout];

    expect(await received([DIRECT], companyWalk, PAYOUT_DATE)).toBe(PAYOUT);
    expect(await received([SPV], companyWalk, PAYOUT_DATE)).toBe(0);
  });
});

describe('payout on fund-of-funds commitments', () => {
  const FIRST = 'investment-first-commitment';
  const SECOND = 'investment-second-commitment';
  const PAYOUT = 8;
  const PAYOUT_DATE = '2025-03-20';

  it('(B1) splits the payout by the amount each cheque committed', async () => {
    const walk = [
      transaction(
        'txn-first',
        '2022-04-11',
        [
          transfer('usd', 100_000, 'outflow'),
          transfer('commitFirst', 1, 'outflow'),
          transfer('lpFirst', 1, 'inflow'),
        ],
        FIRST,
      ),
      transaction(
        'txn-second',
        '2023-09-05',
        [
          transfer('usd', 300_000, 'outflow'),
          transfer('commitSecond', 1, 'outflow'),
          transfer('lpSecond', 1, 'inflow'),
        ],
        SECOND,
      ),
      transaction('txn-distribution', PAYOUT_DATE, [transfer('usd', PAYOUT, 'inflow', VEHICLE_ID)]),
    ];

    const first = await received([FIRST], walk, PAYOUT_DATE);
    const second = await received([SECOND], walk, PAYOUT_DATE);

    expect(first).toBe(2);
    expect(second).toBe(6);
    expect(first + second).toBe(await received([FIRST, SECOND], walk, PAYOUT_DATE));
    expect(warn).not.toHaveBeenCalled();
  });

  it('(B2) attributes a payout nothing held can explain by invested cost, with one warning', async () => {
    const LATE = 40;
    const LATE_DATE = '2026-06-01';
    // Both positions are sold for cash; a distribution arrives afterwards with
    // no interest left to weigh it by.
    const walk = [
      transaction(
        'txn-first',
        '2022-01-01',
        [transfer('usd', 100_000, 'outflow'), transfer('unitsFirst', 1, 'inflow')],
        FIRST,
      ),
      transaction(
        'txn-second',
        '2022-06-01',
        [transfer('usd', 300_000, 'outflow'), transfer('unitsSecond', 1, 'inflow')],
        SECOND,
      ),
      transaction('txn-first-sale', '2025-01-01', [
        transfer('unitsFirst', 1, 'outflow'),
        transfer('usd', 125_000, 'inflow', BUYER_ID),
      ]),
      transaction('txn-second-sale', '2025-01-02', [
        transfer('unitsSecond', 1, 'outflow'),
        transfer('usd', 375_000, 'inflow', BUYER_ID),
      ]),
      transaction('txn-late', LATE_DATE, [transfer('usd', LATE, 'inflow', COMPANY.id)]),
    ];

    const first = await received([FIRST], walk, LATE_DATE);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({
      investingEntityId: FUND_ID,
      investeeEntityId: COMPANY.id,
    });
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain(COMPANY.name);

    warn.mockClear();
    const second = await received([SECOND], walk, LATE_DATE);
    expect(warn).toHaveBeenCalledTimes(1);

    expect(first).toBe(10);
    expect(second).toBe(30);
    expect(first + second).toBe(LATE);
  });
});
