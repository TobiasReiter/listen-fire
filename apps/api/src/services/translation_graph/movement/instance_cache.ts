// Cached adapter-instance introspection for the movement catalog.
//
// Introspecting one (adapter, credential) pair — `listEntryPoints()` plus
// one `describe(typeId)` per entry — is the expensive, network-backed step
// of catalog assembly. Every consumer goes through this module:
//
//   - `movement.describeInstance` (tRPC) — the editor streaming schemas in
//     on demand as the source references constructions;
//   - `movementCatalogForTeam` — the saveMovement/provision compile path
//     introspecting only the pairs the source constructs.
//
// Semantics:
//   - in-memory TTL cache (3 minutes) keyed (teamId, adapterType, credentialsId);
//   - single-flight: concurrent callers for the same key share one
//     in-flight introspection;
//   - successes only — a failed introspection is evicted so the next
//     caller retries (a broken adapter shouldn't stay broken for the TTL);
//   - `forceRefresh` drops the entry first — `describeConnection` always
//     passes it, so it is the escape hatch when the external workspace's
//     schema just changed.
//
// E2 NOTE (runtime borrowed-type resolution): when the engine starts
// resolving borrowed instance types at run time, it should reuse this
// cache as its fast path but apply its OWN staleness rules (a run may pin
// the schema observed at compile time, or insist on fresher-than-TTL data
// for schema-sensitive writes). Keep run-time policy out of here; expose
// what it needs instead.

import { parseTraversalPath } from 'movement-lang';

import type { Expression } from '#shared/expression/types';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { SchemaTypeDescriptor, SourcePosition } from 'movement-engine/services/translation_graph/types';
import type { Adapter, EdgesFromResult } from 'movement-engine/services/translation_graph/adapter';
import type { AdapterIntrospection } from '../adapters/name_resolution';

import { selectMember } from './narrowing';
import { ADAPTER_META_TYPE_ID, makeMetaPosition, positionLabel } from 'movement-engine/services/translation_graph/types';
import { resolveAdapter } from '../adapters/resolve';
import { getAdapterManifest } from '../adapters/registry';
import { getRemoteAdapter, rowToManifest } from '../adapters/remote/store';
import {
  instanceSchemaFromDescriptors,
  type AdapterSchemaProjection,
} from 'movement-engine/services/translation_graph/movement/schema_projection';


/**
 * Long enough to stay warm across ONE authoring loop — validate, then save
 * moments later — without re-introspecting the same instance on every hop.
 * Staleness beyond that is bounded by the escape hatch: `describeConnection`
 * always evicts the (team, adapter, credential) entry it describes before
 * reading, so an agent that just changed the external schema sees it fresh,
 * and the compile that follows reads what the describe just read.
 */
const TTL_MS = 3 * 60 * 1000;

/**
 * One instance's introspection, cached: the raw `listEntryPoints()` +
 * per-entry `describe()` and the projected `InstanceSchema` (the checker's
 * source). Since the nodes-then-per-node contract (2026-07-05), the cache is
 * an INCREMENTAL per-type accumulator: a scoped request (`types`) describes
 * only the missing types and merges them in, so repeated scoped calls build
 * toward the full surface and a full call finishes it. The entry list is
 * always enumerated (it is the cheap "what nodes exist" half).
 */
