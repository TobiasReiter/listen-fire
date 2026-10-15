/**
 * Resolve author-friendly ontology names → real DB UUIDs in a
 * `TranslationGraphRowBody`.
 *
 * Background — R14 of plans/2026-05-19-tg-extraction-parity/:
 * fixtures author TGs against the in-tree VC template, referencing node
 * types / properties / edges by their template keys (`opportunity`,
 * `company`, `participants`, …). The KnowledgeGraphAdapter, however,
 * casts `targetTypeRef` (and friends) straight to branded NodeTypeId
 * UUIDs and forwards them to Postgres. Without a substitution step the
 * extract phase blows up with "invalid input syntax for type uuid".
 *
 * This walker performs the substitution at seed time — wave-1 only.
 * Wave-3 will land author-by-name at runtime (eventual story); for now
 * we keep persisted bodies UUID-canonical.
 *
 * Substituted positions (per R14 brief):
 *   - ActionNode.targetTypeRef                  → NodeTypeId UUID
 *   - TGFieldMapping.targetField                → PropertyTypeId UUID, scoped to the
 *                                                  enclosing action's targetTypeRef
 *   - Expression { type: 'property', propertyTypeId } in uniquenessConstraints
 *                                               → PropertyTypeId UUID, scoped likewise
 *   - NodeRelationship.edgeName                 → EdgeType display name (outbound_name
 *                                                  by default, inbound_name when the
 *                                                  relationship carries direction: 'inbound').
 *                                                  Template keys are lowercase
 *                                                  (`participants`); the KG adapter resolves
 *                                                  by display name (`Participants`), so we
 *                                                  rewrite to the canonical display name.
 *
 * Untouched positions (per R14 brief):
 *   - MetaEdgeStep.alias                        — TG-local alias
 *   - EdgeToConstraintEntry.ancestorName        — TG-local ancestor name
 *   - aliasRoot-rooted traversals               — generic-source references, not KG
 *
 * The walker does not mutate its input; it returns a new body.
 */

import type {
  ActionNode,
  ChildEdge,
  NodeRelationship,
  TGFieldMapping,
  TranslationGraphNode,
  TranslationGraphRowBody,
} from 'movement-engine/services/translation_graph/types';
import type { Expression } from 'movement-engine/services/knowledge_pipeline/output_v3/expression';

export type OntologyMaps = {
  /** Template node-type key (e.g. `opportunity`) → DB UUID. */
  nodeTypeKeyToId: Map<string, string>;
  /** Composite key `${nodeTypeKey}.${propertyKey}` → DB UUID. */
  propertyKeyToId: Map<string, string>;
  /** Template edge-type key (e.g. `participants`) → DB UUID. The persisted
   *  edgeName is rewritten to the display name (see
   *  `edgeKeyToDisplayNames`); the id map remains for callers that want
   *  to validate references early. */
  edgeKeyToId: Map<string, string>;
  /** Template edge-type key → display names. The KG adapter resolves
   *  edges by display name (`edge_type.outbound_name` /
   *  `edge_type.inbound_name`), so the resolver substitutes
   *  `nodeRelationship.edgeName` from the template key (lowercase) to
   *  the corresponding display name. Outbound is the common case;
   *  inbound is used when the relationship is explicitly inverse. */
  edgeKeyToDisplayNames?: Map<
    string,
    { outboundName: string; inboundName: string }
  >;
  /** Reserved targetTypeRef values that should never be substituted —
   *  used by the input-mapping side (`__generic_root__`,
   *  `__generic_record__`, …). */
  passThroughTypeRefs?: ReadonlySet<string>;
};

/** Verify every reference resolves; collect a report instead of throwing
 *  on the first miss so seed runs surface every mismatch at once. */
type ResolutionDiagnostic = {
  path: string;
  message: string;
};

export function resolveOntologyNamesInBody(
  body: TranslationGraphRowBody,
  maps: OntologyMaps,
): TranslationGraphRowBody {
  const diagnostics: ResolutionDiagnostic[] = [];
  const passThrough = maps.passThroughTypeRefs ?? new Set<string>();

  const ctx: WalkContext = {
    maps,
    passThrough,
    diagnostics,
  };

  const roots = body.roots.map((root, i) => walkNode(root, ctx, `roots[${i}]`));

  if (diagnostics.length > 0) {
    const lines = diagnostics.map((d) => `  - ${d.path}: ${d.message}`);
    throw new Error(
      `resolveOntologyNamesInBody: unresolved references:\n${lines.join('\n')}`,
    );
  }

  return { ...body, roots };
}

// ── Internals ─────────────────────────────────────────────────────────────

type WalkContext = {
  maps: OntologyMaps;
  passThrough: ReadonlySet<string>;
  diagnostics: ResolutionDiagnostic[];
};

