// Structural conformance — the ONE comparator.
//
// "Does this position carry everything that structure declares?" is asked in
// three places now, and it is the same question every time: a node literal
// reaching a declared parameter (wave 1), a call's value reaching one (layer
// 10 §A), and an `IS <Doc>` predicate (layer 10 §D). So the rule lives here,
// once, phrased over what a position OFFERS rather than over how it was
// minted — a synthesised landing and an adapter-backed one are compared by the
// same code because a type IS its structure, whoever made it.
//
// It is TypeScript's structural assignability, unchanged: every member the
// required side declares must be present and compatible; extra members are
// fine (the required side cannot see them).

import type { ShapeDeclaration, ShapeNode } from '../parser/ast';
import {
  describeFieldType,
  parseFieldTypeName,
  type PositionSchema,
  surfaceNotEnumerated,
  type FieldType,
  type InstanceSchema,
  type SchemaFieldType,
} from './catalog';
import { fieldAssignable, maybeAbsent, stripAbsent } from './typing';
import type { LanguageVersion } from '../language_version';
import { spellCode } from '../parser/surface';

/**
 * Derives the same schema shape adapters publish for an in-file node declaration.
 *
 * A declaration is a TREE, so a position's identity is its PATH from the root
 * (`doc`, `doc.file`) — two siblings may each declare a `file` child and mean
 * different structures. The root's key is the declaration's own name, which is
 * what `<doc>` resolves to: the declaration IS its root node.
 *
 * Shared with the engine, so a `<Doc>` predicate is compared against the same
 * structure at run time that it was checked against.
 */
export function shapeToSchema(
  decl: ShapeDeclaration,
  /** Resolves an annotation naming an author-declared refinement
   *  (`type Thesis = <"A" | "B">`). Both sides pass it, so the schema stays
   *  the same one on either side of the save. */
  resolveDeclaredType?: (name: string) => SchemaFieldType | undefined,
): InstanceSchema {
  const schema: InstanceSchema = { positions: {}, collections: {}, writableRoots: {} };
  const add = (node: ShapeNode, key: string): void => {
    const properties: Record<string, SchemaFieldType> = {};
    for (const field of node.fields) {
      // Unknown surface type names degrade to text rather than dropping the
      // field (a dropped field would false-positive every write to it).
      const named = parseFieldTypeName(field.type) ?? resolveDeclaredType?.(field.type) ?? 'text';
      // `<T | null>` is `T | absent` wherever the declaration is used — a
      // parameter, a collecting node's entries, `IS`, a spread — not only as
      // an extraction's shape: the engine holds null there in every case.
      properties[field.name] = field.nullable === true ? (maybeAbsent(named) ?? named) : named;
    }
    const edges: PositionSchema['edges'] = {};
    for (const child of node.children) {
      // The nesting IS the edge, and the nested node's name IS the edge name.
      // `order by <sequencing>` after the child's `}` is the author's own
      // sequencing claim, reaching the set/list split by the one road every
      // other claim takes (`EdgeSchema.sequenced`, which `hopOrdering` reads).
      edges[child.name] = {
        target: `${key}.${child.name}`,
        writable: true,
        ...(child.sequenced !== undefined ? { sequenced: child.sequenced } : {}),
      };
    }
    schema.positions[key] = { properties, edges };
    schema.writableRoots[key] = { fields: properties, resultShape: properties };
    schema.collections[key] = { target: key };
    for (const child of node.children) add(child, `${key}.${child.name}`);
  };
  add(decl.root, decl.name);
  return schema;
}

/**
 * `node X extends Y { … }` as the tree it stands for: Y's fields and nested
 * nodes, then X's own — exactly the declaration an author could have written
 * out inline. `base` is Y already resolved (its own base folded in). Words X
 * gives the record replace Y's; without them X keeps Y's.
 *
 * The inherited words stay the ones Y's file wrote, and they mean what they
 * mean THERE: a reader that evaluates them (the engine's extraction spec)
 * walks the chain rather than reading them off this tree.
 */
export function inheritDeclaration(decl: ShapeDeclaration, base: ShapeDeclaration): ShapeDeclaration {
  const description = decl.root.description ?? base.root.description;
  return {
    kind: 'shape',
    name: decl.name,
    root: {
      name: decl.root.name,
      ...(description !== undefined ? { description } : {}),
      fields: [...base.root.fields, ...decl.root.fields],
      children: [...base.root.children, ...decl.root.children],
      span: decl.root.span,
    },
    ...(decl.exported === true ? { exported: true } : {}),
    span: decl.span,
  };
}

/**
 * `node X extends Y`'s schema: X's own (`shapeToSchema` of X as parsed) with
 * Y's folded under X's name. `base` is Y's schema resolved where Y was
 * DECLARED, so an inherited field keeps the type Y's file gave it whichever
 * file X sits in. Y's positions are re-keyed from `Y…` to `X…` (a key is the
 * path from the root, and the root is now X), and X's root carries Y's fields
 * and edges ahead of its own.
 */