export interface CachedAdapterInstance {
  projection: AdapterSchemaProjection;
  introspection: AdapterIntrospection;
  /** Every entry point, regardless of what was described — the node list. */
  entryPoints: { typeId: string; displayName: string; writable: boolean; readable: boolean }[];
  /**
   * The META node's own descriptor — the root as a NODE, whose references are
   * the root collections as EDGES. Held so the re-projections in `catalog.ts`
   * state the same root capabilities this instance's projection does; null when
   * the adapter answers nothing for its root (no capability declared, and the
   * checker's gate stays silent, exactly as for an undeclared record edge).
   *
   */
  metaDescriptor: SchemaTypeDescriptor | null;
  /** The full raw entry list (collectionName, eventPosition flags, …) — the
   *  demand-scoped compile path projects from THESE plus the demanded
   *  descriptors, so collections stay complete and an undemanded type projects
   *  `undescribed` — the ABSENCE of a claim, reported at the use, never an open
   *  door (see `PositionSchema.undescribed` in the checker's catalog). */
  rawEntries: Awaited<ReturnType<Awaited<ReturnType<typeof resolveAdapter>>['listEntryPoints']>>;
  /** The live adapter, for follow-up scoped calls against the same instance. */
  adapter: Awaited<ReturnType<typeof resolveAdapter>>;
  /**
   * This instance's surface is WALKED, not published whole — so an edge to an
   * un-published type is expected rather than adapter drift.
   *
   * Stated here, once, because it is two facts ANDed (`walksContainers` says
   * the eager describe fans out; `edgesFrom` says there is a cheaper route)
   * and a second copy of that reasoning elsewhere is how the two definitions
   * drift apart. They already had: the compile path tested `edgesFrom` alone,
   * which — once all sixteen adapters walked — suppressed the drift note for
   * every adapter, including the uniform ones where an unpublished edge target
   * really is drift.
   */
  lazilySurfaced: boolean;
  /**
   * Describe ONE type by name, walking to it when its path is known.
   *
   * This is how NARROWING resolves. A traversal over a polymorphic edge that
   * narrows within the traversal (`-[s:Spreadsheet WHERE `Title` == "Foo"]->`)
   * must be procedurally identical to taking the named edge (`-[s:`Foo`]->`) —
   * the same type node, reached by the same minimal fanout. Both are therefore
   * this one call, and neither may pay for the members it didn't ask about.
   *
   */
  describeType: (typeName: string) => Promise<SchemaTypeDescriptor | null>;
  /**
   * The members of one meta-graph type, as the META WALK published them — each
   * with the name that addresses it and the data an adapter labelled it with.
   *
   * This is the member source for narrowing a hop the caller isn't standing on:
   * **valid members are discovered by traversing from the meta node**, not from
   * wherever the author happens to be. That is what will let an EVENT's edge
   * narrow to a table — the event never enumerates the tables; the meta walk
   * already did (`6_event_positions.md`).
   *
   * Empty for a flat adapter: uniform schema means no containers to walk, so
   * there are no meta-graph members and nothing to narrow.
   */
  membersOf: (recordType: string) => Promise<Array<{ name: string; data: unknown }>>;
  /**
   * Walk a PATH from the meta node and describe where it lands.
   *
   * The address form, for a caller that holds the walk rather than a name —
   * the listen-config narrowing, whose address is `-[:Base WHERE …]->-[:Table
   * WHERE …]->` and never appears as a type name anywhere. A path costs exactly
   * its own length: each hop follows a position the previous hop handed over,
   * so the two-hop form is 1 + 1 and never a fanout across the members it
   * didn't name.
   *
   */
  walkTo: (
    steps: readonly { type: string; edgeTypeId?: string; expressionFilter?: Expression }[],
  ) => Promise<SchemaTypeDescriptor | null>;
  /**
   * The members one hop on from where a PATH lands — what the NEXT hop could
   * legally have been, given the ones already taken.
   *
   * `walkTo`'s sibling, and the address's variance surface: `base`'s options
   * live at the root (already walked, so free), `table`'s live one base in, so
   * they cost that base and no other. This is what lets `` `table` ==
   * "tblDaels" `` be an enum error rather than silence, without ever
   * enumerating tables across bases.
   *
   */
  membersAt: (input: {
    steps: readonly { type: string; edgeTypeId?: string; expressionFilter?: Expression }[];
    recordType: string;
  }) => Promise<Array<{ name: string; data: unknown }>>;
  /**
   * The HOP itself — the node a path lands on together with what leaves it and
   * what those edges land on.
   *
   * `walkTo` keeps only the descriptor because narrowing only ever wanted the
   * shape. The agent-facing call wants the whole answer: one call at a node
   * describes the node, its properties and its edges, and an edge is only
   * useful if it says where it goes. So this is the raw walk, and the
   * projection into the agent's vocabulary happens above it (`./walk.ts`).
   *
   * Null when the adapter does not walk, or when the path lands nowhere —
   * a caller must report that rather than falling back to the root, since
   * answering a different question than the one asked is the silent
   * degradation this model exists to remove.
   *
   */
  walkFrom: (
    steps?: readonly { type: string; edgeTypeId?: string; expressionFilter?: Expression }[],
  ) => Promise<EdgesFromResult | null>;
}

