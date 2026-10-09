/**
 * Dev-loop connection describer — the MCP `describeConnection` path, driven
 * from the CLI.
 *
 *   pnpm dev:describe <system> [--connection <name>] [--types A,B]
 *                              [--narrow-type <T> --where '<predicate>']
 *
 * Calls the REAL `describeMovementInstance` against the running dev-loop stack
 * (fake-channels), so what it prints is exactly what an authoring agent sees
 * through MCP — including the narrowing surface a polymorphic type needs.
 *
 * A polymorphic type's direct surface is the INTERSECTION of its members, and
 * the intersection is frequently EMPTY, so narrowing is the only route from
 * such a type to a member's real fields and edges:
 *
 *   pnpm dev:describe affinity --narrow-type 'Organization List Entry' \
 *                              --where '`listName` == "Pipeline"'
 *
 * `--where` is movement-lang predicate source, parsed by the language's own
 * parser — the same string goes in the movement's WHERE clause.
 *
 * BACKTICKS: pnpm forwards script args through `sh`, which re-evaluates them,
 * so a `--where` containing backticks (how movement-lang quotes a field name —
 * i.e. most of them) is mangled into command substitution. Pass it as an
 * ENVIRONMENT variable instead, which `sh` leaves alone:
 *
 *   DEV_WHERE='`listName` == "Pipeline"' pnpm dev:describe affinity \
 *     --narrow-type 'Organization List Entry'
 *
 * Every upstream HTTP call is counted (global `fetch` is wrapped), because the
 * standing cost rule on narrowing is the memoized root walk plus ONE describe
 * of the selected member — never a describe per member. `--calls` lists them.
 *
 */

import './_profile_loader';
import '../../services';

import type { TeamId } from '../../generated/kysely/core/Team';

import { ensureDevLoopTeam } from './_lib';
import { describeMovementInstance } from '../../services/translation_graph/movement/catalog';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Count (and optionally list) every upstream HTTP call the describe makes. */
function countUpstreamCalls() {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof original>[0], init?: Parameters<typeof original>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    return original(input, init);
  }) as typeof original;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

async function main() {
  const system = process.argv[2];
  if (!system || system.startsWith('--')) {
    console.error(
      'usage: pnpm dev:describe <system> [--connection <name>] [--types A,B] ' +
        "[--at '<position>'] [--narrow-type <T> --where '<predicate>'] [--calls]",
    );
    process.exit(1);
  }

  const { teamId } = await ensureDevLoopTeam();
  const narrowType = arg('narrow-type');
  // `DEV_WHERE` survives pnpm's arg re-evaluation; `--where` is the convenient
  // form for predicates with no backticks in them.
  const where = process.env.DEV_WHERE ?? arg('where');
  if ((narrowType === undefined) !== (where === undefined)) {
    console.error('--narrow-type and --where must be given together');
    process.exit(1);
  }

  const types = arg('types')?.split(',').map((t) => t.trim());
  const connection = arg('connection');
  // Where to stand. `DEV_AT` survives pnpm's arg re-evaluation, which an
  // address needs — every one of them contains backticks.
  const position = process.env.DEV_AT ?? arg('at');

  const meter = countUpstreamCalls();
  const result = await describeMovementInstance({
    teamId: teamId as TeamId,
    adapter: system,
    ...(connection !== undefined ? { credentialName: connection } : {}),
    ...(types !== undefined ? { types } : {}),
    ...(position !== undefined ? { position } : {}),
    ...(narrowType !== undefined && where !== undefined
      ? { narrow: { type: narrowType, where } }
      : {}),
  });
  meter.restore();

  console.log(JSON.stringify(result, null, 2));
  console.log(`\n── upstream calls: ${meter.calls.length} ──`);
  if (process.argv.includes('--calls')) for (const c of meter.calls) console.log(`  ${c}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
