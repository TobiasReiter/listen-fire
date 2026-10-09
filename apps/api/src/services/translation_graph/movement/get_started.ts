// What an authoring agent reads before it writes anything, in one call: the
// handbook's front page, the team it is acting in, and that team's systems in
// digest form (connection_digest.ts). The point is a build that needs no other
// reading — everything here would otherwise cost a readHandbook, a listTeams,
// a listConnections and a describeConnection per system.

import type { TeamRef } from 'principal';
import type { TeamId } from '../../../generated/kysely/core/Team';

import { renderFrontPage } from '../../../lib/knowledge/movement_handbook/front_page';
import { describeMovementInstance, movementCatalogSnapshotForTeam } from './catalog';
import { renderConnectionsDigest, type SystemDigestInput } from './connection_digest';
import { connectionsFor, resolveStubLandings, within } from './describe_connection';

/** A system slower than this to describe at its root keeps its construction
 *  line only, so one slow connection cannot hold the whole first call up. */
const DESCRIBE_TIMEOUT_MS = 8_000;
/** The whole of one system — root, then its stubbed record types — within
 *  this; record types not described by then stay named, without fields. */
const SYSTEM_TIMEOUT_MS = 12_000;

/**
 * The team's systems: those it connected first, then those that need no
 * connection, each described at its root with its stubbed record types
 * described too. A system that needs a connection the
 * team lacks is only named, so the agent knows to connect it.
 */
export async function connectedSystemsDigest(teamId: TeamId): Promise<string> {
  const { snapshot, remoteConnections } = await movementCatalogSnapshotForTeam(teamId);
  const connected: Array<Pick<SystemDigestInput, 'system' | 'spec' | 'connections'>> = [];
  const builtIn: typeof connected = [];
  const notConnected: string[] = [];

  for (const [system, spec] of Object.entries(snapshot.adapters)) {
    const connections = connectionsFor(snapshot.credentials, system);
    const needsCredential = spec.constructionArgs.some((a) => a.kind === 'credential' && a.required);
    const remote = remoteConnections?.[system];
    if ((needsCredential && connections.length === 0) || remote === 'needs-secret') {
      notConnected.push(spec.connect === 'app-only' ? `${system} (connects in the app)` : system);
    } else if (needsCredential || remote === 'connected') {
      connected.push({ system, spec, connections });
    } else {
      builtIn.push({ system, spec, connections });
    }
  }

  const systems = await Promise.all(
    [...connected, ...builtIn].map(async (entry): Promise<SystemDigestInput> => {
      const started = Date.now();
      const connection = entry.connections[0];
      try {
        const described = await within(
          describeMovementInstance({
            teamId,
            adapter: entry.system,
            ...(connection !== undefined ? { credentialName: connection } : {}),
          }),
          DESCRIBE_TIMEOUT_MS,
        );
        if (described === null) return { ...entry, note: 'its records took too long to load' };
        if (!described.node) {
          return { ...entry, schema: described.schema, note: described.notes[0] ?? 'its records could not be read' };
        }
        // The root names the record types; the ones it stubbed are the ones a
        // builder writes to, so describe them too, inside the system's budget.
        const node = await resolveStubLandings({
          teamId,
          system: entry.system,
          ...(connection !== undefined ? { connection } : {}),
          node: described.node,
          timeoutMs: SYSTEM_TIMEOUT_MS - (Date.now() - started),
        });
        return { ...entry, node, schema: described.schema };
      } catch (err) {
        return { ...entry, note: `its records could not be read (${err instanceof Error ? err.message : String(err)})` };
      }
    }),
  );

  return renderConnectionsDigest({ systems, notConnected });
}

function teamSection(input: { teams: TeamRef[]; teamId: string | null }): string {
  const label = (t: TeamRef) => `${t.name} — \`${t.teamId}\`${t.isPersonal ? ' (personal)' : ''}`;
  if (input.teamId !== null) {
    const team = input.teams.find((t) => t.teamId === input.teamId);
    const others = input.teams.filter((t) => t.teamId !== input.teamId);
    return [
      `## Team: ${team ? label(team) : `\`${input.teamId}\``}`,
      ...(others.length > 0
        ? [`Other teams (pass one's id as \`team\` to act there): ${others.map(label).join('; ')}`]
        : []),
    ].join('\n\n');
  }
  return [
    '## Teams',
    "This connection spans several teams. Pass one's id as `team` to the tools that create or change things — and to getStarted to see that team's systems.",
    input.teams.map((t) => `- ${label(t)}`).join('\n'),
  ].join('\n\n');
}

const EXTRACT_CACHE_TIP =
  'When `extract(...)` or `extractOne(...)` takes several content arguments, put content shared across calls (a fixed instructions or reference document) first and the per-call content (the email body) after it: the prompt is cached on the longest shared prefix.';

/**
 * The whole first read, as markdown. `teamId` is null when the connection spans
 * several teams and none was named: the systems then wait for one.
 */
export async function renderGetStarted(input: {
  teams: TeamRef[];
  teamId: TeamId | null;
}): Promise<string> {
  const systems = input.teamId === null ? null : await connectedSystemsDigest(input.teamId);
  return [
    teamSection(input),
    ...(systems !== null ? ['## Systems', systems, EXTRACT_CACHE_TIP] : []),
    renderFrontPage(),
  ].join('\n\n');
}
