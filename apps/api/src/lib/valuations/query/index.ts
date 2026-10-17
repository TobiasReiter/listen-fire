import { z } from 'zod';

import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';
import { neverAsAny } from 'movement-engine/public/types';
import { getLotsForInvestments, Lot } from '../inventory';
import { getExchangeRate, getLatestPrices } from '../valuation/data';
import {
  getAssetExposureEntities,
  getCurrencyIsoCodes,
  getInvestmentsForQuery,
  QueriedInvestment,
} from './data';

/**
 * The valuation query API: filter and group the roll-up's leaf lots.
 *
 * Every portfolio metric is a slice of one set of atoms — invested is cash
 * paid, full realised is cash received, direct retained is degree-0 held
 * value — so this surface takes the filters and the group-by rather than
 * shipping a fixed set of columns.
 *
 * Tense is fixed here, never configurable: cash is a fact, converted at the
 * rate on the day it moved, and never moves again; held positions are always
 * live, marked at the analysis date's price and the analysis date's rate. That
 * is why there is no `fxDate` on this surface — `asOfDate` is the analysis
 * date, and facts don't have one.
 *
 * An investment filter admits everything the roll-up attributed TO those
 * investments: `source: 'OTHER'` lots — flows the walk decided belong to some
 * other investment sharing the same holdings — are not part of any answer here.
 * Each investment is therefore walked on its own, so its attribution is its
 * own.
 */

const groupDimensions = [
  'company',
  'investment',
  'investingEntity',
  'round',
  'degree',
  'asset',
  'trackedEntity',
] as const;

type GroupDimension = (typeof groupDimensions)[number];

/** Dates arrive over the wire as ISO strings and in-process as `Date`s; the
 *  engine only ever deals in `Date`.
 *
 *  The declared type is the WIRE type — a string — because this schema is also
 *  published as JSON Schema (the MCP `queryValuations` tool reads the shape off
 *  this procedure), and a `z.date()` branch has no JSON Schema spelling: it
 *  makes the whole tool list unserialisable. An in-process `Date` is narrowed
 *  to its ISO string before validation instead, so both callers still work. */
const queryDate = z
  .preprocess((value) => (value instanceof Date ? value.toISOString() : value), z.string())
  .transform((value) => new Date(value))
  .refine((date) => !Number.isNaN(date.getTime()), { message: 'Invalid date' });

const valuationQueryInput = z.object({
  investments: z
    .object({
      ids: z.array(z.string()).optional(),
      investedFrom: queryDate.optional(),
      investedTo: queryDate.optional(),
      roundId: z.string().optional(),
      investingEntityIds: z.array(z.string()).optional(),
      investeeEntityIds: z.array(z.string()).optional(),
    })
    .optional(),
  degree: z
    .union([
      z.object({ eq: z.number().int().min(0) }),
      z.object({
        min: z.number().int().min(0).optional(),
        max: z.number().int().min(0).optional(),
      }),
    ])
    .optional(),
  leafType: z.enum(['cash', 'held']).optional(),
  cashSign: z.enum(['paid', 'received']).optional(),
  factWindow: z
    .object({ from: queryDate.optional(), to: queryDate.optional() })
    .optional(),
  asOfDate: queryDate.optional(),
  groupBy: z.array(z.enum(groupDimensions)).optional(),
  currency: z.nativeEnum(CurrencyIsoCode),
  strategy: z.enum(['FIFO', 'LIFO']).optional(),
});

type ValuationQueryInput = z.infer<typeof valuationQueryInput>;

interface GroupKeyEntity {
  id: string | null;
  name: string | null;
}

interface ValuationGroupKey {
  company?: GroupKeyEntity;
  investment?: GroupKeyEntity;
  investingEntity?: GroupKeyEntity;
  round?: GroupKeyEntity;
  degree?: number;
  asset?: { id: string; name: string; type: string };
  /** Null on cash lots: a fact has no live exposure. */
  trackedEntity?: GroupKeyEntity | null;
}

