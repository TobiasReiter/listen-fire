/**
 * What does ONE write cost upstream?
 *
 *   pnpm dev:measure-write [--connection <name>] [--calls]
 *
 * Counts every upstream HTTP call a single `createRecord` against Attio makes,
 * the same way `dev:describe --calls` does (global `fetch` is wrapped). It
 * exists because the adapter name resolver sits on the WRITE path: it used to
 * `describe()` every entry point on first resolve, so a run that wrote one
 * record paid an attribute fetch for every object in the workspace. That cost
 * is invisible to `dev:describe`, which only exercises the read surface — this
 * is the counterpart measurement.
 */

import './_profile_loader';
import { resolveAdapter } from '../../services/translation_graph/adapters/resolve';

import type { TeamId } from '../../generated/kysely/core/Team';

import { getAutomationsQb } from '../../lib/kysely';
import { ensureDevLoopTeam } from './_lib';
import { userEditContext } from '../../services/translation_graph/mutation_context';

function countUpstreamCalls() {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof original>[0],
    init?: Parameters<typeof original>[1],
  ) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    return original(input, init);
  }) as typeof original;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const { teamId } = await ensureDevLoopTeam();
  const connection = arg('connection') ?? 'Dev Loop Attio';

  const credential = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .select(['id'])
    .where('team_id', '=', teamId as TeamId)
    .where('name', '=', connection)
    .executeTakeFirst();
  if (!credential) throw new Error(`no credential named '${connection}' for the dev-loop team`);

  const adapter = await resolveAdapter({
    adapterType: 'attio',
    teamId: teamId as TeamId,
    credentialsId: credential.id as string,
  });

  const meter = countUpstreamCalls();
  const result = await adapter.createRecord({
    recordType: 'Companies',
    fields: { Name: `Resolver cost probe ${process.pid}` },
    mutationContext: userEditContext('dev-loop'),
  });
  meter.restore();

  console.log(JSON.stringify({ externalId: result.externalId }, null, 2));
  console.log(`\n── upstream calls for ONE write: ${meter.calls.length} ──`);
  if (process.argv.includes('--calls')) for (const c of meter.calls) console.log(`  ${c}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