interface InstanceState {
  adapterPromise: Promise<Awaited<ReturnType<typeof resolveAdapter>>>;
  entriesPromise: Promise<Awaited<ReturnType<Awaited<ReturnType<typeof resolveAdapter>>['listEntryPoints']>>>;
  /** Per-type single-flight describes, merged across scoped calls. */
  descriptorPromises: Map<string, Promise<SchemaTypeDescriptor | null>>;
  /**
   * The walk's memory: meta-graph paths learned so far, keyed by the type NAME
   * the framework uses. Only an `edgesFrom` hop can teach a path (a position is
   * minted by the adapter, never constructed here), so this fills in as the
   * walk descends — the root hop files the entry types, a base's hop files its
   * tables. A name that's in here costs ONE call to describe; a name that
   * isn't falls back to `describe`, which for a container-shaped adapter means
   * re-deriving the route.
   */
  positionsByName: Map<string, SourcePosition>;
  /** Single-flight for the root hop — the walk's starting point, and the
   *  ROOT's own descriptor (its collections and what they can do). */
  metaWalkPromise?: Promise<EdgesFromResult | null>;
  /** The same descriptor for an adapter that does NOT walk: one `describe` of
   *  the root per instance, however many scoped calls arrive. */
  metaDescriptorPromise?: Promise<SchemaTypeDescriptor | null>;
  expiresAt: number;
}

/** A page cap, so a buggy adapter that returns a constant `nextCursor` can't
 *  spin the walk forever. Far above any real hop's page count. */
const MAX_WALK_PAGES = 100;

/**
 * One hop, drained. Pagination is part of the `edgesFrom` contract, so the
 * walk must follow `nextCursor` to the end or it would silently see a prefix
 * of a wide hop — precisely the bug the contract exists to prevent (Airtable's
 * `listBases` declares an `offset` and never follows it, so a large workspace
 * quietly enumerates only its first page).
 */
async function drainHop(input: {
  adapter: Adapter,
  position: SourcePosition,
}): Promise<EdgesFromResult | null> {
  const edgesFrom = input.adapter.edgesFrom;
  if (!edgesFrom) return null;
  const first = await edgesFrom.call(input.adapter, input.position);
  if (!first) return null;

  const fields = [...first.descriptor.fields];
  const references = [...first.descriptor.references];
  const targetPositions = { ...first.targetPositions };
  // What each edge LANDS ON travels with the edge that carries it, page by
  // page — same keying, so a later page's edges arrive with their targets
  // rather than as names the caller then has to go and resolve.
  const targetNodes = { ...first.targetNodes };
  let cursor = first.nextCursor;
  for (let page = 1; cursor !== undefined && page < MAX_WALK_PAGES; page += 1) {
    const next = await edgesFrom.call(input.adapter, input.position, cursor);
    if (!next) break;
    fields.push(...next.descriptor.fields);
    references.push(...next.descriptor.references);
    Object.assign(targetPositions, next.targetPositions);
    Object.assign(targetNodes, next.targetNodes);
    cursor = next.nextCursor;
  }
  return {
    descriptor: { ...first.descriptor, fields, references },
    targetPositions,
    ...(Object.keys(targetNodes).length > 0 ? { targetNodes } : {}),
  };
}

/**
 * Record what this hop taught us about the paths on from it. A NAMED edge's
 * target is named by `targetTypeId` (the framework's currency) and pathed by
 * the `targetPositions` entry under the edge's own `fieldId`. A POLYMORPHIC
 * edge's members have no reference row each — the presentation is one edge —
 * so a member is named by the label the adapter minted onto its position
 * (`{ Name }`, `{ Title }`), the same convention the `positionArgs` value
 * enums read (`positionLabel`).
 */
function filePaths(state: InstanceState, hop: EdgesFromResult | null): void {
  if (!hop?.targetPositions) return;
  const targetNameByFieldId = new Map(
    hop.descriptor.references.map((reference) => [reference.fieldId, reference.targetTypeId]),
  );
  for (const [fieldId, position] of Object.entries(hop.targetPositions)) {
    const targetName = targetNameByFieldId.get(fieldId) ?? positionLabel(position);
    if (targetName !== undefined) state.positionsByName.set(targetName, position);
  }
}

