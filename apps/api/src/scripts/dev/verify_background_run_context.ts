/**
 * A scheduled movement fetches pages. Live proof that it does.
 *
 * The bug this pins: the background workers (the clock, the pollers, the two
 * resume workers) called into a firing with NO ambient Context, so the step
 * that stores a fetched page — which scopes itself by the acting identity —
 * threw `Async local storage undefined` inside the plugin. The plugin's catch
 * turned that into a warning and returned nothing, so `fetch_url` contributed
 * nothing on every scheduled run and nothing said so.
 *
 * The whole point of this script is HOW it fires: it calls the dispatch seam
 * bare, with no Context of its own, exactly as a worker does. The seeding does
 * touch the database, but no part of it establishes a Context the firing could
 * inherit.
 *
 *   npx ts-node --project tsconfig.dev.json --transpile-only \
 *     -r dotenv/config -r tsconfig-paths/register \
 *     src/scripts/dev/verify_background_run_context.ts
 *
 * The page is served from a local HTTP server started here, and the outbound
 * unlocker call is answered from it — so the fetch, the persistence, and the
 * extraction behind them are all the real thing, and only the third party is
 * not. Nothing outside this process is started or stopped.
 */
import './_profile_loader';

// Composition root — registers the services the fetch path reaches.
import '../../services';
import '../../services/translation_graph/engine/transforms/register-bundled';

import * as http from 'node:http';
import { randomUUID } from 'node:crypto';

import type { AddressInfo } from 'node:net';

import { ensureDevLoopTeam } from './_lib';
import { logger } from 'movement-engine/services/logger';
import { getAutomationsQb, getKnowledgeQb } from '../../lib/kysely';
import { saveMovement } from '../../services/translation_graph/movement/provision';
import { dispatchTriggerByIdEvent } from '../../services/translation_graph/triggers/router';
import { unsafeCurrentContext } from '../../services/context';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerId } from '../../generated/kysely/automations/Trigger';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';

// ── The page the movement loads ───────────────────────────────────────────

/** Long enough to clear the scraper's thin-content floor, and carrying one
 *  fact nothing else in the run knows — so a field holding it is proof the
 *  fetched bytes reached the extraction behind the plugin. */
const MOTTO = 'Rings forged at scale since the Second Age';
const PAGE = `<!doctype html>
<html><head><title>Gondor Forge</title></head><body>
<h1>Gondor Forge</h1>
<p>${MOTTO}</p>
<p>Gondor Forge builds smelting equipment for the great houses of the west. We
have supplied the citadel, the harbour works and the northern watchtowers for
longer than anyone still working here can remember. Our foundry runs on the
same principles it always has: heat, patience, and an unreasonable interest in
the grain of a finished piece.</p>
<p>Our customers are industrial buyers who need one thing done exactly right,
repeatedly, for years. We do not sell software, we do not sell services, and we
have never once shipped a product we would not use ourselves.</p>
</body></html>`;

// ── Capturing the log the bug used to hide in ─────────────────────────────

const captured: string[] = [];

