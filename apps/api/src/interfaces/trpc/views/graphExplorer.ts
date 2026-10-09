/**
 * tRPC surface for the hidden `/graph-explorer` page — the live adapter
 * type-graph explorer.
 *
 * `listInstances` names a team's introspectable systems (a connected adapter
 * per credential type, plus remotes). `walk` stands on ONE position of ONE of
 * them and returns exactly what the authoring agent gets from
 * `describeConnection`: the node, its properties, and its edges, each edge
 * carrying where it lands and the address that walks it.
 *
 * NOTHING here loads a graph. One call is one hop, scoped to the position
 * asked about — the caller echoes an edge's `position` to go deeper, exactly as
 * the agent does. That is not merely cheaper: the explorer's whole value is
 * showing what the agent sees, so it must see it BY THE SAME ROUTE. A second
 * walker would render its own defects as adapter facts.
 *
 * `types: []` says the quiet part: the explorer asks for no schema projection
 * at all. The walk is the entire surface.
 *
 * Cross-team introspection (any team by id) is a LOCAL/DEV affordance, gated to
 * non-production: it lets an operator inspect the seeded dev-loop team's graphs.
 * PRACTICAL CAVEAT — the dev-loop team's credentials carry a `baseUrl` pointing
 * at fake-channels (`:6056`), so introspecting them only RESOLVES on a stack
 * where fake-channels is running (the dev-loop stack). Cross-team introspection
 * is therefore inherently a local-stack feature, which is exactly why prod is
 * never allowed to introspect another team.
 *
 */

import { parseTraversalPath } from 'movement-lang';
import { z } from 'zod';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';

import { currentContext } from '../../../services/context';
import { trpc } from '../trpc';
import { getCoreQb } from '../../../lib/kysely';
import { cachedAdapterInstance } from '../../../services/translation_graph/movement/instance_cache';
import {
  enumerateSystems,
  timeboxed,
  SYSTEM_FOOTNOTES,
} from '../../../services/translation_graph/graph_explorer/build';
import { walkedNodeFrom, type WalkedNode } from '../../../services/translation_graph/movement/walk';
import { userProcedure as sharedUserProcedure } from '../procedures';

export type GraphExplorerInstance = {
  adapterType: string;
  displayName: string;
  credential: { id: string; name: string; type: string } | null;
  remote: boolean;
};

export type GraphExplorerTeam = { id: string; name: string };

/**
 * One hop's answer. `node` absent with a `note` is the honest shape for "the
 * walk went nowhere" — never a silent fall back to the root, which would answer
 * a different question than the one asked.
 */
export type GraphExplorerHop = {
  node?: WalkedNode;
  note?: string;
  footnote?: string;
  elapsedMs: number;
};

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const graphExplorerRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  /**
   * The team to introspect. Defaults to the caller's own team. A DIFFERENT team
   * is allowed only in local/dev — cross-team introspection is a dev affordance
   * (see the file header), and production must never read another team's graph.
   */
  const resolveTeamId = (requested?: string): TeamId => {
    const own = currentContext().user.teamId as TeamId;
    if (requested === undefined || requested === own) return own;
    if (IS_PRODUCTION) {
      throw new Error('graphExplorer: cross-team introspection is disabled in production.');
    }
    return requested as TeamId;
  };

  return trpc.router({
    // Local/dev: every team, so the seeded dev-loop team is reachable. Prod:
    // only the caller's own teams (a plain membership lookup).
    listTeams: userProcedure.query(async (): Promise<GraphExplorerTeam[]> => {
      if (!IS_PRODUCTION) {
        const teams = await getCoreQb(['team'])
          .selectFrom('team')
          .select(['id', 'name'])
          .orderBy('name', 'asc')
          .execute();
        return teams.map((t) => ({ id: t.id, name: t.name }));
      }
      const userId = currentContext().user.id as UserId;
      const teams = await getCoreQb(['team_membership', 'team'])
        .selectFrom('team_membership')
        .innerJoin('team', 'team.id', 'team_membership.team_id')
        .where('team_membership.user_id', '=', userId)
        .select(['team.id as id', 'team.name as name'])
        .orderBy('team.name', 'asc')
        .execute();
      return teams.map((t) => ({ id: t.id, name: t.name }));
    }),

    listInstances: userProcedure
      .input(z.object({ teamId: z.string().optional() }).optional())
      .query(async ({ input }): Promise<GraphExplorerInstance[]> => {
        const teamId = resolveTeamId(input?.teamId);
        const systems = await enumerateSystems(teamId);
        return systems.map((s) => ({
          adapterType: s.adapterType,
          displayName: s.displayName,
          credential: s.credential,
          remote: s.remote,
        }));
      }),

    /**
     * ONE hop. `position` is an address a previous hop handed back, echoed
     * verbatim; absent means the root, which is not a special case but simply
     * the node you get when you name no path.
     */
    walk: userProcedure
      .input(
        z.object({
          adapterType: z.string(),
          credentialsId: z.string().optional(),
          position: z.string().optional(),
          forceRefresh: z.boolean().optional(),
          teamId: z.string().optional(),
        }),
      )
      .query(async ({ input }): Promise<GraphExplorerHop> => {
        const teamId = resolveTeamId(input.teamId);
        const at = input.position?.trim();
        const footnote = SYSTEM_FOOTNOTES[input.adapterType];
        const started = Date.now();
        const done = (result: Omit<GraphExplorerHop, 'elapsedMs'>): GraphExplorerHop => ({
          ...result,
          ...(footnote !== undefined ? { footnote } : {}),
          elapsedMs: Date.now() - started,
        });

        const steps = at ? parseTraversalPath(at) : [];
        if (steps === undefined) {
          return done({ note: `${JSON.stringify(at)} is not a path — echo one an edge handed back` });
        }

        // Errors ride the returned hop rather than throwing, so a slow or
        // broken adapter degrades to a labelled card, not a dead page.
        try {
          const instance = await timeboxed(
            cachedAdapterInstance({
              adapterType: input.adapterType,
              teamId,
              types: [],
              ...(input.credentialsId !== undefined ? { credentialsId: input.credentialsId } : {}),
              ...(input.forceRefresh ? { forceRefresh: true } : {}),
            }),
            input.adapterType,
          );
          const hop = await timeboxed(instance.walkFrom(steps), input.adapterType);
          if (!hop) {
            return done({
              note:
                steps.length === 0
                  ? `${input.adapterType} does not walk — it publishes no edges from its connection.`
                  : `${JSON.stringify(at)} reaches nothing on this connection`,
            });
          }
          return done({ node: walkedNodeFrom({ hop, at: at ?? '' }) });
        } catch (err) {
          return done({ note: err instanceof Error ? err.message : String(err) });
        }
      }),
  });
};

export { graphExplorerRouter };
