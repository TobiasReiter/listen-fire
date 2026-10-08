// Affinity TG adapter — entity resolution. Two stages, lowest-cost first
// (mirrors the Airtable adapter):
//   1. Bridge — surface any linked_object already mapping this record type.
//   2. Natural-key search — org matches by domain/name (reusing the
//      operations layer's `findMatchingOrganisation`, the same logic the v3
//      output uses); person matches by email (then a name fallback). A hit is
//      reported as a single all-exact candidate so the engine auto-matches; no
//      hit yields an empty shortlist and the engine creates.
//
// Affinity's natural keys (domain/name for orgs, email for persons) are the
// identity surface — the adapter does NOT consult author-defined constraints
// here (Affinity has no formula filter to compile them against); identity per
// adapter-minimalism is what `findMatchingOrganisation`/email matching express.

import type { AffinityOperations } from '../../../../adapters/affinity/operations';
import type {
  ResolveEntityInput,
  ResolveEntityResult,
  ExternalRecordRef,
  LinkedObjectCandidate,
} from '../../adapter';
import { AFFINITY_ADAPTER_TYPE, listEntityKind, type DecodedTypeId } from './types';
import { AFFINITY_LIST_ENTRIES_EDGE, AFFINITY_LIST_NAME_FIELD } from './schema_catalog';
import { logger } from '../../../logger';
import { isAdapterCallCeilingExceeded } from '../../segment_scope';
import { readOrgBuiltins, readPersonBuiltins } from './shared';

export async function resolveEntity(input: {
  operations: AffinityOperations;
  /** The structured id the adapter recovered from the recordType NAME via its
   *  cache; undefined for an unknown type (drift). */
  decoded: DecodedTypeId | undefined;
  resolve: ResolveEntityInput;
}): Promise<ResolveEntityResult> {
  // The bridge matches on `resolve.recordType` — the NATURAL type name, the
  // same currency the persisted `external_object_type` label carries now.
  const bridge = resolveByBridge(input.resolve);
  if (bridge) return bridge;

  if (!input.decoded) return { candidates: [] };

  if (input.decoded.entity === 'organization') {
    return resolveOrganization(input);
  }
  if (input.decoded.entity === 'person') {
    return resolvePerson(input);
  }
  if (input.decoded.entity === 'list-entry') {
    return resolveListEntry({ ...input, decoded: input.decoded });
  }
  // note / file have no independent identity to resolve — they attach to a
  // parent, and re-asserting one appends. The engine creates them
  // unconditionally.
  return { candidates: [] };
}

/**
 * A list entry's identity is the pair (the record, the list) — the same pair
 * Affinity itself enforces, since a record sits on a list once. Finding it here
 * is what makes a re-asserted membership an UPDATE: the engine then reads the
 * entry back and applies the authored modifiers against what is on it, instead
 * of handing the adapter a create whose values had nowhere to be compared.
 *
 * The record arrives folded into the resolve record under the edge the write
 * came through; the list is already pinned on the decoded type by the time this
 * runs (the adapter narrows the membership collection by the write's
 * `listName`). Either one missing means we cannot name a membership at all, so
 * there is nothing to match and the write creates.
 */
async function resolveListEntry(input: {
  operations: AffinityOperations;
  decoded: DecodedTypeId;
  resolve: ResolveEntityInput;
}): Promise<ResolveEntityResult> {
  const { listId, listName } = input.decoded;
  if (listId == null) return { candidates: [] };

  const entityType = listEntityKind(input.decoded.listType);
  if (entityType !== 'organization' && entityType !== 'person') return { candidates: [] };

  const parent = input.resolve.record[AFFINITY_LIST_ENTRIES_EDGE];
  const entityId = Number((parent as { id?: unknown } | undefined)?.id);
  // A REHEARSED parent carries a synthetic handle, not an Affinity id: nothing
  // to look a membership up by.
  if (!Number.isInteger(entityId)) return { candidates: [] };

  const existingId = await input.operations.getClient().getExistingListEntryId({
    list: { id: listId },
    entityId,
    entityType,
  });
  if (!existingId) return { candidates: [] };

  return {
    candidates: [
      {
        adapterType: AFFINITY_ADAPTER_TYPE,
        externalId: String(existingId),
        data: {
          [AFFINITY_LIST_ENTRIES_EDGE]: { id: String(entityId) },
          ...(listName !== undefined ? { [AFFINITY_LIST_NAME_FIELD]: listName } : {}),
        },
      },
    ],
  };
}

function resolveByBridge(resolve: ResolveEntityInput): ResolveEntityResult | null {
  if (resolve.candidates.length === 0) return null;
  const matching = resolve.candidates
    .filter((c: LinkedObjectCandidate) => c.external_object_type === resolve.recordType)
    .sort(
      (a, b) =>
        new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime(),
    );
  if (matching.length === 0) return null;
  return {
    candidates: [
      {
        adapterType: AFFINITY_ADAPTER_TYPE,
        externalId: matching[0].external_id,
        data: {},
      },
    ],
  };
}

async function resolveOrganization(input: {
  operations: AffinityOperations;
  resolve: ResolveEntityInput;
}): Promise<ResolveEntityResult> {
  const { name, domain } = readOrgBuiltins(input.resolve.record);
  if (!name && !domain) return { candidates: [] };

  let match: { id: number } | null = null;
  try {
    match = await input.operations.findMatchingOrganisation({
      name: name ?? '',
      domain: domain ?? null,
    });
  } catch (err) {
    if (isAdapterCallCeilingExceeded(err)) throw err;
    logger.warn('[AffinityAdapter.resolveOrganization] match failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { candidates: [] };
  }
  if (!match) return { candidates: [] };

  const data: Record<string, unknown> = {};
  if (name) data.Name = name;
  if (domain) data.Domain = domain;
  const candidate: ExternalRecordRef = {
    adapterType: AFFINITY_ADAPTER_TYPE,
    externalId: String(match.id),
    data,
  };
  return { candidates: [candidate] };
}

async function resolvePerson(input: {
  operations: AffinityOperations;
  resolve: ResolveEntityInput;
}): Promise<ResolveEntityResult> {
  const { name, email } = readPersonBuiltins(input.resolve.record);
  if (!name && !email) return { candidates: [] };

  let match: { id: number } | null = null;
  try {
    match = await input.operations.findMatchingPerson({
      name: name ?? '',
      email: email ?? null,
    });
  } catch (err) {
    if (isAdapterCallCeilingExceeded(err)) throw err;
    logger.warn('[AffinityAdapter.resolvePerson] match failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { candidates: [] };
  }
  if (!match) return { candidates: [] };

  const data: Record<string, unknown> = {};
  if (name) data.Name = name;
  if (email) data.Email = email;
  const candidate: ExternalRecordRef = {
    adapterType: AFFINITY_ADAPTER_TYPE,
    externalId: String(match.id),
    data,
  };
  return { candidates: [candidate] };
}