export function inheritSchema(
  own: InstanceSchema,
  name: string,
  base: { name: string; schema: InstanceSchema },
): InstanceSchema {
  const rekey = (key: string): string =>
    key === base.name ? name : key.startsWith(`${base.name}.`) ? `${name}${key.slice(base.name.length)}` : key;
  const schema: InstanceSchema = { positions: {}, collections: {}, writableRoots: {} };
  const put = (key: string, position: PositionSchema): void => {
    schema.positions[key] = position;
    schema.writableRoots[key] = { fields: position.properties, resultShape: position.properties };
    schema.collections[key] = { target: key };
  };
  for (const [key, position] of Object.entries(base.schema.positions)) {
    const edges = Object.fromEntries(
      Object.entries(position.edges).map(([edge, schemaEdge]) => [
        edge,
        { ...schemaEdge, target: rekey(schemaEdge.target) },
      ]),
    );
    const mine = key === base.name ? own.positions[name] : undefined;
    put(rekey(key), {
      ...position,
      properties: { ...position.properties, ...mine?.properties },
      edges: { ...edges, ...mine?.edges },
    });
  }
  for (const [key, position] of Object.entries(own.positions)) {
    if (key !== name) put(key, position);
  }
  return schema;
}

/**
 * What a supplied position OFFERS, as a plane pair — the only view structural
 * comparison needs.
 *
 * Landings are THUNKS so a caller can produce a surface without walking a whole
 * graph up front, and so the two callers (the checker, over its type refs; the
 * engine, over its live bindings) can each answer the arrow plane in their own
 * currency. Recursion is driven by the REQUIRED side, so most thunks are never
 * forced.
 */
export interface SuppliedSurface {
  /** Dot plane. A name present with an `undefined` type is declared-but-untyped. */
  properties: Record<string, FieldType | undefined>;
  /** Arrow plane. A name present with an `undefined` landing is the same fact. */
  edges: Record<string, (() => SuppliedSurface | undefined) | undefined>;
}

/** The surface a published schema offers at `position` — `undefined` when
 *  nothing is enumerated behind it, which is no claim in either direction. */
export function schemaSurface(
  schema: InstanceSchema,
  position: string,
): SuppliedSurface | undefined {
  const declared = schema.positions[position];
  if (!declared || surfaceNotEnumerated(declared)) return undefined;
  return {
    properties: declared.properties,
    edges: Object.fromEntries(
      Object.entries(declared.edges).map(([name, edge]) => [
        name,
        schema.positions[edge.target] !== undefined
          ? () => schemaSurface(schema, edge.target)
          : undefined,
      ]),
    ),
  };
}

/** How `surfaceMisfit` reads the comparison. */
export interface SurfaceMisfitOptions {
  /** The program's language version: the repair a misfit suggests is spelled
   *  as it reads. */
  languageVersion: LanguageVersion;
  /** The edge path walked so far, for the message. */
  path?: string;
  /** Required positions already on the path — a cycle stops at the repeat. */
  seen?: ReadonlySet<string>;
  /** A `T | absent` member may be missing outright. A graph literal's COPY
   *  asks this: a record without the field is copied with it absent, which is
   *  what the declaration allows. A parameter does not: it reads the member. */
  absentMayBeMissing?: boolean;
}

/** Where a required structure lives — a schema and the position within it. */
export interface RequiredPosition {
  schema: InstanceSchema;
  position: string;
}

/**
 * Does `supplied` carry everything `required` declares? Recursion is driven by
 * the REQUIRED side, so `seen` guards a required graph that cycles back on
 * itself.
 *
 * Returns the first thing that doesn't fit, phrased for the author, or
 * `undefined` when it fits — and also `undefined` when there is nothing to
 * check against (an unknown supplied entry, an unenumerated required position),
 * because unknown fits anything: the same benefit of the doubt every other
 * unchecked read gets.
 */
export function surfaceMisfit(
  supplied: SuppliedSurface | undefined,
  required: RequiredPosition,
  options: SurfaceMisfitOptions,
): string | undefined {
  const { path = '', seen = new Set<string>() } = options;
  const schema = required.schema.positions[required.position];
  if (!schema || surfaceNotEnumerated(schema)) return undefined;
  if (supplied === undefined) return undefined;
  for (const [name, want] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(supplied.properties, name)) {
      if (options.absentMayBeMissing === true && typeof want === 'object' && want.kind === 'maybeAbsent') continue;
      return `it has no ${path}\`${name}\``;
    }
    const have = supplied.properties[name];
    if (have === undefined) continue;
    if (!fieldAssignable(have, want)) {
      return `its ${path}\`${name}\` is ${describeFieldType(have)}, not ${describeFieldType(want)}${textRepair(have, want, options.languageVersion)}`;
    }
  }
  for (const [name, edge] of Object.entries(schema.edges)) {
    // Edges are zero-or-more; an absent edge IS the empty set, not a missing
    // member — nothing downstream needs a presence guarantee (traversal off
    // an empty edge already runs zero times). Only a SUPPLIED edge's target
    // is checked for conformance below.
    if (!Object.hasOwn(supplied.edges, name)) continue;
    if (seen.has(edge.target)) continue;
    const landing = supplied.edges[name];
    const misfit = surfaceMisfit(
      landing?.(),
      { schema: required.schema, position: edge.target },
      { ...options, path: `${name} → `, seen: new Set([...seen, edge.target]) },
    );
    if (misfit !== undefined) return misfit;
  }
  return undefined;
}

/**
 * The repair when a number or a yes/no reaches a declared TEXT field. Text
 * does not take either as-is — which text a `TRUE` should be is the author's
 * call, not a rendering rule's — so say how to write the one they meant.
 * Empty for every other mismatch.
 */
export function textRepair(have: FieldType, want: FieldType, languageVersion: LanguageVersion): string {
  if (stripAbsent(want) !== 'text') return '';
  switch (stripAbsent(have)) {
    case 'number':
      return ' — write the text it should be: `TOSTRING(…)`';
    case 'boolean':
      return ` — write the text it should be: \`${spellCode('IF … THEN "Yes" ELSE "No" END', languageVersion)}\``;
    default:
      return '';
  }
}
