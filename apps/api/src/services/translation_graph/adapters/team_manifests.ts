// The per-team manifest set: every static manifest plus the team's installed
// REMOTE adapters, projected into the same `AdapterManifest` shape. Shared by
// the catalog and the listen-subscription reconciler, so a remote install is
// the same kind of thing to both.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { AdapterManifest } from '../adapter';
import { listAdapterManifests } from './registry';
import { listRemoteAdapters } from './remote/store';
import { remoteAdapterManifest, RemoteAdapterManifestFile } from './remote/manifest';

/**
 * A remote slug colliding with a built-in is skipped (built-ins win —
 * resolution is local-first) with a note. A listing failure degrades to the
 * static set, also with a note.
 */
export async function teamAdapterManifests(
  teamId: TeamId,
  notes: string[],
): Promise<AdapterManifest[]> {
  const manifests = [...listAdapterManifests()];
  const staticSlugs = new Set(manifests.map((m) => m.adapterType));
  let rows;
  try {
    rows = await listRemoteAdapters({ teamId });
  } catch (err) {
    notes.push(
      `remote adapters: install listing failed (${err instanceof Error ? err.message : String(err)}) — remote installs absent from this catalog`,
    );
    return manifests;
  }
  for (const row of rows) {
    const parsed = RemoteAdapterManifestFile.safeParse(row.manifest);
    if (!parsed.success) {
      notes.push(`${row.adapter_type}: stored remote manifest is malformed — install absent from this catalog`);
      continue;
    }
    if (staticSlugs.has(parsed.data.adapterType)) {
      notes.push(
        `${parsed.data.adapterType}: a remote install collides with a built-in adapter — the built-in wins`,
      );
      continue;
    }
    manifests.push(remoteAdapterManifest(parsed.data));
  }
  return manifests;
}