function walkNode(
  node: TranslationGraphNode,
  ctx: WalkContext,
  path: string,
): TranslationGraphNode {
  if (node.kind === 'branch') {
    return {
      ...node,
      match: node.match ? walkNode(node.match, ctx, `${path}.match`) : undefined,
      noMatch: node.noMatch ? walkNode(node.noMatch, ctx, `${path}.noMatch`) : undefined,
    };
  }
  return walkAction(node, ctx, path);
}

function walkAction(
  action: ActionNode,
  ctx: WalkContext,
  path: string,
): ActionNode {
  // 1. Resolve targetTypeRef (or pass through).
  const resolvedTypeRef = resolveTargetTypeRef(action.targetTypeRef, ctx, `${path}.targetTypeRef`);
  // Track the *template key* used for child property lookups even after
  // the ref is substituted to its UUID. If the ref was passed through
  // (generic record), there's no key context for property resolution —
  // we leave properties on this action untouched.
  const propertyCtxKey = ctx.passThrough.has(action.targetTypeRef)
    ? null
    : action.targetTypeRef;

  // 2. fieldMappings.
  const fieldMappings = action.fieldMappings.map((fm, i) =>
    walkFieldMapping(fm, ctx, propertyCtxKey, `${path}.fieldMappings[${i}]`),
  );

  // 3. uniquenessConstraints — substitute each entry's `field` (a property
  //    template key) for its resolved id, scoped to this action's node-type.
  const uniquenessConstraints = action.uniquenessConstraints
    ? {
        any: action.uniquenessConstraints.any.map((branch, ci) => ({
          all: branch.all.map((entry, ei) => ({
            ...entry,
            field:
              propertyCtxKey === null
                ? entry.field
                : resolveProperty(
                    entry.field,
                    propertyCtxKey,
                    ctx,
                    `${path}.uniquenessConstraints.any[${ci}].all[${ei}].field`,
                  ),
          })),
        })),
      }
    : undefined;

  // 4. children with relationship.edgeName.
  const children = action.children.map((child, i) =>
    walkChild(child, ctx, `${path}.children[${i}]`),
  );

  // 5. Action-level traversal (top-level `traversal: [...]`) — these are
  //    EdgeStep / MetaEdgeStep entries. We don't substitute edge IDs in
  //    the persisted body for now (engine resolves by name at runtime).
  //    Pass through.
  const traversal = action.traversal;

  return {
    ...action,
    targetTypeRef: resolvedTypeRef,
    traversal,
    fieldMappings,
    children,
    ...(uniquenessConstraints ? { uniquenessConstraints } : {}),
  };
}

function walkChild(child: ChildEdge, ctx: WalkContext, path: string): ChildEdge {
  return {
    relationship: walkRelationship(child.relationship, ctx, `${path}.relationship`),
    node: walkNode(child.node, ctx, `${path}.node`),
  };
}

function walkRelationship(
  rel: NodeRelationship,
  ctx: WalkContext,
  path: string,
): NodeRelationship {
  if (!rel.edgeName) return rel;
  // Validate the edge exists by template key.
  const resolved = ctx.maps.edgeKeyToId.get(rel.edgeName);
  if (!resolved) {
    ctx.diagnostics.push({
      path,
      message: `unknown edge "${rel.edgeName}"`,
    });
    return rel;
  }
  // Substitute the template key (e.g. `participants`) with the
  // EdgeType's display name (e.g. `Participants`). The KG adapter
  // resolves edges by display name, matching how the editor stores
  // them (right-panel.tsx:2905-2907). Direction defaults to outbound
  // (the common case); if the relationship carries an explicit
  // `direction: 'inbound'` flag we use the inbound name instead.
  const displayNames = ctx.maps.edgeKeyToDisplayNames?.get(rel.edgeName);
  if (!displayNames) return rel;
  const direction = (rel as { direction?: 'outbound' | 'inbound' }).direction;
  const resolvedName =
    direction === 'inbound' ? displayNames.inboundName : displayNames.outboundName;
  return { ...rel, edgeName: resolvedName };
}

function walkFieldMapping(
  fm: TGFieldMapping,
  ctx: WalkContext,
  propertyCtxKey: string | null,
  path: string,
): TGFieldMapping {
  const targetField =
    propertyCtxKey === null
      ? fm.targetField
      : resolveProperty(fm.targetField, propertyCtxKey, ctx, `${path}.targetField`);

  const expression = fm.expression
    ? walkExpression(fm.expression, ctx, propertyCtxKey, `${path}.expression`)
    : fm.expression;

  return {
    ...fm,
    targetField,
    expression,
  };
}