interface ValuationQueryRow {
  groupKey: ValuationGroupKey;
  /** Σ cash out, each lot at the rate on the day it moved. Positive. */
  cashPaid: number;
  /** Σ cash in, each lot at the rate on the day it moved. */
  cashReceived: number;
  /** Σ held positions at the latest price on or before the analysis date,
   *  converted at that date's rate. */
  heldValue: number;
  lotCount: number;
}

interface ValuationQueryResult {
  currency: CurrencyIsoCode;
  asOfDate: Date;
  rows: ValuationQueryRow[];
  /** Assets we could not value. A missing price is reported, never counted as
   *  zero — an unpriced holding is an unknown, not an empty one. */
  warnings: string[];
}

/** One lot with the investment it was attributed to, and the asset facts the
 *  lot key encodes. */
interface QueriedLot {
  lot: Lot;
  investment: QueriedInvestment;
  assetId: string;
  assetName: string;
  assetType: string;
}

async function queryValuations(input: ValuationQueryInput): Promise<ValuationQueryResult> {
  const asOfDate = input.asOfDate ?? new Date();
  const strategy = input.strategy ?? 'FIFO';
  const warnings: string[] = [];

  const investments = await getInvestmentsForQuery(input.investments ?? {});

  // Walked one investment at a time: attribution is per-investment, and a lot
  // carries no investment of its own. Batched so a large portfolio doesn't open
  // a walk per investment all at once.
  const walked = await inBatches(investments, 8, async (investment) => ({
    investment,
    lots: await getLotsForInvestments({
      investmentIds: [investment.id],
      asOfDate,
      strategy,
    }),
  }));

  const selected: QueriedLot[] = [];
  for (const { investment, lots } of walked) {
    for (const lot of lots) {
      if (lot.source !== 'INVESTMENT') continue;
      const [assetId, assetName, assetType] = lot.assetKey.split(':');
      const queried = { lot, investment, assetId, assetName, assetType };
      if (admits(input, queried)) selected.push(queried);
    }
  }

  const cashAssetIds = uniqueAssetIds(selected.filter(({ lot }) => lot.tense === 'fact'));
  const heldAssetIds = uniqueAssetIds(selected.filter(({ lot }) => lot.tense === 'live'));

  const [currencyCodes, prices, exposureEntities] = await Promise.all([
    getCurrencyIsoCodes(cashAssetIds),
    getLatestPrices({ assetIds: heldAssetIds, date: asOfDate }),
    input.groupBy?.includes('trackedEntity')
      ? getAssetExposureEntities(heldAssetIds)
      : Promise.resolve(new Map<string, GroupKeyEntity>()),
  ]);

  const rate = exchangeRates(input.currency);
  const rows = new Map<string, ValuationQueryRow>();
  const warned = new Set<string>();
  const warn = (message: string) => {
    if (warned.has(message)) return;
    warned.add(message);
    warnings.push(message);
  };

  for (const queried of selected) {
    const { lot, assetId, assetName, assetType } = queried;
    const groupKey = buildGroupKey({
      queried,
      dimensions: input.groupBy ?? [],
      exposureEntities,
    });
    const row = upsertRow(rows, groupKey);
    row.lotCount += 1;

    if (lot.tense === 'fact') {
      const isoCode = currencyCodes.get(assetId);
      if (!isoCode) {
        warn(`No currency found for cash asset ${assetName} (${assetId})`);
        continue;
      }
      const value = lot.numAssets * (await rate(isoCode, lot.date));
      if (value < 0) row.cashPaid += -value;
      else row.cashReceived += value;
      continue;
    }

    const price = prices[assetId];
    if (!price) {
      warn(`No price found for ${assetName} (${assetId}) on or before ${asOfDate.toISOString()}`);
      continue;
    }
    // A fund commitment is a liability recorded positive; it counts against the
    // value we hold, exactly as the unrealised valuation treats it.
    const modifier = assetType === 'FUND_OUTSTANDING_COMMITMENT' ? -1 : 1;
    row.heldValue +=
      lot.numAssets * price.price * modifier * (await rate(price.currency, asOfDate));
  }

  return {
    currency: input.currency,
    asOfDate,
    rows: Array.from(rows.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, row]) => row),
    warnings,
  };
}

