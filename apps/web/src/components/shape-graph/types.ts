// Shape-graph primitive — public API.
//
// A `Shape` is a small graph: properties (typed slots) and edges (named
// walks to record-shaped destinations). The primitive renders the
// shape as a force-laid-out graph canvas with a sidebar inspector
// driven by the current selection, and a toolbar carrying add /
// rename / delete affordances.
//
// Two surfaces consume the primitive today:
//
//   • the generic-shape editor in the mapping editor (the side of a
//     mapping that uses `kind: 'generic'` — its in-memory contract is
//     a `GenericShape` with `properties` + `edges`).
//   • (deferred) the knowledge-base ontology page, whose node/edge
//     types are structurally the same plus uniqueness + scoping
//     annotations.
//
// The primitive is intentionally renderless on inspector content —
// each consumer supplies its own inspector renderer, so the picker
// vocabulary stays surface-specific (the generic-shape editor shows
// an ExpressionType picker; the ontology editor would show
// uniqueness + scoping).

import type { ReactNode } from 'react';

/**
 * Static value type of a property. Mirrors F2's `ExpressionType` (the
 * canonical type in `packages/movement-engine/services/translation_graph/types.ts`
 * — kept in sync via the drift-detector test in `__test__/`).
 *
 * The `file` arm renders with a distinct icon — it's a typed binary
 * handle, not a primitive scalar, and the editor treats it
 * specially when mapping into File-typed targets downstream.
 */
export type ShapePropertyType =
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'date' }
  | { kind: 'timestamp' }
  | { kind: 'json' }
  | { kind: 'file' }
  | { kind: 'enum'; values: string[] }
  | { kind: 'list'; element: ShapePropertyType }
  | { kind: 'record'; fields: Record<string, ShapePropertyType> };

/**
 * A single edge in a shape — a named walk to a record-shaped
 * destination. The `target` is itself a property type (typically a
 * `record` or `list<record>`); the primitive renders edges with
 * record destinations as edges to a clustered destination node,
 * while edges to non-record types render as labelled leaves.
 */
export interface ShapeEdge {
  target: ShapePropertyType;
}

/**
 * Top-level shape — the value the consumer hands to the primitive
 * and gets mutated copies of via `onChange`.
 */
export interface Shape {
  properties: Record<string, ShapePropertyType>;
  edges: Record<string, ShapeEdge>;
}

/**
 * Optional constraint annotations. Empty for the generic-shape
 * surface; populated for the ontology surface (uniqueness across
 * properties; scoping by edge ancestor name). The primitive does
 * not interpret these — it threads them into the inspector
 * renderer so the consumer can edit them in place.
 */
export interface ShapeConstraints {
  /** Property-level uniqueness — a list of property-name tuples;
   *  each tuple denotes an AND-of properties that together
   *  uniquely identify a record of this shape. OR semantics across
   *  the outer list. */
  uniqueness?: ReadonlyArray<ReadonlyArray<string>>;
  /** Edge names that scope this shape — the shape's identity is
   *  qualified by the tuple of ancestors reached via these edges.
   *  Ontology compound scoping uses this; generic shapes leave it
   *  empty. */
  scopingEdges?: ReadonlyArray<string>;
}

/**
 * What the user has selected on the canvas. The inspector is
 * rendered against this — each surface knows how to render an
 * editor for its own kinds of selection.
 *
 * Edge selections decompose into either the edge itself (rename /
 * delete / cardinality / target type) or its target's nested
 * fields (when the target is a `record`).
 */
export type ShapeSelection =
  | { kind: 'none' }
  | { kind: 'property'; name: string }
  | { kind: 'edge'; name: string }
  | { kind: 'edge-target-field'; edgeName: string; path: ReadonlyArray<string> };

/**
 * Render-prop contract for the inspector. The primitive renders
 * the selection card frame; the consumer fills the body. Receiving
 * both the shape and the selection lets the consumer read the
 * relevant property / edge directly without juggling refs.
 *
 * `applyShape` is the consumer's write path. The primitive does
 * not mutate the shape in place — every edit (toolbar or inspector)
 * computes a new shape and calls `onChange`. The inspector's
 * `applyShape` is the same write hook.
 */
export interface ShapeInspectorRenderProps {
  shape: Shape;
  selection: ShapeSelection;
  constraints: ShapeConstraints;
  applyShape: (next: Shape) => void;
  applyConstraints: (next: ShapeConstraints) => void;
}

export type ShapeInspectorRenderer = (
  props: ShapeInspectorRenderProps,
) => ReactNode;

/**
 * Top-level primitive props. The consumer owns the shape (and
 * constraints, when relevant) and supplies an inspector renderer.
 * The primitive owns selection state, canvas layout, and toolbar
 * affordances.
 */
export interface ShapeEditorProps {
  shape: Shape;
  onChange: (next: Shape) => void;
  /** Optional constraint annotations. Empty object renders no
   *  constraint affordances. */
  constraints?: ShapeConstraints;
  onConstraintsChange?: (next: ShapeConstraints) => void;
  /** Inspector renderer. Receives the current selection + shape;
   *  returns the inspector body. The primitive frames it in the
   *  sidebar. */
  renderInspector: ShapeInspectorRenderer;
  /** Short heading shown above the canvas — e.g. "Source shape"
   *  / "Target shape" / "Ontology". Editor-facing label, jargon-free. */
  heading?: string;
  /** Subtitle / hint — e.g. "Author the in-memory contract this
   *  side produces or consumes." */
  subheading?: string;
}