/**
 * Follow ONE hop from a described node: which edge does this step take, and
 * what is the path on from it?
 *
 * Both spellings of a hop resolve here, because they are the same hop
 * (`4_polymorphic_edges.md`):
 *
 *   -[:`CRM`]->                      the named edge
 *   -[:Base WHERE `Name` == "CRM"]-> the polymorphic edge, narrowed
 *
 * A narrowed hop IS the named one — same landing, same single fetch, no fanout.
 * The routes differ only in how the member is picked: by NAME, or by a
 * predicate over the members THIS hop published (`selectMember`). The step's
 * own `edgeTypeId` (`Base`) says which KIND of member it expects, so
 * `-[:Table WHERE …]->` can't silently walk to a base.
 */
function stepTo(input: {
  hop: EdgesFromResult;
  step: { edgeTypeId: string; expressionFilter?: Expression };
}): SourcePosition | undefined {
  const { hop, step } = input;

  if (step.expressionFilter !== undefined) {
    // Members are the PATHS the hop handed over, not its presentation rows: a
    // polymorphic edge is one reference with many members, so its members ride
    // `targetPositions` without a reference row each. The member's own
    // `recordType` says which polymorphic edge it belongs to.
    const members = Object.values(hop.targetPositions ?? {}).flatMap((position) => {
      if (position.recordType !== null && position.recordType !== step.edgeTypeId) return [];
      return [{ data: position.identity.data, value: position }];
    });
    return selectMember({ members, filter: step.expressionFilter });
  }

  const named = hop.descriptor.references.find(
    (reference) => (reference.name ?? reference.fieldId) === step.edgeTypeId,
  );
  return named ? hop.targetPositions?.[named.fieldId] : undefined;
}

/**
 * The root hop — `edgesFrom(meta)`. Every path starts here: a position can only
 * be handed to us by the adapter, so without walking the root we know no paths
 * at all and every hop below would fall back to name resolution. Adapters
 * without `edgesFrom` are uniform-schema — their meta edges are exactly what
 * `listEntryPoints` returns, so there is nothing to walk.
 *
 * A failed root hop is not fatal: it costs paths, not correctness — the
 * `describe` fallback still answers, just without the drill-down's shortcut.
 */
function walkRoot(input: {
  state: InstanceState;
  adapter: Adapter;
  adapterType: string;
}): Promise<EdgesFromResult | null> {
  const { state } = input;
  state.metaWalkPromise ??= drainHop({
    adapter: input.adapter,
    position: makeMetaPosition(input.adapterType),
  })
    .then((hop) => {
      filePaths(state, hop);
      return hop;
    })
    .catch(() => null);
  return state.metaWalkPromise;
}

const states = new Map<string, InstanceState>();

/** Stable serialization of the non-credential construction args — part of the
 *  cache key because they choose the instance's POSITION (Sheets' `spreadsheet:`
 *  entry sheet), and a positioned instance is a different node than the meta
 *  one. Sorted so key order can't split the cache. */
function argsKey(constructionArgs?: Record<string, string>): string {
  if (!constructionArgs) return '';
  const entries = Object.entries(constructionArgs).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? JSON.stringify(entries) : '';
}

function cacheKey(input: {
  teamId: TeamId;
  adapterType: string;
  credentialsId?: string;
  constructionArgs?: Record<string, string>;
}): string {
  return `${input.teamId}::${input.adapterType}::${input.credentialsId ?? ''}::${argsKey(input.constructionArgs)}`;
}

