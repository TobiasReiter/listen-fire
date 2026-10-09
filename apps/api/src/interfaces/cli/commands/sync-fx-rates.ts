import { setTimeout } from 'node:timers/promises';

import Bottleneck from 'bottleneck';
import { Command, command, metadata, option } from 'clime';
import * as db from '@prisma/client';
import { addDays, differenceInDays, endOfYesterday, format as formatDate, min } from 'date-fns';
import sortBy from 'lodash/sortBy';
import * as Sentry from '@sentry/node';

import type { HistoricalHistoryResult } from 'yahoo-finance2/esm/src/modules/historical';
import type { ChartResultArray } from 'yahoo-finance2/esm/src/modules/chart';


import { initSentry } from '../../../lib/sentry';
import { fetchDailyCurrency } from '../../../lib/datasources/yahoo_finance';
import { CurrencyAsset } from '../../../lib/datasources/currency';
import { runInContext } from '../../../services/context/utils';
import {
  fetchLatestExchangeRateAsOf,
  upsertExchangeRate,
} from '../../../lib/datasources/exchange_rate';
import { Context } from '../../../services/context';
import { UserOptions } from '../options';
import { prismaClient } from '../../../prisma';
import { notNull } from '../../../lib/utils/nullability';

const FALLBACK_FIRST_DATE = new Date('2000-01-03');

async function getFromDate(
  ctx: Context,
  {
    fromCurrency,
    toCurrency,
    fromDateCliOption,
    now,
  }: {
    fromCurrency: db.CurrencyIsoCode;
    toCurrency: db.CurrencyIsoCode;
    fromDateCliOption?: Date;
    now: Date;
  },
) {
  // We still want to fetch rates as of the time the cronjob is running although we want
  // to ultimately store EOD (End-Of-Day) rates. The idea is to pre-fetch today's rate, whatever
  // the time, so that the currency lookup is an exact match on today's date. Then tomorrow,
  // we'll refetch today's rate but this time EOD.
  const yesterday = endOfYesterday();

  const latestRate = await fetchLatestExchangeRateAsOf(
    { fromCurrency, toCurrency, date: now },
    ctx,
  );

  // CLI option wins over everything, then if we don't have rates for the fx pair use the fallback date
  // and ultimately pick the min of yesterday or the latest rate's date
  return fromDateCliOption
    ? new Date(fromDateCliOption)
    : latestRate === null
      ? FALLBACK_FIRST_DATE
      : min([latestRate.date, yesterday]);
}

async function main(ctx: Context, limiter: Bottleneck, options: CliOptions) {
  // give the ctx permissions only over foreign exchange tables

  const currencyAssetTable = new CurrencyAsset(ctx);
  await currencyAssetTable.ensureAllCurrencies();

  const orderedCurencies = Object.values(await currencyAssetTable.findAll())
    .sort((a, b) => (a.pairOrder > b.pairOrder ? 1 : -1))
    .map(({ isoCode }) => isoCode);

  const currencyPairs = orderedCurencies.reduce(
    (pairs, currency, index) => [
      ...pairs,
      ...orderedCurencies.slice(index + 1).map((otherCurrency) => ({
        fromCurrency: currency,
        toCurrency: otherCurrency,
      })),
    ],
    [] as { fromCurrency: db.CurrencyIsoCode; toCurrency: db.CurrencyIsoCode }[],
  );

  for (const currencyPair of currencyPairs) {
    const { fromCurrency, toCurrency } = currencyPair;
    await updateCurrencyPair(ctx, {
      fromCurrency,
      toCurrency,
      fromDateCliOption: options.fromDate,
    });
    await setTimeout(1000);
  }
}

function previousPointInterpolate(rates: HistoricalHistoryResult) {
  const sortedRates = sortBy(rates, 'date');
  return sortedRates.reduce<HistoricalHistoryResult>((acc, current) => {
    const previous = acc.length > 0 ? acc.slice(-1)[0] : sortedRates[0];
    const numDays = differenceInDays(current.date, previous.date);
    const offsets = Array.from({ length: numDays - 1 }, (_, i) => i + 1);
    const interpolated =
      numDays > 1
        ? offsets.map((offset) => ({
            ...previous,
            date: addDays(previous.date, offset),
            volume: 0,
          }))
        : [];
    return [...acc, ...interpolated, current];
  }, []);
}

const convertToHistoricalResult = (result: ChartResultArray): HistoricalHistoryResult => {
  return result.quotes
    .map((quote) => {
      if (
        quote.open !== null &&
        quote.high !== null &&
        quote.low !== null &&
        quote.close !== null
      ) {
        return {
          ...quote,
          open: quote.open,
          high: quote.high,
          low: quote.low,
          close: quote.close,
          volume: 0,
        };
      } else {
        return null;
      }
    })
    .filter(notNull);
};

async function updateCurrencyPair(
  ctx: Context,
  {
    fromCurrency,
    toCurrency,
    fromDateCliOption,
  }: {
    fromCurrency: db.CurrencyIsoCode;
    toCurrency: db.CurrencyIsoCode;
    fromDateCliOption?: Date;
  },
) {
  const now = new Date();
  const fromDate = await getFromDate(ctx, { fromCurrency, toCurrency, fromDateCliOption, now });
  if (fromDate > now) {
    return;
  }

  console.warn('Fetching data for:', {
    fromDate: formatDate(fromDate, 'yyyy-MM-dd'),
    toDate: formatDate(now, 'yyyy-MM-dd'),
    fromCurrency,
    toCurrency,
  });

  const fetchedData = await fetchDailyCurrency({
    fromDateStr: formatDate(fromDate, 'yyyy-MM-dd'),
    toDateStr: formatDate(now, 'yyyy-MM-dd'),
    fromCurrency,
    toCurrency,
  });

  const historicalData = convertToHistoricalResult(fetchedData);

  const interpolatedData = previousPointInterpolate(historicalData);

  // Run serially as too many connections at once with Promise.all
  // will hit Prisma's connection pool timeout. This runs in a cron job
  // so we don't need it to be performant
  // Also see why pool timeout triggers https://github.com/prisma/prisma/issues/13134
  for (const record of interpolatedData) {
    await upsertExchangeRate(ctx, {
      fromCurrency,
      toCurrency,
      date: record.date,
      rate: record.close,
    });
  }
}

class CliOptions extends UserOptions {
  @option({
    flag: 'f',
    description: 'force download from date, format: YYYY-MM-DDD',
  })
  fromDate?: Date;
}

@command({ description: 'Update Exchange Rate data with daily rates' })
export default class extends Command {
  @metadata
  async execute(options: CliOptions): Promise<void> {
    initSentry();
    const limiter = new Bottleneck({
      minTime: 333,
      maxConcurrent: 1,
    });

    try {
      await runInContext((ctx) => main(ctx, limiter, options), { email: options.email });
    } catch (err) {
      Sentry.captureException(err);
      throw err;
    } finally {
      await Sentry.close();
      await prismaClient.$disconnect();
    }
  }
}
