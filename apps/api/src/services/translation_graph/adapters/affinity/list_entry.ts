// Affinity TG adapter — list-entry create. Lifts the v3 `executeListEntry`
// flow: a list entry adds a parent org/person to an Affinity list, deduping
// against the parent's existing membership, then writes the list-scoped
// custom-field values. The list id is carried by the per-list type id
// (`List Entry — <list>`, whose structured id carries the listId); the parent
// comes from `parentLinks`.
//
// The v3 output also took a per-action `deduplicationWindow` from
// `adapterConfig`; `WriteInput` carries no adapter config, so the TG path
// dedups against the parent's full membership of the list (window = none),
// which is the safe default — an entity already on the list is never
// re-added.

import type { AffinityOperations } from '../../../../adapters/affinity/operations';
import type { UpdateInput, UpdateResult, WriteInput, WriteResult } from '../../adapter';

import { containerAssociation, singleParentLink } from '../../adapter';
import { decodedFixedType, AFFINITY_ADAPTER_TYPE, type DecodedTypeId } from './types';
import { createNoopTracer, writeCustomFieldValues } from './shared';
import { AFFINITY_LIST_NAME_FIELD } from './schema_catalog';

export async function createListEntry(input: {
  operations: AffinityOperations;
  write: WriteInput;
  /** The structured id the adapter recovered from the write's recordType NAME —
   *  its `listId` pins the target Affinity list (a per-list entry type). */
  decoded: DecodedTypeId;
}): Promise<WriteResult> {
  const { operations, write } = input;

  const listId = input.decoded.listId ?? null;
  if (listId == null) {
    throw new Error(
      'AffinityAdapter.createListEntry: no listId — author the action against a per-list type (`List Entry — <list>`).',
    );
  }

  // A list entry adds a single parent entity to the list — the lone parent.
  const parentLink = singleParentLink(write);
  if (!parentLink) {
    throw new Error('AffinityAdapter.createListEntry: requires a parent organization or person.');
  }
  const parentDecoded = decodedFixedType(parentLink.recordType);
  const entityType =
    parentDecoded?.entity === 'person' ? ('person' as const) : ('organization' as const);
  const entityId = Number(parentLink.externalId);
  if (!Number.isInteger(entityId)) {
    throw new Error(
      `AffinityAdapter.createListEntry: parent externalId "${parentLink.externalId}" is not numeric.`,
    );
  }

  const entryResult = await operations.createListEntry({
    listId,
    entityId,
    entityType,
    deduplicationWindow: undefined,
    tracer: createNoopTracer(),
  });

  // List-scoped custom fields hang off the entry. Write every one we are
  // handed: the engine has already applied write semantics (`?:` set-if-empty,
  // no-change suppression) against the entry's current values, so a local
  // "only on a fresh entry" gate would drop authored values — and would invert
  // a plain `:`, which is what it did. Same rule as person/organization.
  const custom = Object.fromEntries(
    Object.entries(write.fields).filter(([, v]) => v != null && v !== ''),
  );
  if (entryResult && Object.keys(custom).length > 0) {
    await writeCustomFieldValues(operations, {
      entityId,
      entityType,
      fieldValues: custom,
      listEntryId: entryResult.id,
      listId,
      listName: input.decoded.listName,
    });
  }

  return {
    adapterType: AFFINITY_ADAPTER_TYPE,
    externalId: entryResult ? String(entryResult.id) : '',
    data: {},
  };
}

/**
 * Where a list entry lives — the two facts a value on it is posted against.
 * `listName` is what strips a list-scoped field's redundant prefix, so a value
 * keyed by the name the entry's type publishes finds its field.
 */
export interface ListEntryLocation {
  listEntryId: number;
  listId: number;
  listName: string | undefined;
  entityId: number;
  entityType: 'organization' | 'person';
}

/**
 * Re-assert a membership the engine already resolved: set the entry's fields
 * and nothing else. The membership itself is not touched — the entry is the
 * record we were handed, and re-running the create would only re-derive its id.
 */
export async function updateListEntry(input: {
  operations: AffinityOperations;
  update: UpdateInput;
  entry: ListEntryLocation;
}): Promise<UpdateResult> {
  const { operations, entry } = input;
  // `listName` NAMES the list this write is addressed to; it is not a value on
  // the entry. The create path drops it as it re-homes onto the list it named;
  // an update has no re-homing step, so it drops it here. Leaving it in reaches
  // the field writer as a field the workspace has never heard of — and the
  // engine cannot always suppress it upstream, because an entry carrying no
  // values yet names no list to compare against.
  const custom = Object.fromEntries(
    Object.entries(input.update.fields).filter(
      ([k, v]) => k !== AFFINITY_LIST_NAME_FIELD && v != null && v !== '',
    ),
  );
  if (Object.keys(custom).length > 0) {
    await writeCustomFieldValues(operations, {
      entityId: entry.entityId,
      entityType: entry.entityType,
      fieldValues: custom,
      listEntryId: entry.listEntryId,
      listId: entry.listId,
      listName: entry.listName,
    });
  }
  return {
    adapterType: AFFINITY_ADAPTER_TYPE,
    externalId: String(entry.listEntryId),
    data: {},
    // An entry IS its (list, member) pair — the parent and the list name are
    // what identified this entry in the first place, so membership is a fact
    // before the write starts.
    association: containerAssociation(input.update),
  };
}
