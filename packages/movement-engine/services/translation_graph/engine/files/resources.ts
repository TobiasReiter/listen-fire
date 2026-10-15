// Resource resolution over the uniform traversal path.
//
// Resources are reached as "just an edge" (P1/P12): a resource-bearing type
// declares a reserved `RESOURCES_REFERENCE_FIELD_ID` reference in `describe`,
// and the adapter resolves it via `getRelated` to resource positions — each
// `position.data` carrying a `Resource` (FILE resources carry a `fileRef`).
//
// This module is the single engine-side helper that both the `#resources`
// meta-edge and the `resource_traverse` expression call. It replaces the
// retired `Adapter.getResources` bespoke method: the body that used to live in
// each adapter's `getResources` now lives in its `getRelated` branch for this
// reference, and the engine applies the author-supplied `ResourceFilter`
// post-hoc (the same loose filter every adapter's old `getResources` applied).
//
// Resource as a node
// Reading a resource

import type {
  Adapter,
  Resource,
  ResourceFilter,
} from '../../adapter';
import type { SourcePosition } from '../../types';

import { fileValueOf, RESOURCES_REFERENCE_FIELD_ID } from '../../adapter';
import { positionData } from '../../types';

/**
 * Resolve the resources attached to a source position by traversing the
 * reserved resources reference via `getRelated`, then applying the author's
 * `ResourceFilter`. Each related position carries a `Resource` on its `data`.
 *
 * Returns the `Resource` values (not positions) so the existing `resource`
 * expression — which binds `ctx.currentResource` and reads fields off it —
 * works unchanged.
 */
export async function resolvePositionResources(input: {
  adapter: Adapter;
  position: SourcePosition;
  filter?: ResourceFilter;
  /** Fresh ids for the resources that carry none (`stampResourceIds`). */
  mintIds: MintIds;
}): Promise<Resource[]> {
  const related = await input.adapter.getRelated({
    position: input.position,
    fieldId: RESOURCES_REFERENCE_FIELD_ID,
    direction: 'outgoing',
  });
  const resources = related
    .map((r) => positionData(r.position) as Resource | null | undefined)
    .filter((r): r is Resource => r != null)
    .map(withResourceFile);
  return (await stampResourceIds(resources, input.mintIds)).filter((r) => matchesResourceFilter(r, input.filter));
}

/**
 * A resource as the run holds it: its `fileRef` slot is typed, so whatever
 * descriptor it holds is the resource's file, made one here (and so is its
 * `data.file`, the same file as the resource's fields expose it). A slot that
 * spells no descriptor is dropped rather than carried as a file. Nothing else
 * in the resource is ever a file, whatever its keys.
 */
export function withResourceFile(resource: Resource): Resource {
  if (resource.fileRef === undefined) return resource;
  const file = fileValueOf(resource.fileRef);
  if (file === undefined) {
    const { fileRef: _dropped, ...rest } = resource;
    return rest;
  }
  const data = resource.data !== undefined && Object.hasOwn(resource.data, 'file') ? { ...resource.data, file } : resource.data;
  // In the resource's own key order: each slot keeps its place.
  return { ...resource, fileRef: file, ...(data !== undefined ? { data } : {}) };
}

/** `count` fresh ids. */
export type MintIds = (count: number) => Promise<string[]>;

/**
 * Materialisation boundary for resource identity (`4d_resources.md`:
 * "the engine stamps it"). A resource entering the run gets a stable
 * internal id so the same handle carries one identity to every node it
 * contributes to and the target adapter has a non-external id to persist /
 * dedup on. Resources that already carry an `id` (e.g. KG's
 * `public.resource.id`) pass through untouched. The ids come from `mint` —
 * in a run, the host's (`ids.mint`), so a recorded run replays to the same
 * ids — all of them in one request.
 */
export async function stampResourceIds(resources: readonly Resource[], mint: MintIds): Promise<Resource[]> {
  const unstamped = resources.filter((resource) => !resource.id).length;
  if (unstamped === 0) return [...resources];
  const ids = await mint(unstamped);
  let next = 0;
  return resources.map((resource) => (resource.id ? resource : { ...resource, id: ids[next++] }));
}

/**
 * Best-effort `ResourceFilter` match — the same loose semantics every
 * adapter's former `getResources` applied (type / mimeType / namePattern /
 * hasDocument). Centralised here now that filtering moved off the adapters.
 */
export function matchesResourceFilter(
  resource: Resource,
  filter: ResourceFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.resourceType && resource.type !== filter.resourceType) return false;
  if (filter.mimeType && resource.contentType !== filter.mimeType) return false;
  if (filter.hasDocument && !resource.url) return false;
  if (filter.namePattern) {
    const re = safeRegex(filter.namePattern);
    if (re && !re.test(String(resource.name ?? ''))) return false;
  }
  return true;
}

function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}