function captureLogs(): void {
  for (const level of ['info', 'warn', 'error'] as const) {
    const original = logger[level].bind(logger);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (logger as any)[level] = (message: unknown, meta?: unknown) => {
      captured.push(`${String(message)} ${meta === undefined ? '' : safeJson(meta)}`);
      return original(message as never, meta as never);
    };
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ── Standing in for the unlocker, and only for it ─────────────────────────

/** Answer the Web Unlocker's POST from the local server, for the local
 *  address only. Every other request leaves the process untouched. */
function answerUnlockerLocally(origin: string): void {
  const send = globalThis.fetch;
  globalThis.fetch = async (
    input: Parameters<typeof send>[0],
    init?: Parameters<typeof send>[1],
  ) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (target.startsWith('https://api.brightdata.com/request')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { url?: string };
      if (typeof body.url === 'string' && body.url.startsWith(origin)) {
        const page = await send(body.url);
        return new Response(await page.text(), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
    }
    return send(input, init);
  };
}

// ── The movement ──────────────────────────────────────────────────────────

const MOVEMENT_NAME = 'background_run_context_probe';

const program = (website: string) => `
import { manual } from adapters
import { fetchUrl } from plugins

runs = connect manual

node Company: "each company named in this message" {
  name:    <text> "the company's name"
  website: <text> "the company's web address, if the message gives one"
}

node Page: "the company's own page" {
  motto: <text> "the company's motto, exactly as its own page words it"
}

function ${MOVEMENT_NAME}(go: <runs-[:Invocation]->>) {
  companies = extract([go.\`Text\`], Company)
  mottos = map(companies, (c) => {
    page = fetchUrl(c.website, { email: "x@y.z" })
    return extractOne([page], Page)
  })
}

listen to runs {} fire ${MOVEMENT_NAME}
`;

const message = (website: string) =>
  `One from this morning: Gondor Forge (${website}) — industrial smelting equipment.`;

// ── The run's trace, as the row carries it ────────────────────────────────

type PluginTrace = { plugin: string; node?: string; chars?: number; outcome?: string };

function pluginTraceOf(steps: unknown): PluginTrace[] {
  const out: PluginTrace[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const entry = value as Record<string, unknown>;
    if (entry.kind === 'plugin' && typeof entry.plugin === 'string') {
      out.push(entry as PluginTrace);
    }
    for (const child of Object.values(entry)) walk(child);
  };
  walk(steps);
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  captureLogs();

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  answerUnlockerLocally(origin);
  console.log(`serving the page at ${origin}`);

  try {
    // ── Seeding. No Context is established here, and none is needed. ──────
    const seed = await ensureDevLoopTeam();
    const teamId = seed.teamId as TeamId;

    const saved = await saveMovement({
      teamId: seed.teamId,
      userId: seed.userId,
      source: program(origin),
    });
    if (!saved.ok) {
      console.error(JSON.stringify(saved, null, 2));
      throw new Error('the probe movement did not save');
    }
    const listener = saved.listeners[0];
    if (!listener) throw new Error('the probe movement declared no listener');

    const trigger = await getAutomationsQb(['trigger'])
      .selectFrom('trigger')
      .select(['id', 'team_id', 'created_by_user_id'])
      .where('id', '=', listener.triggerId as TriggerId)
      .executeTakeFirstOrThrow();
    console.log(
      `trigger ${trigger.id} on team ${trigger.team_id}, authored by ` +
        `${trigger.created_by_user_id ?? '(nobody — the seam falls back to a team member)'}`,
    );

    // ── The firing. Bare: this is the whole test. ─────────────────────────
    if (unsafeCurrentContext() !== undefined) {
      throw new Error('a Context is in scope — this script must fire without one');
    }

    const event: TriggerEvent = {
      pipelineInputId: `trigger:${listener.triggerId}`,
      adapterType: 'manual',
      triggerType: 'webhook',
      payload: {
        firedAt: new Date().toISOString(),
        submissionId: randomUUID(),
        text: message(origin),
      },
    };

    const outcome = await dispatchTriggerByIdEvent({
      triggerId: listener.triggerId,
      teamId,
      event,
    });
    console.log('\ndispatch:', JSON.stringify(outcome));

    // ── What the run says happened ────────────────────────────────────────
    const run = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .select(['id', 'status', 'steps', 'failure_reason'])
      .where('trigger_id', '=', listener.triggerId as TriggerId)
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    const plugins = pluginTraceOf(run.steps);
    console.log(`run ${run.id} ${run.status}${run.failure_reason ? `: ${run.failure_reason}` : ''}`);
    for (const entry of plugins) {
      console.log(
        `  plugin ${entry.plugin} on ${entry.node ?? '?'}: ` +
          `outcome ${entry.outcome ?? '(none)'}${entry.chars ? `, ${entry.chars} chars` : ''}`,
      );
    }

    // ── The page, as it was stored ────────────────────────────────────────
    const page = await getKnowledgeQb(['raw_text'])
      .selectFrom('raw_text')
      .select(['id', 'team_id', 'content'])
      .where('content', 'like', `%${MOTTO}%`)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    console.log(
      `\nraw_text for the fetched page: ${page ? `${page.id} on team ${page.team_id}` : '(none)'}`,
    );

    // ── The claims ────────────────────────────────────────────────────────
    const failures: string[] = [];

    const storageError = captured.filter((line) => line.includes('Async local storage undefined'));
    if (storageError.length > 0) {
      failures.push(
        `the run still hit the missing Context ${storageError.length}×: ${storageError[0]?.slice(0, 300)}`,
      );
    }

    const fetch_url = plugins.find((entry) => entry.plugin === 'fetch_url');
    if (!fetch_url) failures.push('the trace has no fetch_url entry');
    else {
      if (fetch_url.outcome !== 'fetched') {
        failures.push(`fetch_url reported outcome ${fetch_url.outcome ?? '(none)'}, not fetched`);
      }
      if (!fetch_url.chars || fetch_url.chars <= 0) {
        failures.push('fetch_url fed no characters to the extraction behind it');
      }
    }

    if (!page) failures.push('the fetched page was never stored');
    else if ((page.team_id as unknown as string) !== seed.teamId) {
      failures.push(`the page was stored on team ${page.team_id}, not the trigger's ${seed.teamId}`);
    }

    // The fetched bytes reaching the STAGE is a different claim from their
    // being stored. The motto appears nowhere in the message that fired, so
    // the extracted entity on the run's own record carrying it is the proof.
    const extracted = safeJson(run.steps);
    if (!extracted.includes(MOTTO.slice(0, 24))) {
      failures.push('no extracted entity carries the page’s own words — the fetch never reached the stage');
    }

    console.log('');
    if (failures.length > 0) {
      for (const failure of failures) console.error(`FAIL ${failure}`);
      throw new Error(`${failures.length} claim(s) failed`);
    }
    console.log('OK — a firing with no ambient Context fetched, stored and extracted the page');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
