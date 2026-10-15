/**
 * Live proof of the mixed web chat loop: Anthropic's hosted search and OUR
 * page reader in ONE conversation.
 *
 * The risky part of the fallback is not either tool — it is that a hosted
 * server tool and a client tool travel in the same request, and that the loop
 * answers a `tool_use` stop and a `pause_turn` stop in the same conversation
 * without losing the answer. That is provable on the DIRECT route, because the
 * page reader is an explicit option rather than something the route decides —
 * so this needs no Google project to say whether the loop works.
 *
 *   npx ts-node --project tsconfig.dev.json --transpile-only \
 *     -r dotenv/config -r tsconfig-paths/register \
 *     src/scripts/dev/verify_web_fetch_own_mode.ts [subject]
 *
 * It spends real money: one Sonnet turn, one or two hosted searches, and one
 * or two Bright Data page reads. Run it once, read the output, stop.
 */
import './_profile_loader';
import { anthropicWebChat } from '../../lib/anthropic';
import { logger } from 'movement-engine/services/logger';
import { ScraperService } from '../../services/scraper';

import type { PageFetchResult } from '../../lib/anthropic';

/** A small, stable company site, named on the command line when a different
 *  one is wanted. The question needs a search AND a page read: the tagline is
 *  on the homepage, and nothing here says where the homepage is. */
const DEFAULT_SUBJECT = 'Bright Data';

async function fetchPage(url: string): Promise<PageFetchResult> {
  const startedMs = Date.now();
  try {
    const text = await ScraperService.getWebsite(url, { provider: 'brightdata' });
    console.log(`  fetched ${url} — ${text.length} chars in ${Date.now() - startedMs}ms`);
    return text.trim() ? { text } : { error: 'the page had no readable text' };
  } catch (error) {
    console.log(`  fetch FAILED ${url} — ${error instanceof Error ? error.message : error}`);
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const subject = process.argv.slice(2).join(' ').trim() || DEFAULT_SUBJECT;
  for (const name of ['ANTHROPIC_API_KEY', 'BRIGHT_DATA_ACCESS_TOKEN', 'BRIGHT_DATA_UNLOCKER_ZONE']) {
    if (!process.env[name]) {
      console.error(`${name} is not set — this proof needs it.`);
      process.exit(1);
    }
  }

  console.log(`Subject: ${subject}\nPage reader: own (our scraper), MODEL_MAP: ${process.env.MODEL_MAP || '(empty)'}\n`);
  const startedMs = Date.now();

  const reply = await anthropicWebChat({
    system:
      'You answer one factual question about a company using web search and the page reader. ' +
      'Search for the company site, then READ its homepage — do not answer from the search ' +
      'snippets alone. Quote the tagline exactly as the page words it.',
    userMessage: `What is the tagline on the homepage of ${subject}? Search for the site, then fetch the homepage and quote it.`,
    model: 'claude-sonnet-5',
    effort: 'low',
    maxSearches: 2,
    maxFetches: 2,
    pageReader: 'own',
    fetchPage,
    label: 'verify_web_fetch_own_mode',
  });

  console.log('\n── What happened ─────────────────────────────────────────');
  console.log(`stop reason : ${reply.stopReason}`);
  console.log(`turns       : ${reply.turns} (resumes: ${reply.resumes})`);
  console.log(`page reader : ${reply.pageReader}`);
  console.log('events      :');
  for (const event of reply.events) {
    switch (event.kind) {
      case 'search':
        console.log(`  search "${event.query ?? '?'}" → ${event.results.map((r) => r.url).join(', ')}`);
        break;
      case 'search_failed':
        console.log(`  search "${event.query ?? '?'}" FAILED: ${event.errorCode}`);
        break;
      case 'fetch':
        console.log(`  fetch ${event.url}`);
        break;
      case 'fetch_failed':
        console.log(`  fetch ${event.url ?? '?'} FAILED: ${event.errorCode}`);
        break;
    }
  }
  console.log(
    `usage       : in ${reply.usage.inputTokens}, out ${reply.usage.outputTokens}, ` +
      `cache read ${reply.usage.cacheReadTokens}, cache write ${reply.usage.cacheCreationTokens}, ` +
      `${reply.usage.searches} searches, ${reply.usage.fetches} pages`,
  );
  console.log(`wall clock  : ${Date.now() - startedMs}ms`);
  console.log(`\nanswer (first 300 chars):\n${reply.text.slice(0, 300)}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('[verify_web_fetch_own_mode] failed', { error });
    console.error(error);
    process.exit(1);
  });
