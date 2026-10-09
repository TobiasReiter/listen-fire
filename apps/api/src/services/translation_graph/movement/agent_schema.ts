import { edgeIsReadable, edgeIsWritable } from 'movement-lang';

import type { EdgeSchema, InstanceSchema, WritableRootSchema } from 'movement-lang';

// An `EdgeSchema`'s two promises are stored sparsely, and they default OPPOSITE
// ways: `readable` absent means readable (only a write-only edge opts out),
// while `writable` absent means READ-ONLY — the write promise is explicit, so
// silence is the safe answer, never an affirmative claim. That is ergonomic for
// adapter authors but leaves an agent reading a described instance to apply a
// rule it has to know. So at the describe boundary we fill the two booleans
// explicitly: the agent reads truth.
//
// Both answers come from the SAME predicates the checker's write gate and read
// traversal ask (`edgeIsWritable` / `edgeIsReadable`), because describe saying
// an edge is writable and the checker then refusing the write is the worst of
// the two failures: the authoring agent writes the movement, and only the run
// finds out. They cannot disagree if there is only one answer.
//
// This is a WIRE-level pass, deliberately kept off the shared projection: the
// `InstanceSchema` handed to `describeMovementInstance` is the SAME TTL-cached
// object the compile/checker path consumes, where absent-vs-present is
// load-bearing. So every level this touches is reconstructed — the cached
// input is never mutated.

function withEdgeDefaults(edges: Record<string, EdgeSchema>): Record<string, EdgeSchema> {
  return Object.fromEntries(
    Object.entries(edges).map(([name, edge]) => [
      name,
      { ...edge, readable: edgeIsReadable(edge), writable: edgeIsWritable(edge) },
    ]),
  );
}

function normaliseRoot(root: WritableRootSchema): WritableRootSchema {
  return root.edges === undefined ? root : { ...root, edges: withEdgeDefaults(root.edges) };
}

function normaliseRoots(
  roots: Record<string, WritableRootSchema>,
): Record<string, WritableRootSchema> {
  return Object.fromEntries(Object.entries(roots).map(([name, root]) => [name, normaliseRoot(root)]));
}

/**
 * Return an agent-facing copy of a described instance's schema with every
 * edge's `readable`/`writable` resolved to its concrete value. Entry-point
 * writability already ships explicitly on the walked node, and a field's
 * read/write is encoded structurally (`properties` vs `writableRoots.fields`
 * vs `writeOnlyProperties`); edges are the one slot where the default is left
 * implicit, so they are all this pass fills.
 */
export function normaliseSchemaForAgent(schema: InstanceSchema): InstanceSchema {
  return {
    ...schema,
    positions: Object.fromEntries(
      Object.entries(schema.positions).map(([name, position]) => [
        name,
        { ...position, edges: withEdgeDefaults(position.edges) },
      ]),
    ),
    writableRoots: normaliseRoots(schema.writableRoots),
    ...(schema.createShapes === undefined ? {} : { createShapes: normaliseRoots(schema.createShapes) }),
  };
}