function freshState(input: {
  adapterType: string;
  teamId: TeamId;
  credentialsId?: string;
  constructionArgs?: Record<string, string>;
  forceRefresh?: boolean;
}): InstanceState {
  const adapterPromise = resolveAdapter({
    adapterType: input.adapterType,
    teamId: input.teamId,
    credentialsId: input.credentialsId,
    ...(input.constructionArgs !== undefined ? { constructionArgs: input.constructionArgs } : {}),
  });
  return {
    adapterPromise,
    // A forced refresh is somebody saying the system has changed since we last
    // looked. Dropping this cache alone would re-describe against the
    // adapter's OWN cached schema and report the same stale surface back with
    // a straight face, so the adapter is told to forget too.
    entriesPromise: adapterPromise.then(async (a) => {
      if (input.forceRefresh) await a.invalidateSchemaCache?.();
      return a.listEntryPoints();
    }),
    descriptorPromises: new Map(),
    positionsByName: new Map(),
    expiresAt: Date.now() + TTL_MS,
  };
}

/**
 * One WALK, hop by hop, handing back the hop it ended on — both what is there
 * (`descriptor`) and what the next hop could have been (`targetPositions`).
 *
 * Each hop is one `edgesFrom` along a path the previous hop handed over, so a
 * path costs exactly its own length and never a fanout over members it didn't
 * name.
 *
 */
async function walkHop(input: {
  adapter: Adapter;
  adapterType: string;
  steps: readonly { type: string; edgeTypeId?: string; expressionFilter?: Expression }[];
  /** The walk's memory. A path is only ever learned by taking a hop, so a walk
   *  that files nothing leaves the cache no wiser and the next caller naming
   *  the type it just landed on pays the SLOW route — for a container-shaped
   *  adapter, re-deriving the route means the workspace fanout this whole model
   *  exists to kill. Every hop teaches. */
  state?: InstanceState;
}): Promise<EdgesFromResult | null> {
  if (!input.adapter.edgesFrom) return null;
  let position = makeMetaPosition(input.adapterType);
  // Every walk starts at the root, and the root is the same node for all of
  // them — so take it through the single-flight when there is one to share
  // (which also files its paths). Without a state there is nothing to share.
  let hop = input.state
    ? await walkRoot({ state: input.state, adapter: input.adapter, adapterType: input.adapterType })
    : await drainHop({ adapter: input.adapter, position });
  for (const step of input.steps) {
    // Only edge hops address a type; a field read isn't a place.
    if (step.type !== 'edge' || step.edgeTypeId === undefined || !hop) return null;
    const next = stepTo({ hop, step: { edgeTypeId: step.edgeTypeId, ...(step.expressionFilter ? { expressionFilter: step.expressionFilter } : {}) } });
    if (!next) return null;
    position = next;
    hop = await drainHop({ adapter: input.adapter, position });
    if (input.state) filePaths(input.state, hop);
  }
  return hop;
}

/**
 * Walk a PATH from the root and describe where it lands.
 *
 * The address form: a type is named by the walk that reaches it, not by a
 * string that encodes the walk. Each hop is one `edgesFrom` along a path the
 * previous hop handed over — so a path costs exactly its own length, and never
 * a fanout over members it didn't name.
 *
 */
async function walkPath(input: {
  adapter: Adapter;
  adapterType: string;
  steps: readonly { type: string; edgeTypeId?: string; expressionFilter?: Expression }[];
  state?: InstanceState;
}): Promise<SchemaTypeDescriptor | null> {
  return (await walkHop(input))?.descriptor ?? null;
}

/**
 * The MEMBERS one hop on from where a path lands — the walk's other half.
 *
 * `walkTo` answers "what is the thing at the end"; this answers "what could the
 * next hop have been", which is the address's variance surface: the legal values
 * for the next narrowing key GIVEN the ones already pinned. A base's options are
 * the root's members (free — the root walk holds them anyway); a table's are one
 * base's, so they cost exactly the base that was named. Never a hop per member.
 *
 * `recordType` is the KIND of member wanted (`Base`, `Table`) — the same gate
 * `stepTo` applies, so nothing here can enumerate bases where it meant tables.
 *
 */
