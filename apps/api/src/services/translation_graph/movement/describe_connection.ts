// describeConnection's default answer, and the step getStarted shares with it:
// a walked node whose stubbed landings have been described.
//
// A walk stubs a landing when describing it up front would fetch the whole
// workspace (Attio's root has an edge per object and per list). That is right
// for a walk, and wrong for the first read of a build: the stubs are exactly
// the record types a builder writes to. So both readers describe the stubs by
// name, in parallel, through the catalog's cached instance — a type described
// once is free for the next describe or compile that names it.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { WalkedEdge, WalkedNode } from './walk';

import {
  describeMovementInstance,
  describeMovementLandings,
  movementCatalogSnapshotForTeam,
  type DescribedInstance,
} from './catalog';
import { renderConnectionDescription, type SystemDigestInput } from './connection_digest';

/** At most this many stubs are described per node. Writable ones come first;
 *  the rest keep their names and say they are one hop away. */
export const STUBS_RESOLVED_PER_NODE = 12;

/** How long describeConnection waits for its stubs before answering without them. */
const DESCRIBE_LANDINGS_TIMEOUT_MS = 20_000;

/** The promise's value, or null once `ms` has passed. */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(ms, 0));
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** The stubbed edges worth describing, writable first, capped. */
function stubsToResolve(node: WalkedNode): WalkedEdge[] {
  return node.edges
    .filter((edge) => edge.target?.stub === true)
    .map((edge, index) => ({ edge, index }))
    .sort((a, b) => Number(b.edge.writable) - Number(a.edge.writable) || a.index - b.index)
    .slice(0, STUBS_RESOLVED_PER_NODE)
    .map(({ edge }) => edge);
}

/**
 * The node with its stubbed landings described, where they could be within
 * `timeoutMs`. A stub that could not be described stays a stub — named, and
 * saying it is one hop away — never an empty type.
 */
export async function resolveStubLandings(input: {
  teamId: TeamId;
  system: string;
  connection?: string;
  node: WalkedNode;
  timeoutMs: number;
}): Promise<WalkedNode> {
  const stubs = stubsToResolve(input.node);
  if (stubs.length === 0) return input.node;
  const names = [...new Set(stubs.flatMap((edge) => (edge.target ? [edge.target.name] : [])))];
  const landings = await within(
    describeMovementLandings({
      teamId: input.teamId,
      adapter: input.system,
      ...(input.connection !== undefined ? { credentialName: input.connection } : {}),
      types: names,
    }).catch(() => null),
    input.timeoutMs,
  );
  if (landings === null) return input.node;
  return {
    ...input.node,
    edges: input.node.edges.map((edge) => {
      if (edge.target?.stub !== true) return edge;
      const landing = landings[edge.target.name];
      return landing !== undefined ? { ...edge, target: landing } : edge;
    }),
  };
}

/** The credential import names that serve `system` in a catalog snapshot. */
export function connectionsFor(
  credentials: Record<string, { adapters: string[] } | { adapter: string }>,
  system: string,
): string[] {
  return Object.entries(credentials)
    .filter(([, credential]) =>
      'adapters' in credential ? credential.adapters.includes(system) : credential.adapter === system,
    )
    .map(([name]) => name);
}

/** How to construct and listen to `system`, for the root of a description. */
async function constructionOf(
  teamId: TeamId,
  system: string,
): Promise<{ spec?: SystemDigestInput['spec']; connections: string[] }> {
  try {
    const { snapshot } = await movementCatalogSnapshotForTeam(teamId);
    const spec = snapshot.adapters[system];
    return { ...(spec !== undefined ? { spec } : {}), connections: connectionsFor(snapshot.credentials, system) };
  } catch {
    return { connections: [] };
  }
}

/**
 * One system at one place, as compact text: the digest's notation, the node's
 * own fields, and every edge with what it lands on, one level deep. The root
 * also carries how to construct and listen, and the manifest's prose.
 */
export async function describeConnectionCompact(input: {
  teamId: TeamId;
  system: string;
  connection?: string;
  position?: string;
  types?: string[];
  narrow?: { type: string; where: string };
}): Promise<string> {
  const atRoot = input.position === undefined || input.position.trim() === '';
  const [described, construction] = await Promise.all([
    describeMovementInstance({
      teamId: input.teamId,
      adapter: input.system,
      // Every describe re-reads the live schema: a field just added in the
      // external workspace must show up on the next call.
      forceRefresh: true,
      ...(input.connection !== undefined ? { credentialName: input.connection } : {}),
      ...(input.types !== undefined ? { types: input.types } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      ...(input.narrow !== undefined ? { narrow: input.narrow } : {}),
    }),
    atRoot ? constructionOf(input.teamId, input.system) : Promise.resolve(undefined),
  ]);
  const node =
    described.node !== undefined
      ? await resolveStubLandings({
          teamId: input.teamId,
          system: input.system,
          ...(input.connection !== undefined ? { connection: input.connection } : {}),
          node: described.node,
          timeoutMs: DESCRIBE_LANDINGS_TIMEOUT_MS,
        })
      : undefined;
  return renderConnectionDescription({
    system: input.system,
    ...(construction?.spec !== undefined ? { spec: construction.spec } : {}),
    ...(construction !== undefined ? { connections: input.connection !== undefined ? [input.connection] : construction.connections } : {}),
    ...(node !== undefined ? { node } : {}),
    schema: described.schema,
    notes: described.notes,
    ...(atRoot ? { about: aboutOf(described) } : {}),
  });
}

function aboutOf(described: DescribedInstance) {
  return {
    ...(described.description !== undefined ? { description: described.description } : {}),
    ...(described.triggerExpectation !== undefined ? { triggerExpectation: described.triggerExpectation } : {}),
    ...(described.authoringHints !== undefined ? { authoringHints: described.authoringHints } : {}),
    ...(described.identity !== undefined ? { identity: described.identity } : {}),
    ...(described.capability !== undefined ? { capability: described.capability } : {}),
  };
}