function walkExpression(
  expr: Expression,
  ctx: WalkContext,
  propertyCtxKey: string | null,
  path: string,
): Expression {
  switch (expr.type) {
    case 'property': {
      if (propertyCtxKey === null) return expr;
      return {
        ...expr,
        propertyTypeId: resolveProperty(
          expr.propertyTypeId,
          propertyCtxKey,
          ctx,
          `${path}.propertyTypeId`,
        ),
      };
    }
    case 'traverse': {
      // aliasRoot-rooted traversals walk a non-KG source (generic shape /
      // upstream input TG). Leave them — and everything underneath them —
      // untouched.
      if (expr.aliasRoot !== undefined) return expr;
      // Traversal steps are passed through verbatim. MetaEdgeStep.alias
      // and its config sub-expressions belong to the alias context the
      // engine builds at runtime; they aren't KG-bound positions.
      return {
        ...expr,
        expression: walkExpression(
          expr.expression,
          ctx,
          propertyCtxKey,
          `${path}.expression`,
        ),
      };
    }
    case 'function':
      return {
        ...expr,
        args: expr.args.map((a, i) =>
          walkExpression(a, ctx, propertyCtxKey, `${path}.args[${i}]`),
        ),
      };
    case 'arithmetic':
    case 'compare':
      return {
        ...expr,
        left: walkExpression(expr.left, ctx, propertyCtxKey, `${path}.left`),
        right: walkExpression(expr.right, ctx, propertyCtxKey, `${path}.right`),
      };
    case 'logical':
      return {
        ...expr,
        operands: expr.operands.map((o, i) =>
          walkExpression(o, ctx, propertyCtxKey, `${path}.operands[${i}]`),
        ),
      };
    case 'not':
    case 'negate':
      return {
        ...expr,
        expression: walkExpression(expr.expression, ctx, propertyCtxKey, `${path}.expression`),
      };
    case 'concat':
      return {
        ...expr,
        parts: expr.parts.map((p, i) =>
          walkExpression(p, ctx, propertyCtxKey, `${path}.parts[${i}]`),
        ),
      };
    case 'conditional':
      return {
        ...expr,
        condition: walkExpression(expr.condition, ctx, propertyCtxKey, `${path}.condition`),
        then: walkExpression(expr.then, ctx, propertyCtxKey, `${path}.then`),
        else: walkExpression(expr.else, ctx, propertyCtxKey, `${path}.else`),
      };
    case 'at':
      return {
        ...expr,
        expression: walkExpression(expr.expression, ctx, propertyCtxKey, `${path}.expression`),
        index: walkExpression(expr.index, ctx, propertyCtxKey, `${path}.index`),
      };
    case 'aggregate':
      return {
        ...expr,
        expression: walkExpression(expr.expression, ctx, propertyCtxKey, `${path}.expression`),
      };
    case 'list':
      return {
        ...expr,
        elements: expr.elements.map((el, i) =>
          el.type === 'spread'
            ? { ...el, expression: walkExpression(el.expression, ctx, propertyCtxKey, `${path}.elements[${i}].expression`) }
            : walkExpression(el, ctx, propertyCtxKey, `${path}.elements[${i}]`),
        ),
      };
    case 'object':
      return {
        ...expr,
        entries: expr.entries.map((entry, i) =>
          'type' in entry
            ? { ...entry, expression: walkExpression(entry.expression, ctx, propertyCtxKey, `${path}.entries[${i}].expression`) }
            : { ...entry, value: walkExpression(entry.value, ctx, propertyCtxKey, `${path}.${entry.key}`) },
        ),
      };
    case 'exists':
      return {
        ...expr,
        where: expr.where
          ? walkExpression(expr.where, ctx, propertyCtxKey, `${path}.where`)
          : expr.where,
      };
    case 'resource_traverse':
      return {
        ...expr,
        expression: walkExpression(expr.expression, ctx, propertyCtxKey, `${path}.expression`),
      };
    // Leaves with no nested references / aliases-only:
    case 'edge_property':
    case 'static':
    case 'llm':
    case 'meta':
    case 'parent_result':
    case 'action_result':
    case 'resource':
    case 'linked_object':
    case 'extract_value':
    case 'alias_ref':
    case 'kg_exists':
    case 'kg_value':
      return expr;
    default: {
      // Exhaustiveness guard — types added later will surface here.
      const _exhaustive: never = expr;
      void _exhaustive;
      return expr;
    }
  }
}

function resolveTargetTypeRef(
  ref: string,
  ctx: WalkContext,
  path: string,
): string {
  if (ctx.passThrough.has(ref)) return ref;
  const id = ctx.maps.nodeTypeKeyToId.get(ref);
  if (!id) {
    ctx.diagnostics.push({ path, message: `unknown node-type key "${ref}"` });
    return ref;
  }
  return id;
}

function resolveProperty(
  propertyKey: string,
  nodeTypeKey: string,
  ctx: WalkContext,
  path: string,
): string {
  const composite = `${nodeTypeKey}.${propertyKey}`;
  const id = ctx.maps.propertyKeyToId.get(composite);
  if (!id) {
    ctx.diagnostics.push({
      path,
      message: `unknown property "${propertyKey}" on node type "${nodeTypeKey}"`,
    });
    return propertyKey;
  }
  return id;
}
