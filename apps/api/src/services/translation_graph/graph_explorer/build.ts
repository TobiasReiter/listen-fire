// What the graph explorer needs BEFORE it can walk: which systems a team can
// stand on at all, and the handful of verified footnotes worth pinning to one.
//
// Enumeration only. The graph itself is never built here — it is walked, one
// hop per call, by `interfaces/trpc/views/graphExplorer.ts` through the same
// `walkFrom` the authoring agent's `describeConnection` uses. This file used to
// hold a SECOND walker (its own hop budgets, its own describe sweeps) that
// assembled a whole node+edge graph up front; that mechanism is deleted, along
// with the static-map CLI it existed to feed.

import type { TeamId } from '../../../generated/kysely/core/Team';

import { getAutomationsQb } from '../../../lib/kysely';
import { listAdapterCapabilities } from '../adapters/registry';

export const PER_ADAPTER_TIMEOUT_MS = 20_000;

/**
 * Verified facts worth pinning to a system — answers to "is this rendering
 * honest?" questions that the live output alone cannot settle.
 * Keep each entry short and evidence-backed (file + reason).
 */
export const SYSTEM_FOOTNOTES: Record<string, string> = {
  affinity:
    'Why List Entry shows few/no fields — verified 2026-07-17: the generic ' +
    '`List Entry` type is GENUINELY field-less by the adapter’s model. Affinity ' +
    'field values are list-scoped, so the unpinned type has no intrinsic fields ' +
    '(schema_catalog.ts: LIST_ENTRY_BUILTINS = [] and custom fields resolve only ' +
    'once a list is pinned); its only facts are the organization/person up-edges. ' +
    'A pinned type (`List Entry — Pipeline`) DOES describe the list-scoped ' +
    'fields — it previously showed 0 because the fake-channels seed carried no ' +
    'list-scoped fields (all list_id: null), a seeding gap, not an adapter fact. ' +
    'The seed now includes three Pipeline-scoped fields (Deal Stage / Deal Size / ' +
    'Next Step), so what renders here is the real describe surface.',
};

export function timeboxed<T>(work: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`${label}: timed out after ${PER_ADAPTER_TIMEOUT_MS}ms`)),
        PER_ADAPTER_TIMEOUT_MS,
      );
      t.unref();
    }),
  ]);
}

/** A system a team can stand on: a connected adapter, or an installed remote. */
export interface ExplorerInstance {
  adapterType: string;
  displayName: string;
  /** Credential used to construct the instance; null = credential-free. */
  credential: { id: string; name: string; type: string } | null;
  remote: boolean;
}

export async function enumerateSystems(teamId: TeamId): Promise<ExplorerInstance[]> {
  const credentials = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', teamId)
    .select(['id', 'name', 'type', 'created_at'])
    .orderBy('created_at', 'desc')
    .execute();
  const newestByType = new Map<string, { id: string; name: string; type: string }>();
  for (const row of credentials) {
    if (!newestByType.has(row.type)) {
      newestByType.set(row.type, { id: row.id, name: row.name, type: row.type });
    }
  }

  const systems: ExplorerInstance[] = [];
  for (const cap of listAdapterCapabilities()) {
    const credential =
      cap.requiredCredentialType === null
        ? null
        : (newestByType.get(cap.requiredCredentialType) ?? undefined);
    if (credential === undefined) continue; // needs a credential the team lacks
    systems.push({
      adapterType: cap.adapterType,
      displayName: cap.displayName,
      credential,
      remote: false,
    });
  }

  const remoteRows = await getAutomationsQb(['remote_adapter'])
    .selectFrom('remote_adapter')
    .where('team_id', '=', teamId)
    .select(['adapter_type', 'credentials_id'])
    .execute()
    .catch(() => []);
  for (const row of remoteRows) {
    const credential = credentials.find((c) => c.id === row.credentials_id);
    systems.push({
      adapterType: row.adapter_type,
      displayName: `${row.adapter_type} (remote)`,
      credential: credential
        ? { id: credential.id, name: credential.name, type: credential.type }
        : null,
      remote: true,
    });
  }

  return systems.sort((a, b) => a.adapterType.localeCompare(b.adapterType));
}
