import * as db from '@prisma/client';
import YahooFinance from 'yahoo-finance2';
import { backOff } from 'exponential-backoff';

import type { ChartResultArray } from 'yahoo-finance2/esm/src/modules/chart';

import { SECOND } from '../../constants';
import { logger } from 'movement-engine/services/logger';
import { Queue } from '../utils/queue';

const yahooFinance = new YahooFinance();

const RETRY_LIMIT = 7;
const INITIAL_DELAY = 5 * SECOND;
const TIME_MULTIPLE = 3;
const RATE_LIMIT_DELAY = 5 * 60 * SECOND; // 5 minutes

const queue = new Queue<ChartResultArray>({
  concurrency: 1,
});

function getFromToCurrencySymbol(
  fromCurrency: db.CurrencyIsoCode,
  toCurrency: db.CurrencyIsoCode,
): string {
  /*
  Yahoo symbols for currency pairs all end with the `=X` suffix and combine the `from`
  currency ISO code with the `to` currency ISO code, e.g. GBPEUR=X. However, if it's a
  major pair, i.e. a USD conversion to another currency, then the symbol is simply the
  `to` currency and the suffix, e.g. for a USD to GBP conversion, the symbol is GBP=X.
  */
  const suffix = '=X';
  return (
    (fromCurrency === db.CurrencyIsoCode.USD ? toCurrency : `${fromCurrency}${toCurrency}`) + suffix
  );
}

async function fetchDailyCurrency({
  fromCurrency,
  toCurrency,
  fromDateStr,
  toDateStr,
}: {
  fromCurrency: db.CurrencyIsoCode;
  toCurrency: db.CurrencyIsoCode;
  fromDateStr: string;
  toDateStr: string;
}) {
  const symbol = getFromToCurrencySymbol(fromCurrency, toCurrency);

  return queue.enqueue(() =>
    backOff(() => yahooFinance.chart(symbol, { period1: fromDateStr, period2: toDateStr }), {
      jitter: 'full',
      numOfAttempts: RETRY_LIMIT,
      startingDelay: INITIAL_DELAY,
      timeMultiple: TIME_MULTIPLE,
      retry: async (e, attempt) => {
        const errorCode = e instanceof Error && 'code' in e ? (e as { code: number }).code : null;
        const isTooManyRequests =
          errorCode === 429 ||
          (e instanceof Error && (e.message.includes('429') || e.message.includes('Too Many')));

        if (isTooManyRequests) {
          logger.info(
            `[YAHOO_FINANCE] Rate limited, waiting ${RATE_LIMIT_DELAY / SECOND}s before retry`,
          );
          await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY));
        }

        if (attempt < RETRY_LIMIT) {
          const delay = (INITIAL_DELAY / SECOND) * TIME_MULTIPLE ** (attempt - 1);
          logger.info(
            `[YAHOO_FINANCE] Retrying in ~${delay}s (attempt ${attempt}/${RETRY_LIMIT})`,
            {
              error: e instanceof Error ? e.message : String(e),
              code: errorCode,
            },
          );
          return true;
        }

        return false;
      },
    }),
  );
}

export { fetchDailyCurrency };
