/**
 * Every edge that promises NOTHING, across every connected system.
 *
 *   pnpm dev:promiseless [--depth 1]
 *
 * An edge is promise-less when it is neither readable nor writable, does not
 * `fire`, is not `await`ed, and offers no members to narrow into — i.e. nothing
 * a movement could do with it. `fires`, `awaitable`, and `members` are the
 * exceptions that matter: an event edge's promise IS `fires`, an awaitable
 * edge's promise IS the resolution you `await` (asks-as-adapter §A — honestly
 * neither readable nor writable), and a polymorphic edge's promises live on the
 * members it narrows to, so each looks empty to a naive read/write test.
 *
 * Walks each system's root, and optionally one hop further along every
 * addressed edge, reporting what it finds per system.
 */

import './_profile_loader';
import '../../services';

import type { TeamId } from '../../generated/kysely/core/Team';

import { ensureDevLoopTeam } from './_lib';
import { describeMovementInstance } from '../../services/translation_graph/movement/catalog';
import { enumerateSystems } from '../../services/translation_graph/graph_explorer/build';

type Edge = {
  name: string;
  readable: boolean;
  writable: boolean;
  fires?: true;
  awaitable?: true;
  position?: string;
  members?: { name: string }[];
};

const promiseless = (e: Edge): boolean =>
  !e.readable &&
  !e.writable &&
  e.fires !== true &&
  e.awaitable !== true &&
  !(e.members && e.members.length > 0);

async function main() {
  const { teamId } = await ensureDevLoopTeam();
  const depth = Number(
    process.argv.includes('--depth') ? process.argv[process.argv.indexOf('--depth') + 1] : 0,
  );
  const systems = await enumerateSystems(teamId as TeamId);

  for (const system of systems) {
    const seen: string[] = [];
    const visit = async (at: string | undefined, hops: number): Promise<void> => {
      const result = await describeMovementInstance({
        teamId: teamId as TeamId,
        adapter: system.adapterType,
        ...(at !== undefined ? { position: at } : {}),
      }).catch(() => null);
      const node = result?.node as { name: string; edges: Edge[] } | undefined;
      if (!node) return;
      for (const edge of node.edges) {
        if (promiseless(edge)) seen.push(`${node.name} -[:${edge.name}]-> (at ${at ?? 'root'})`);
      }
      if (hops <= 0) return;
      for (const edge of node.edges) {
        if (edge.position) await visit(edge.position, hops - 1);
      }
    };
    await visit(undefined, depth).catch(() => undefined);
    if (seen.length > 0) {
      console.log(`\n=== ${system.adapterType} (${seen.length}) ===`);
      for (const line of seen) console.log(`  ${line}`);
    } else {
      console.log(`\n=== ${system.adapterType} — clean ===`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