async function membersAtPath(input: {
  adapter: Adapter;
  adapterType: string;
  steps: readonly { type: string; edgeTypeId?: string; expressionFilter?: Expression }[];
  recordType: string;
  state?: InstanceState;
}): Promise<Array<{ name: string; data: unknown }>> {
  const hop = await walkHop(input);
  if (!hop) return [];
  // Same member source as `stepTo`: the paths, not the presentation rows. A
  // named member is named by its edge; a polymorphic member by its label.
  const edgeNameByFieldId = new Map(
    hop.descriptor.references.map((reference) => [reference.fieldId, reference.name ?? reference.fieldId]),
  );
  return Object.entries(hop.targetPositions ?? {}).flatMap(([fieldId, position]) => {
    if (position.recordType !== input.recordType) return [];
    const name = edgeNameByFieldId.get(fieldId) ?? positionLabel(position);
    if (name === undefined) return [];
    return [{ name, data: position.identity.data }];
  });
}

/**
 * The cached instance, scoped: `types` limits which entry points get a
 * `describe()` (matched on typeId OR displayName); omitted = the full
 * surface. Scoped fills MERGE into the shared per-instance state.
 */
export async function cachedAdapterInstance(input: {
  adapterType: string;
  teamId: TeamId;
  credentialsId?: string;
  /** Non-credential construction args — they pick the instance's POSITION, so
   *  they're part of the cache key and flow to construction. */
  constructionArgs?: Record<string, string>;
  forceRefresh?: boolean;
  types?: readonly string[];
}): Promise<CachedAdapterInstance> {
  const key = cacheKey(input);
  if (input.forceRefresh) states.delete(key);

  let state = states.get(key);
  if (!state || state.expiresAt <= Date.now()) {
    state = freshState(input);
    states.set(key, state);
    state.entriesPromise.catch(() => {
      if (states.get(key) === state) states.delete(key);
    });
  }
  const held = state;

  let entries;
  try {
    entries = await held.entriesPromise;
  } catch (err) {
    if (states.get(key) === held) states.delete(key);
    throw err;
  }

  const adapter = await held.adapterPromise;

  const wanted = input.types ? new Set(input.types) : undefined;
  // Which entries get a `describe`. Scoped → just those. Unscoped → the full
  // surface… except on a CONTAINER-SHAPED instance, where "the full surface"
  // is the very fan-out this model exists to kill: describing every entry of
  // such an adapter walks every container (a `listTables` per Airtable base),
  // which is the 1+N that timed out at 55s and returned nothing. Walking is
  // hop-by-hop by nature — the node list IS the answer to "what's in this
  // connection", and the author follows one to see inside.
  //
  // Refusing takes BOTH facts, and they are different facts. `walksContainers`
  // says the eager describe fans out; `edgesFrom` says there is a cheaper way
  // to get the same information. Refuse only when both hold — otherwise the
  // caller is left with no surface at all, which is how a describe comes back
  // with every position `undescribed`, no properties and no error.
  //
  // Testing `edgesFrom` alone did exactly that to every uniform adapter the
  // day it learned to walk; testing `walksContainers` alone would do it to an
  // adapter that has containers but cannot yet be walked.
  const refuseFullSurface = adapter.walksContainers === true && adapter.edgesFrom !== undefined;
  const targets = wanted
    ? entries.filter((e) => wanted.has(e.typeId) || wanted.has(e.displayName))
    : refuseFullSurface
      ? []
      : entries;

  /**
   * Describe ONE type — by walking to it when we know its path, else by name.
   *
   * The two are not alternatives so much as the fast and slow route to the
   * same descriptor: a path is a route the adapter handed us, so following it
   * is one call; a bare name leaves the adapter to re-derive the route, which
   * for a container-shaped source means re-walking the containers. Since only
   * a hop can teach a path, walk the root first — otherwise the first hop
   * always takes the slow route and never learns anything.
   */
  const walkTo = async (typeId: string): Promise<SchemaTypeDescriptor | null> => {
    if (adapter.edgesFrom) {
      await walkRoot({ state: held, adapter, adapterType: input.adapterType });
      const position = held.positionsByName.get(typeId);
      if (position) {
        const hop = await drainHop({ adapter, position });
        filePaths(held, hop);
        if (hop) return hop.descriptor;
      }
    }
    return adapter.describe(typeId);
  };

  const describeOnce = (typeId: string) => {
    if (!held.descriptorPromises.has(typeId)) {
      const promise = walkTo(typeId);
      held.descriptorPromises.set(typeId, promise);
      promise.catch(() => {
        // A failed per-type describe is retried on the next request for it.
        if (held.descriptorPromises.get(typeId) === promise) {
          held.descriptorPromises.delete(typeId);
        }
      });
    }
    return held.descriptorPromises.get(typeId) as Promise<SchemaTypeDescriptor | null>;
  };

  // The ROOT as a node, before anything hanging off it. Its references ARE the
  // root collections, and each says what the source can do across it — the fact
  // the checker's hop gate used to fabricate.  Only that capability is read
  // here; the entry list stays the authority on WHICH collections exist.
  //
  // A walking adapter hands the root over on the meta hop it already makes, so
  // this costs it nothing new (and a failed root hop leaves the capability
  // undeclared, which is the same silence a failed hop already accepts). A
  // uniform one describes its root once per instance, however many scoped
  // calls arrive.
  const metaDescriptor = adapter.edgesFrom
    ? ((await walkRoot({ state: held, adapter, adapterType: input.adapterType }))?.descriptor ??
      null)
    : await (held.metaDescriptorPromise ??= adapter
        .describe(ADAPTER_META_TYPE_ID)
        .catch(() => null));

  for (const entry of targets) describeOnce(entry.typeId);

  const descriptors = new Map<string, SchemaTypeDescriptor>();
  for (const entry of targets) {
    const descriptor = await held.descriptorPromises.get(entry.typeId);
    if (descriptor) descriptors.set(entry.typeId, descriptor);
  }

  // A requested type the meta node doesn't publish is not an error: under the
  // type-space model a type can live behind a container (an Airtable table
  // behind its base), reachable by traversal only. Describe it directly —
  // this is the ONLY path to such a type, since `targets` can only ever
  // narrow the entry list. An adapter that doesn't know the name answers
  // null and the type is simply absent, exactly as a null entry describe is.
  const reached: CachedAdapterInstance['rawEntries'] = [];
  if (wanted) {
    const published = new Set(entries.flatMap((e) => [e.typeId, e.displayName]));
    for (const name of wanted) {
      if (published.has(name)) continue;

      // A PATH addresses the type by the walk that reaches it
      // (`-[:Base WHERE `name` == "CRM"]->-[:Companies]->`) rather than by a
      // name that encodes the walk. Anything that isn't a parseable hop chain
      // is a plain name and falls through below.
      const steps = parseTraversalPath(name);
      const descriptor = steps
        ? await walkPath({ adapter, adapterType: input.adapterType, steps, state: held }).catch(() => null)
        : await describeOnce(name).catch(() => null);
      if (!descriptor) continue;

      // A path names its destination; a name names itself.
      const typeName = steps ? descriptor.displayName : name;
      descriptors.set(typeName, descriptor);
      reached.push({
        typeId: typeName,
        displayName: descriptor.displayName,
        // Traversed-to, so readable by construction. Writability is the
        // creatable EDGE's business (createShapes), never a meta-root write.
        readable: true,
        writable: false,
      });
    }
  }

  // `updateRecord` in the manifest `methods[]` is the position-write
  // eligibility gate (see the checker's "can't update in place" reject).
  // A slug with no static manifest may be a per-team REMOTE install — read
  // the capability off its stored manifest instead.
  const supportsInPlaceUpdate = await supportsInPlaceUpdateFor(input);
  // Whether a traversal can carry inline edge properties — the adapter says so
  // itself, statically. The checker needs it because a bare name in a bracket
  // WHERE addresses three surfaces (the edge's own property, an outer binding,
  // a field of the landing) and only this one is unenumerable. An adapter that
  // states nothing has the base capabilities (`BASE_RUNTIME_CAPABILITIES`) —
  // which is also what the partial adapters behind this mocked seam state.
  const edgesCarryProperties = adapter.runtimeCapabilities?.().traversal.edgeProperties ?? false;

  const scopedEntries = wanted ? targets : entries;
  // The name resolver maps surface names back to internal ids at the adapter
  // boundary, so it must know the traversed types too — else a write to one
  // resolves against nothing.
  const introspection: AdapterIntrospection = {
    entries: [...scopedEntries, ...reached],
    descriptors,
  };
  return {
    metaDescriptor,
    projection: instanceSchemaFromDescriptors({
      adapterType: input.adapterType,
      entries: scopedEntries,
      ...(reached.length > 0 ? { reached } : {}),
      descriptors,
      ...(metaDescriptor !== null ? { metaDescriptor } : {}),
      supportsInPlaceUpdate,
      ...(edgesCarryProperties ? { edgesCarryProperties: true } : {}),
      // A CONTAINER-shaped adapter's surface is walked, not published whole,
      // so an edge to an un-walked type is expected rather than drift. A
      // uniform adapter publishes every type it has, walk or no walk — there
      // an unpublished target IS drift, and suppressing the warning would
      // hide it.
      lazilyWalked: refuseFullSurface,
      // Scope-invariant facts (eventPosition, edge target names) derive from
      // the FULL entry list — a scoped describe must never state different
      // facts than the full one, only fewer.
      allEntries: entries,
    }),
    introspection,
    entryPoints: entries.map((e) => ({
      typeId: e.typeId,
      displayName: e.displayName,
      writable: e.writable ?? false,
      readable: e.readable ?? false,
    })),
    rawEntries: entries,
    adapter,
    lazilySurfaced: refuseFullSurface,
    describeType: describeOnce,
    membersOf: async (recordType: string) => {
      if (!adapter.edgesFrom) return [];
      await walkRoot({ state: held, adapter, adapterType: input.adapterType });
      return [...held.positionsByName.entries()]
        .filter(([, position]) => position.recordType === recordType)
        .map(([name, position]) => ({ name, data: position.identity.data }));
    },
    walkTo: (steps) => walkPath({ adapter, adapterType: input.adapterType, steps, state: held }),
    walkFrom: (steps) =>
      walkHop({ adapter, adapterType: input.adapterType, steps: steps ?? [], state: held }),
    membersAt: ({ steps, recordType }) =>
      membersAtPath({ adapter, adapterType: input.adapterType, steps, recordType, state: held }),
  };
}

