import { randomUUID } from 'node:crypto';

import type { V3Adapter, V3AdapterExecuteInput, AdapterResult } from './types';

import { logger } from '../../../logger';

/**
 * Wraps a real V3Adapter for dry-run mode. Write-mode actions are forced into
 * readOnly so the adapter executes its full search/lookup logic against the
 * live 3rd-party API, but never creates or mutates external records.
 *
 * When the read-only path returns "skipped" (entity not found), the wrapper
 * fabricates a "would create" result so downstream children still execute.
 */
function wrapAdapterForDryRun(adapter: V3Adapter): V3Adapter {
  return {
    async execute(input: V3AdapterExecuteInput): Promise<AdapterResult> {
      const wasReadOnly = input.readOnly;

      // Force readOnly so the adapter searches but never writes
      const dryInput: V3AdapterExecuteInput = { ...input, readOnly: true };

      let result: AdapterResult;
      try {
        result = await adapter.execute(dryInput);
      } catch (err) {
        // If the adapter throws because it can't operate in read-only mode
        // (e.g. list-entry/note that requires a parent), fabricate a result
        logger.warn(`[DryRunAdapter] adapter threw in read-only mode, fabricating result`, { err });
        result = fabricateCreateResult(input);
        result.skipReason = `dry_run: adapter cannot run read-only (${err instanceof Error ? err.message : String(err)})`;
        return result;
      }

      // If the adapter skipped because the entity wasn't found in read-only mode,
      // fabricate a "would create" result so downstream children can still execute
      if (result.skipped && !wasReadOnly) {
        logger.info(`[DryRunAdapter] entity not found in read-only mode, fabricating create result`);
        const fabricated = fabricateCreateResult(input);
        // Preserve adapter's parentRecord/displayValues when available
        return {
          ...fabricated,
          parentRecord: result.parentRecord ?? fabricated.parentRecord,
          displayValues: { ...result.displayValues, _dryRun: 'would_create' },
        };
      }

      return result;
    },

    getFieldConstraints: adapter.getFieldConstraints?.bind(adapter),
  };
}

function fabricateCreateResult(input: V3AdapterExecuteInput): AdapterResult {
  const fakeId = `dry-run-${randomUUID().slice(0, 8)}`;
  const [rawAdapter, actionType] = input.type.split(':');

  // Propagate parent context fields so children can reference them
  const result: AdapterResult = {
    externalId: fakeId,
    created: true,
    externalObjectType: actionType ?? rawAdapter,
  };

  // Fabricate parent pointers that children rely on
  if (actionType === 'organization' || actionType === 'object') {
    result.parentRecord = { objectId: actionType, recordId: fakeId };
    result.parentEntity = { profileId: fakeId };
  } else if (actionType === 'person') {
    result.parentRecord = { objectId: 'person', recordId: fakeId };
    result.parentEntity = { profileId: fakeId };
  } else if (actionType === 'list-entry') {
    result.parentRecord = input.parentResult?.parentRecord;
  } else if (actionType === 'message' || actionType === 'channel') {
    result.parentMessage = { channelId: fakeId, threadTs: fakeId };
  } else if (actionType === 'folder' || actionType === 'document') {
    result.parentFolder = { folderId: fakeId };
  }

  return result;
}

export { wrapAdapterForDryRun };
