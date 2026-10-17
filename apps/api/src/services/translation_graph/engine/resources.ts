// `#resources` on an ephemeral `#extract` node.
//
// An `#extract` carries the source material it was extracted from onto
// `ephemeral.resources` (the batcher rebinds `bundle.resources`). Traversing
// `#resources` off such a node yields one ephemeral source node per resource —
// "just a source node" whose readable fields are the `Resource`'s own
// (`contentType`, `name`, `url`, `content`, `data`, `fileRef`), so an action
// can filter (`where contentType == 'application/pdf'`) and read fields off it
// (e.g. map `data` into a target field). Available ONLY on extract-produced
// nodes — a non-ephemeral position resolves `#resources` through its adapter.

import type { ResourceFilter } from 'movement-engine/public/output-v3';

import {
  isEphemeralPosition,
  makeEphemeralPosition,
  type EphemeralNode,
  type SourcePosition,
} from 'movement-engine/public/catalog';

/**
 * Resolve `#resources` off an extract node into field-readable ephemeral
 * positions, one per (filter-matching) carried resource. Returns `null` when
 * the position isn't an extract-produced ephemeral node — the caller then
 * falls back to the adapter's `getRelated('#resources')` path (real sources).
 */
export function resourcePositionsFromExtractNode(
  position: SourcePosition,
  filter?: ResourceFilter,
): EphemeralNode[] | null {
  if (!isEphemeralPosition(position)) return null;
  const node = position as EphemeralNode;
  const resources = node.resources ?? [];
  const matched = filter
    ? resources.filter((r) => resourceMatchesFilter(r, filter))
    : resources;
  return matched.map((resource, i) =>
    makeEphemeralPosition({
      // The Resource IS the field bag — `property('contentType' | 'data' | …)`
      // reads its keys directly via `readEphemeralProperty`.
      data: resource,
      originRef: {
        kind: 'resource',
        ...(typeof resource.id === 'string' ? { resourceId: resource.id } : {}),
        nodeId: `${node.originRef.nodeId}:res:${i}`,
      },
    }),
  );
}

function resourceMatchesFilter(
  resource: { type?: string; contentType?: string | null; name?: string; fileRef?: unknown },
  filter: ResourceFilter,
): boolean {
  if (filter.resourceType && resource.type !== filter.resourceType) return false;
  if (filter.mimeType && resource.contentType !== filter.mimeType) return false;
  if (filter.hasDocument && !resource.fileRef) return false;
  if (filter.namePattern) {
    const name = resource.name ?? '';
    try {
      if (!new RegExp(filter.namePattern, 'i').test(name)) return false;
    } catch {
      // Bad pattern → treat as a plain substring match rather than throwing.
      if (!name.toLowerCase().includes(filter.namePattern.toLowerCase())) return false;
    }
  }
  return true;
}