async function supportsInPlaceUpdateFor(input: {
  adapterType: string;
  teamId: TeamId;
}): Promise<boolean> {
  const manifest = getAdapterManifest(input.adapterType);
  if (manifest) return manifest.methods.includes('updateRecord');
  try {
    const row = await getRemoteAdapter({ teamId: input.teamId, adapterType: input.adapterType });
    return row ? rowToManifest(row).methods.includes('updateRecord') : false;
  } catch {
    return false;
  }
}

/** The projected `InstanceSchema` for one instance (catalog assembly). */
export async function introspectAdapterInstanceCached(input: {
  adapterType: string;
  teamId: TeamId;
  credentialsId?: string;
  constructionArgs?: Record<string, string>;
  forceRefresh?: boolean;
  types?: readonly string[];
}): Promise<AdapterSchemaProjection> {
  return (await cachedAdapterInstance(input)).projection;
}

/**
 * Is this instance's introspection already live in the cache?
 *
 * Read by the authoring-latency log (./timing.ts) so a catalog's cost states
 * WHY it cost that: a cold instance pays `listEntryPoints` plus the walk, a
 * warm one pays only the describes it has not merged in yet. Warm is not free
 * — descriptors accumulate per type — which is why this answers about the
 * instance, not about the describes.
 */
export function adapterInstanceIsWarm(input: {
  adapterType: string;
  teamId: TeamId;
  credentialsId?: string;
  constructionArgs?: Record<string, string>;
}): boolean {
  const state = states.get(cacheKey(input));
  return state !== undefined && state.expiresAt > Date.now();
}

/**
 * Drop cached introspection — one team's, or (with no team named) everyone's.
 *
 * The scoped form is what a run failure uses: a failure says something about
 * the team whose adapters just misbehaved and nothing at all about anyone
 * else's, and a global bust made every other tenant in the process re-introspect
 * their whole connection surface to pay for it. The unscoped form is the test
 * hook.
 */
export function clearIntrospectionCache(teamId?: TeamId): void {
  if (teamId === undefined) {
    states.clear();
    return;
  }
  // `cacheKey` leads with the team, so the team's entries are exactly its
  // prefix — no separate index to keep in step with the key format.
  const prefix = `${teamId}::`;
  for (const key of [...states.keys()]) {
    if (key.startsWith(prefix)) states.delete(key);
  }
}
