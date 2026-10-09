// The Evertrace write surface: creating and removing saved searches, lists and
// list memberships, and setting the two facts a person changes about a signal
// (screened, viewed).
//
// Field keys arrive already resolved to this adapter's INTERNAL field ids —
// the adapter translates the author's natural names on the first line of each
// write method, as the contract requires.

import type {
  DeleteInput,
  DeleteResult,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
} from '../../adapter';

import {
  EvertraceApiError,
  type EvertraceApiClient,
  type EvertraceSearchFilterRow,
} from '../../../../adapters/evertrace/apiClient';
import { writeParentLinks, containerAssociation } from '../../adapter';
import { neverAsAny } from '../../../../lib/utils/types';
import { UPDATE_NOT_FOUND } from '../not_found';
import {
  EVERTRACE_ADAPTER_TYPE,
  EVERTRACE_LIST_DISPLAY_NAME,
  EVERTRACE_LIST_ENTRY_DISPLAY_NAME,
  EVERTRACE_LIST_ENTRY_TYPE_ID,
  EVERTRACE_LIST_TYPE_ID,
  EVERTRACE_SEARCH_DISPLAY_NAME,
  EVERTRACE_SEARCH_TYPE_ID,
  EVERTRACE_SIGNAL_DISPLAY_NAME,
  EVERTRACE_SIGNAL_TYPE_ID,
  decodeListEntryId,
  encodeListEntryId,
} from './types';

/** The types with any write surface at all. A string typeId narrowed once, so
 *  the switches below are exhaustively checked rather than defaulting. */
export type EvertraceWritableTypeId =
  | typeof EVERTRACE_SIGNAL_TYPE_ID
  | typeof EVERTRACE_SEARCH_TYPE_ID
  | typeof EVERTRACE_LIST_TYPE_ID
  | typeof EVERTRACE_LIST_ENTRY_TYPE_ID;

export function writableTypeId(typeId: string): EvertraceWritableTypeId | undefined {
  switch (typeId) {
    case EVERTRACE_SIGNAL_TYPE_ID:
    case EVERTRACE_SEARCH_TYPE_ID:
    case EVERTRACE_LIST_TYPE_ID:
    case EVERTRACE_LIST_ENTRY_TYPE_ID:
      return typeId;
    default:
      return undefined;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof EvertraceApiError && error.status === 404;
}

/** An unscreen against a signal that was never screened — the end state the
 *  write asked for, so not a failure and not a missing record. */
function isMissingScreening(error: unknown): boolean {
  return error instanceof EvertraceApiError && error.body.includes('ScreeningNotFoundError');
}

function requiredString(fields: Record<string, unknown>, key: string, at: string): string {
  const value = fields[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`EvertraceAdapter.${at}: "${key}" is required and must be a non-empty name.`);
  }
  return value.trim();
}