function admits(input: ValuationQueryInput, { lot }: QueriedLot): boolean {
  if (input.leafType === 'cash' && lot.tense !== 'fact') return false;
  if (input.leafType === 'held' && lot.tense !== 'live') return false;

  if (input.degree) {
    if ('eq' in input.degree) {
      if (lot.degree !== input.degree.eq) return false;
    } else {
      if (input.degree.min !== undefined && lot.degree < input.degree.min) return false;
      if (input.degree.max !== undefined && lot.degree > input.degree.max) return false;
    }
  }

  // Cash-only filters. A held lot is not paid or received, and carries no fact
  // date to window on, so neither narrows it.
  if (lot.tense === 'fact') {
    if (input.cashSign === 'paid' && lot.numAssets >= 0) return false;
    if (input.cashSign === 'received' && lot.numAssets <= 0) return false;
    if (input.factWindow?.from && lot.date < input.factWindow.from) return false;
    if (input.factWindow?.to && lot.date > input.factWindow.to) return false;
  }

  return true;
}

function buildGroupKey({
  queried,
  dimensions,
  exposureEntities,
}: {
  queried: QueriedLot;
  dimensions: readonly GroupDimension[];
  exposureEntities: Map<string, GroupKeyEntity>;
}): ValuationGroupKey {
  const { lot, investment, assetId, assetName, assetType } = queried;
  const groupKey: ValuationGroupKey = {};

  for (const dimension of dimensions) {
    if (dimension === 'company') {
      const [id, name] = splitEntityKey(lot.investeeEntityKey);
      groupKey.company = { id, name };
    } else if (dimension === 'investment') {
      groupKey.investment = { id: investment.id, name: null };
    } else if (dimension === 'investingEntity') {
      const [id, name] = splitEntityKey(lot.investingEntityKey);
      groupKey.investingEntity = { id, name };
    } else if (dimension === 'round') {
      groupKey.round = { id: investment.roundId, name: investment.roundName };
    } else if (dimension === 'degree') {
      groupKey.degree = lot.degree;
    } else if (dimension === 'asset') {
      groupKey.asset = { id: assetId, name: assetName, type: assetType };
    } else if (dimension === 'trackedEntity') {
      groupKey.trackedEntity = lot.tense === 'live' ? (exposureEntities.get(assetId) ?? null) : null;
    } else {
      throw new Error(`Unknown group dimension: ${neverAsAny(dimension)}`);
    }
  }

  return groupKey;
}

function splitEntityKey(key: string): [string, string] {
  const separator = key.indexOf(':');
  return [key.slice(0, separator), key.slice(separator + 1)];
}

function upsertRow(rows: Map<string, ValuationQueryRow>, groupKey: ValuationGroupKey) {
  // The key object is built in the caller's dimension order, so its JSON is a
  // stable identity for the group.
  const identity = JSON.stringify(groupKey);
  const existing = rows.get(identity);
  if (existing) return existing;

  const row: ValuationQueryRow = {
    groupKey,
    cashPaid: 0,
    cashReceived: 0,
    heldValue: 0,
    lotCount: 0,
  };
  rows.set(identity, row);
  return row;
}

function uniqueAssetIds(lots: QueriedLot[]): string[] {
  return Array.from(new Set(lots.map(({ assetId }) => assetId)));
}

function exchangeRates(targetCurrency: CurrencyIsoCode) {
  const cache = new Map<string, Promise<number>>();
  return (fromCurrency: CurrencyIsoCode, date: Date): Promise<number> => {
    const key = `${fromCurrency}:${date.toISOString()}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const rate = getExchangeRate({ fromCurrency, toCurrency: targetCurrency, date });
    cache.set(key, rate);
    return rate;
  };
}

async function inBatches<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += size) {
    results.push(...(await Promise.all(items.slice(index, index + size).map(fn))));
  }
  return results;
}

export {
  queryValuations,
  valuationQueryInput,
  ValuationGroupKey,
  ValuationQueryInput,
  ValuationQueryResult,
  ValuationQueryRow,
};
