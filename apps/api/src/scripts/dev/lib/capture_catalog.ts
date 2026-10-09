// Demand-scoped catalog capture — the pure half.
//
// The handbook's checker fixture used to be captured by a FULL-SURFACE sweep:
// instantiate every adapter, describe everything it publishes. No real save has
// ever worked that way. A save describes what its movement's chains DEMAND
// (`demandSeed` + `closeDemandOverChains`), which is exactly why a
// container-shaped adapter refuses a full-surface describe — so the sweep
// captured NOTHING for Attio and every handbook example that names `Companies`
// checked against a position nobody had looked at.
//
// So the capture drives the same closure a save drives, over movement sources.
// Two pieces are pure and live here; the I/O (one `movementCatalogForTeam` per
// source) lives in the CLI.
//
//   - `rewriteConnectionNames` — the handbook names connections
//     ILLUSTRATIVELY (`acme`, `main_crm`, `team_chat`); a workspace's
//     connections are its own. Rewire each probe's credential to the dev-loop
//     connection for the SAME adapter, so the demand closure resolves. The
//     alias→adapter mapping is read off the probe itself
//     (`referencedConstructions`), never a hand-maintained table — a table
//     would go stale the first time a chapter invents a new alias, and go stale
//     silently (an unresolved connection leaves the instance untyped, which is
//     the checker staying silent, not erroring).
//
//   - `mergeInstanceSchemas` — a per-source capture describes only that
//     source's demand, so the fixture is the UNION over the demand set. The one
//     rule with teeth: a DESCRIBED position beats an undescribed one. Both
//     schemas come from the same adapter, so where both describe a position
//     they describe it identically; where one didn't look, `undescribed` is the
//     absence of a claim and must never overwrite a real one.

import {
  referencedConstructions,
  type InstanceSchema,
  type PositionSchema,
} from 'movement-lang';

import { getMovementHandbook } from '../../../lib/knowledge/movement_handbook';

/** A movement source the capture drives demand from, with a label for reporting. */
export interface CaptureSource {
  label: string;
  source: string;
}

/**
 * The handbook's OWN demand set: every runnable example it publishes.
 *
 * The fixture exists to check handbook prose against reality, so the movements
 * it must be true about are exactly the ones the chapters print — no separate,
 * hand-kept list of capture sources to drift from the chapters (a chapter
 * gaining an example would silently keep checking against a fixture that never
 * described what the example names, which reads as "the checker went quiet",
 * not as a stale list).
 *
 * Every claim, not just the checked subset: a `pending` probe costs a handful of
 * spare describes today and is already covered on the day the engine lifts it.
 *
 * Adapter-declared sections are chapters like any other, so a system that ships
 * its own conceptual documentation drives its own fixture capture.
 */