function optionalString(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The saved-search filter rows out of a write body. Each row needs a key, an
 * operator and a value; anything else in the list is rejected here rather than
 * reaching Evertrace as a 400 nobody can read.
 */
function filterRows(value: unknown, at: string): EvertraceSearchFilterRow[] | undefined {
  if (value === undefined || value === null) return undefined;
  const rows = Array.isArray(value) ? value : [value];
  return rows.map((row) => {
    const record = row as { key?: unknown; operator?: unknown; value?: unknown };
    if (
      typeof record?.key !== 'string' ||
      typeof record?.operator !== 'string' ||
      typeof record?.value !== 'string'
    ) {
      throw new Error(
        `EvertraceAdapter.${at}: each filter needs a key, an operator and a value, all text ` +
          `(e.g. { key: "score", operator: "gte", value: "7" }).`,
      );
    }
    return { key: record.key, operator: record.operator, value: record.value };
  });
}

export async function createEvertraceRecord(input: {
  client: EvertraceApiClient;
  typeId: EvertraceWritableTypeId;
  write: WriteInput;
}): Promise<WriteResult> {
  const { client, write } = input;
  switch (input.typeId) {
    case EVERTRACE_SIGNAL_TYPE_ID:
      throw new Error(
        'EvertraceAdapter.createRecord: Evertrace discovers signals; nothing creates one. ' +
          'To change a signal you already hold, set `Screened` or `Viewed` on it.',
      );
    case EVERTRACE_SEARCH_TYPE_ID: {
      // `visitedAt` and `sharees` are required by the API but are not authoring
      // decisions — a new search is unshared and unvisited, so the adapter
      // supplies both rather than making an author state the obvious.
      const search = await client.createSearch({
        title: requiredString(write.fields, 'title', 'createRecord'),
        ...(optionalString(write.fields, 'emoji') !== undefined
          ? { emoji: optionalString(write.fields, 'emoji') }
          : {}),
        visitedAt: Date.now(),
        filters: filterRows(write.fields['filters'], 'createRecord') ?? [],
        sharees: [],
      });
      return {
        adapterType: EVERTRACE_ADAPTER_TYPE,
        externalId: search.id,
        recordType: EVERTRACE_SEARCH_DISPLAY_NAME,
        data: { title: search.title, emoji: search.emoji },
      };
    }
    case EVERTRACE_LIST_TYPE_ID: {
      const list = await client.createList({
        name: requiredString(write.fields, 'name', 'createRecord'),
        accesses: [],
      });
      return {
        adapterType: EVERTRACE_ADAPTER_TYPE,
        externalId: list.id,
        recordType: EVERTRACE_LIST_DISPLAY_NAME,
        data: { name: list.name },
      };
    }
    case EVERTRACE_LIST_ENTRY_TYPE_ID: {
      const parents = writeParentLinks(write);
      const listId = parents.find((p) => p.recordType === EVERTRACE_LIST_DISPLAY_NAME)?.externalId;
      const signalId = parents.find(
        (p) => p.recordType === EVERTRACE_SIGNAL_DISPLAY_NAME,
      )?.externalId;
      if (listId === undefined || signalId === undefined) {
        throw new Error(
          'EvertraceAdapter.createRecord: a list entry needs both ends — write it along ' +
            'the list and the signal at once: ' +
            'write (list-[:Entries]->, signal-[:List Entries]->) { }.',
        );
      }
      const entry = await client.createListEntry(listId, { signalId });
      return {
        adapterType: EVERTRACE_ADAPTER_TYPE,
        externalId: encodeListEntryId({ listId, entryId: entry.id }),
        recordType: EVERTRACE_LIST_ENTRY_DISPLAY_NAME,
        data: { listId, signalId },
      };
    }
    default:
      return neverAsAny(input.typeId);
  }
}

/** A writable type's natural name — the currency `UpdateResult.recordType`
 *  speaks, needed before the switch picks a branch. */
const EVERTRACE_DISPLAY_NAME_BY_TYPE: Record<EvertraceWritableTypeId, string> = {
  [EVERTRACE_SIGNAL_TYPE_ID]: EVERTRACE_SIGNAL_DISPLAY_NAME,
  [EVERTRACE_SEARCH_TYPE_ID]: EVERTRACE_SEARCH_DISPLAY_NAME,
  [EVERTRACE_LIST_TYPE_ID]: EVERTRACE_LIST_DISPLAY_NAME,
  [EVERTRACE_LIST_ENTRY_TYPE_ID]: EVERTRACE_LIST_ENTRY_DISPLAY_NAME,
};

export async function updateEvertraceRecord(input: {
  client: EvertraceApiClient;
  typeId: EvertraceWritableTypeId;
  update: UpdateInput;
}): Promise<UpdateResult> {
  const { client, update } = input;
  // Nothing of the record's own to change. Evertrace has no parent to attach a
  // matched record to — a list entry IS its (list, signal) pair, so a match
  // already means membership — so there is nothing left to send. Answering
  // without a call keeps a parent-only write from re-sending an unchanged
  // search or list, and from tripping the list-entry refusal below.
  if (Object.keys(update.fields).length === 0) {
    return {
      adapterType: EVERTRACE_ADAPTER_TYPE,
      externalId: update.externalId,
      recordType: EVERTRACE_DISPLAY_NAME_BY_TYPE[input.typeId],
      data: {},
      association: containerAssociation(update),
    };
  }
  switch (input.typeId) {
    case EVERTRACE_SIGNAL_TYPE_ID:
      return updateSignal({ client, update });
    case EVERTRACE_SEARCH_TYPE_ID: {
      const filters = filterRows(update.fields['filters'], 'updateRecord');
      try {
        const search = await client.updateSearch(update.externalId, {
          ...(optionalString(update.fields, 'title') !== undefined
            ? { title: optionalString(update.fields, 'title') }
            : {}),
          ...(optionalString(update.fields, 'emoji') !== undefined
            ? { emoji: optionalString(update.fields, 'emoji') }
            : {}),
          ...(filters !== undefined ? { filters } : {}),
        });
        // The API answers `null` for a search it did not update — the same fact
        // its 404 carries, so it takes the same route.
        if (search === null) return UPDATE_NOT_FOUND;
        return {
          adapterType: EVERTRACE_ADAPTER_TYPE,
          externalId: update.externalId,
          recordType: EVERTRACE_SEARCH_DISPLAY_NAME,
          data: { title: search.title, emoji: search.emoji },
          association: containerAssociation(update),
        };
      } catch (error) {
        if (isNotFound(error)) return UPDATE_NOT_FOUND;
        throw error;
      }
    }
    case EVERTRACE_LIST_TYPE_ID: {
      try {
        const list = await client.updateList(update.externalId, {
          ...(optionalString(update.fields, 'name') !== undefined
            ? { name: optionalString(update.fields, 'name') }
            : {}),
        });
        return {
          adapterType: EVERTRACE_ADAPTER_TYPE,
          externalId: update.externalId,
          recordType: EVERTRACE_LIST_DISPLAY_NAME,
          data: { name: list.name },
          association: containerAssociation(update),
        };
      } catch (error) {
        if (isNotFound(error)) return UPDATE_NOT_FOUND;
        throw error;
      }
    }
    case EVERTRACE_LIST_ENTRY_TYPE_ID:
      throw new Error(
        'EvertraceAdapter.updateRecord: a list entry carries nothing to change — ' +
          'add it again (adding is idempotent) or remove it.',
      );
    default:
      return neverAsAny(input.typeId);
  }
}

/** Screening and viewing are the two facts about a signal a person changes.
 *  Evertrace has no un-view, so `Viewed: false` is refused rather than silently
 *  doing nothing. */
async function updateSignal(input: {
  client: EvertraceApiClient;
  update: UpdateInput;
}): Promise<UpdateResult> {
  const { client, update } = input;
  const screened = update.fields['screened'];
  const viewed = update.fields['viewed'];

  if (viewed === false) {
    throw new Error(
      'EvertraceAdapter.updateRecord: Evertrace cannot un-view a signal — ' +
        'leave `Viewed` alone rather than setting it false.',
    );
  }

  try {
    if (screened === true) await client.screenSignal(update.externalId);
    if (screened === false) {
      try {
        await client.unscreenSignal(update.externalId);
      } catch (error) {
        // Already un-screened IS the state the write asked for.
        if (!isMissingScreening(error)) throw error;
      }
    }
    if (viewed === true) await client.markSignalAsViewed(update.externalId);
  } catch (error) {
    if (isNotFound(error)) return UPDATE_NOT_FOUND;
    throw error;
  }

  return {
    adapterType: EVERTRACE_ADAPTER_TYPE,
    externalId: update.externalId,
    recordType: EVERTRACE_SIGNAL_DISPLAY_NAME,
    data: {
      ...(screened !== undefined ? { screened } : {}),
      ...(viewed !== undefined ? { viewed } : {}),
    },
    association: containerAssociation(update),
  };
}

export async function deleteEvertraceRecord(input: {
  client: EvertraceApiClient;
  typeId: EvertraceWritableTypeId;
  del: DeleteInput;
}): Promise<DeleteResult> {
  const { client, del } = input;
  switch (input.typeId) {
    case EVERTRACE_SIGNAL_TYPE_ID:
      throw new Error(
        'EvertraceAdapter.deleteRecord: signals belong to Evertrace and cannot be removed.',
      );
    case EVERTRACE_SEARCH_TYPE_ID:
      await client.deleteSearch(del.externalId);
      return {};
    case EVERTRACE_LIST_TYPE_ID:
      await client.deleteList(del.externalId);
      return {};
    case EVERTRACE_LIST_ENTRY_TYPE_ID: {
      const decoded = decodeListEntryId(del.externalId);
      if (decoded === undefined) {
        throw new Error(
          `EvertraceAdapter.deleteRecord: "${del.externalId}" does not name a list entry ` +
            '(an entry is identified by its list and its own id together).',
        );
      }
      await client.deleteListEntry(decoded.listId, decoded.entryId);
      return {};
    }
    default:
      return neverAsAny(input.typeId);
  }
}
