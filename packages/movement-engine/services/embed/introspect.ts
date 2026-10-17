// What an embedder's catalog reads of a live adapter: its entry points and
// each one's descriptor, projected into the checker's instance schema. The
// hosted product caches this per install (instance_cache.ts) and lf asks each
// external the same two questions (crates/lf check.rs); an embedder asks
// them of the adapter it loaded in process.

import type { InstanceSchema } from 'movement-lang';

import type { Adapter, AdapterManifest } from '../translation_graph/adapter';
import { instanceSchemaFromDescriptors } from '../translation_graph/movement/schema_projection';

/** The instance schema `adapter` answers today, with the projection's notes
 *  (a name two entries share, a type it could not describe). */
export async function introspectAdapter(
  adapter: Adapter,
  manifest: Pick<AdapterManifest, 'adapterType' | 'methods'>,
): Promise<{ schema: InstanceSchema; notes: string[] }> {
  const entries = await adapter.listEntryPoints();
  const described = await Promise.all(entries.map(async (entry) => [entry.typeId, await adapter.describe(entry.typeId)] as const));
  const descriptors = new Map(described.flatMap(([typeId, descriptor]) => (descriptor ? [[typeId, descriptor] as const] : [])));
  return instanceSchemaFromDescriptors({
    adapterType: manifest.adapterType,
    entries,
    descriptors,
    supportsInPlaceUpdate: (manifest.methods ?? []).includes('updateRecord'),
    edgesCarryProperties: adapter.runtimeCapabilities().traversal.edgeProperties,
  });
}