export function handbookCaptureSources(): CaptureSource[] {
  return Object.values(getMovementHandbook().chapters).flatMap((chapter) =>
    (chapter.engineClaims ?? []).map((claim) => ({
      label: `${chapter.id} — ${claim.construct}`,
      source: claim.probe,
    })),
  );
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** How a connection name is spelled in source: bare when it's an identifier,
 *  backticked otherwise (`` `Dev Loop Attio` ``). */
function spell(name: string): string {
  return IDENTIFIER.test(name) ? name : `\`${name}\``;
}

/**
 * Rewire a source's connection imports onto THIS workspace's connections.
 *
 * `connectionForAdapter` answers with the row name to use for an adapter (the
 * name `credentialImportNames` keys by, so `instantiate` will resolve it).
 * An adapter with no connection here is left alone: the capture then records a
 * gap for it rather than silently pointing it at some other system's surface.
 */
export function rewriteConnectionNames(input: {
  source: string;
  connectionForAdapter: (adapter: string) => string | undefined;
}): { source: string; unresolved: Array<{ adapter: string; authored: string }> } {
  let source = input.source;
  const unresolved: Array<{ adapter: string; authored: string }> = [];
  for (const ref of referencedConstructions(input.source)) {
    if (ref.credential === undefined) continue;
    const target = input.connectionForAdapter(ref.adapter);
    if (target === undefined) {
      unresolved.push({ adapter: ref.adapter, authored: ref.credential });
      continue;
    }
    if (target === ref.credential) continue;
    // The authored spelling, not the parsed name: a backticked import must be
    // replaced backticks and all, or the braces keep a stale name.
    const backticked = `\`${ref.credential}\``;
    if (source.includes(backticked)) {
      source = source.split(backticked).join(spell(target));
    } else {
      source = source.replace(
        new RegExp(`\\b${escapeForRegExp(ref.credential)}\\b`, 'g'),
        spell(target),
      );
    }
  }
  return { source, unresolved };
}

/**
 * The constructed names the capture can actually describe on this workspace.
 *
 * A name is describable when it is a registered adapter AND the workspace can
 * supply what constructing it needs: no credential, or a connection of that
 * adapter. Anything else is out of the capture's reach by construction — a
 * plugin is not an adapter, and an adapter with no connection here (the
 * knowledge graph is optional per team) has no instance to describe; the
 * capture's own notes already report both. What stays loud is the case the
 * guard exists for: a describable adapter that the capture nevertheless failed
 * to produce a schema for.
 */
export function describableAdapters(input: {
  constructed: Iterable<string>;
  requiresConnection: (adapter: string) => boolean | undefined;
  hasConnection: (adapter: string) => boolean;
}): string[] {
  return [...new Set(input.constructed)].filter((adapter) => {
    const requires = input.requiresConnection(adapter);
    return requires !== undefined && (!requires || input.hasConnection(adapter));
  });
}

function described(position: PositionSchema | undefined): boolean {
  return position !== undefined && position.undescribed !== true;
}

function mergeRecords<T>(
  base: Record<string, T> | undefined,
  next: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (base === undefined) return next;
  if (next === undefined) return base;
  return { ...base, ...next };
}

/**
 * The union of two captures of the SAME instance, each demand-scoped to its own
 * source. Program-derived grafts (`refinements`, `genericLandings`) union by
 * construction: their keys are opaque tokens derived from the program text, so
 * the checker looks up only the ones its own probe minted.
 */
export function mergeInstanceSchemas(
  base: InstanceSchema | undefined,
  next: InstanceSchema,
): InstanceSchema {
  if (base === undefined) return next;

  const positions: Record<string, PositionSchema> = { ...base.positions };
  for (const [name, position] of Object.entries(next.positions)) {
    if (!described(positions[name])) positions[name] = position;
  }

  const eventNarrowingValues =
    base.eventNarrowingValues === undefined || next.eventNarrowingValues === undefined
      ? (base.eventNarrowingValues ?? next.eventNarrowingValues)
      : Object.fromEntries(
          [
            ...new Set([
              ...Object.keys(base.eventNarrowingValues),
              ...Object.keys(next.eventNarrowingValues),
            ]),
          ].map((prefix) => [
            prefix,
            {
              ...(base.eventNarrowingValues?.[prefix] ?? {}),
              ...(next.eventNarrowingValues?.[prefix] ?? {}),
            },
          ]),
        );

  const unions = mergeRecords(base.unions, next.unions);
  const unionDisplayNames = mergeRecords(base.unionDisplayNames, next.unionDisplayNames);
  const createShapes = mergeRecords(base.createShapes, next.createShapes);
  const refinements = mergeRecords(base.refinements, next.refinements);
  const genericLandings = mergeRecords(base.genericLandings, next.genericLandings);
  // Scope-invariant facts (the projection derives them from the FULL entry list,
  // never from what a scope happened to describe) — first answer wins.
  const supportsInPlaceUpdate = base.supportsInPlaceUpdate ?? next.supportsInPlaceUpdate;
  const eventPosition = base.eventPosition ?? next.eventPosition;
  const eventPositions = base.eventPositions ?? next.eventPositions;
  const eventNarrowingKeys = base.eventNarrowingKeys ?? next.eventNarrowingKeys;

  return {
    positions,
    collections: { ...base.collections, ...next.collections },
    ...(unions !== undefined ? { unions } : {}),
    ...(unionDisplayNames !== undefined ? { unionDisplayNames } : {}),
    writableRoots: { ...base.writableRoots, ...next.writableRoots },
    ...(createShapes !== undefined ? { createShapes } : {}),
    ...(supportsInPlaceUpdate !== undefined ? { supportsInPlaceUpdate } : {}),
    ...(refinements !== undefined ? { refinements } : {}),
    ...(genericLandings !== undefined ? { genericLandings } : {}),
    ...(eventPosition !== undefined ? { eventPosition } : {}),
    ...(eventPositions !== undefined ? { eventPositions } : {}),
    ...(eventNarrowingKeys !== undefined ? { eventNarrowingKeys } : {}),
    ...(eventNarrowingValues !== undefined ? { eventNarrowingValues } : {}),
  };
}
