// The per-team manifest set: every static manifest plus the team's installed
// REMOTE adapters, projected into the same `AdapterManifest` shape. Shared by
// the catalog and the listen-subscription reconciler, so a remote install is
// the same kind of thing to both.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { AdapterManifest } from '../adapter';
import { listAdapterManifests } from './registry';
import { listRemoteAdapters } from './remote/store';
import { remoteAdapterManifest, RemoteAdapterManifestFile } from './remote/manifest';
import { mayBeRemoteSlug } from './remote/slugs';

/** The per-team manifests, and whether the remote half is complete. */
export interface TeamManifestSet {
  manifests: AdapterManifest[];
  /** Slugs of the remote installs that made it into `manifests`. */
  remoteSlugs: ReadonlySet<string>;
  /** True when some remote install could not be read (the listing failed, or
   *  a stored manifest would not parse): an absent remote manifest then says
   *  nothing about whether that install still exists. */
  remoteDegraded: boolean;
}

/**
 * A remote slug colliding with any name a built-in answers to (`remote/slugs`)
 * is skipped (built-ins win — resolution is local-first) with a note. A listing failure degrades to the
 * static set, also with a note, and is reported as `remoteDegraded`.
 */
export async function teamAdapterManifestSet(teamId: TeamId, notes: string[]): Promise<TeamManifestSet> {
  const manifests = [...listAdapterManifests()];
  const remoteSlugs = new Set<string>();
  let rows;
  try {
    rows = await listRemoteAdapters({ teamId });
  } catch (err) {
    notes.push(
      `remote adapters: install listing failed (${err instanceof Error ? err.message : String(err)}) — remote installs absent from this catalog`,
    );
    return { manifests, remoteSlugs, remoteDegraded: true };
  }
  let remoteDegraded = false;
  for (const row of rows) {
    const parsed = RemoteAdapterManifestFile.safeParse(row.manifest);
    if (!parsed.success) {
      notes.push(`${row.adapter_type}: stored remote manifest is malformed — install absent from this catalog`);
      remoteDegraded = true;
      continue;
    }
    if (!mayBeRemoteSlug(parsed.data.adapterType)) {
      notes.push(
        `${parsed.data.adapterType}: a remote install collides with a name a built-in adapter answers to — the built-in wins`,
      );
      continue;
    }
    manifests.push(remoteAdapterManifest(parsed.data));
    remoteSlugs.add(parsed.data.adapterType);
  }
  return { manifests, remoteSlugs, remoteDegraded };
}

export async function teamAdapterManifests(
  teamId: TeamId,
  notes: string[],
): Promise<AdapterManifest[]> {
  return (await teamAdapterManifestSet(teamId, notes)).manifests;
}
