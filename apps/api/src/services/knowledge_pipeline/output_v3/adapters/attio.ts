import { LRUCache } from 'lru-cache';

import type { AttioOperations } from '../../../../adapters/attio/operations';
import type { V3Adapter, V3AdapterExecuteInput, AdapterResult, FieldConstraints } from './types';

import { services } from '../../../../adapters/registry';
import { logger } from 'movement-engine/public/log';
import { anthropicChat } from '../../../../lib/anthropic';
import { HAIKU_MODEL } from '../../../agent_running_state';
import { resolveConfigField, StaleLinkedObjectError } from './types';
import { classifyFieldValues, getUniqueFields, getFuzzyFields } from './search';
import { buildLLMContext, resolvePreserveTags } from '../resolve';

// name→ID resolution
async function resolveObjectId(
  operations: AttioOperations,
  input: V3AdapterExecuteInput,
): Promise<string | undefined> {
  const resolved = await resolveConfigField('objectId', input.adapterConfig, input);
  if (!resolved) return undefined;
  // Try as direct ID or slug first
  const client = operations.getClient();
  const objects = await client.listObjects();
  const match = objects.find(
    o => o.id === resolved || o.slug === resolved || o.name.toLowerCase() === resolved.toLowerCase(),
  );
  return match?.id ?? resolved; // fallback to raw value (might be a valid ID)
}

function createAttioV3Adapter(operations: AttioOperations): V3Adapter {
  return {
    async execute(input: V3AdapterExecuteInput): Promise<AdapterResult> {
      const [, actionType] = input.type.split(':');

      if (actionType === 'object') {
        return executeObject(operations, input);
      } else if (actionType === 'list-entry') {
        return executeListEntry(operations, input);
      } else if (actionType === 'note') {
        return executeNote(operations, input);
      } else if (actionType === 'task') {
        return executeTask(operations, input);
      } else if (actionType === 'upload') {
        return executeUpload(operations, input);
      }

      logger.warn(`Attio v3 adapter: unknown action type "${actionType}"`);
      return {};
    },

    async getFieldConstraints(actionNode) {
      return getFieldConstraintsForAction(operations, actionNode);
    },
  };
}

async function getFieldConstraintsForAction(
  operations: AttioOperations,
  actionNode: { type: string; adapterConfig: Record<string, unknown>; fieldMappings: { targetField: unknown }[] },
): Promise<Map<string, FieldConstraints>> {
  const [, actionType] = actionNode.type.split(':');
  const config = actionNode.adapterConfig as { objectId?: string; listId?: string };

  const objectId = actionType === 'object' ? config.objectId : undefined;
  const listId = actionType === 'list-entry' ? config.listId : undefined;
  if (!objectId && !listId) return new Map();

  const client = operations.getClient();
  const attributes = await client.listAttributes({ objectId, listId });

  const result = new Map<string, FieldConstraints>();
  for (const mapping of actionNode.fieldMappings) {
    const targetField = String(mapping.targetField);
    const attr = attributes.find(
      (a) => a.apiSlug === targetField || a.name === targetField || a.name.toLowerCase() === targetField.toLowerCase(),
    );
    if (!attr) continue;

    const entry: FieldConstraints = { displayName: attr.name };

    if (attr.type === 'select') {
      const options = await client.listAttributeOptions({ objectId, listId, attributeId: attr.id });
      entry.options = options.map((o) => o.name);
    } else if (attr.type === 'status') {
      const statuses = await client.listStatuses({ objectId, listId, attributeId: attr.id });
      entry.options = statuses.map((s) => s.name);
    }

    result.set(targetField, entry);
  }

  return result;
}

async function executeObject(
  operations: AttioOperations,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  const objectId = await resolveObjectId(operations, input);
  if (!objectId) return { skipped: true, skipReason: 'No object type configured' };
  const config = {
    objectId,
    parentReferenceField: (input.adapterConfig as { parentReferenceField?: { fieldId: string } }).parentReferenceField,
  };

  // Build additional fields from parent reference
  let additionalFields: Record<string, unknown> | undefined;
  if (input.parentResult?.parentRecord && config.parentReferenceField) {
    const refValue = {
      target_object: input.parentResult.parentRecord.objectId,
      target_record_id: input.parentResult.parentRecord.recordId,
    };

    // Multi-select attributes expect an array; single-select expects a bare object
    const client = operations.getClient();
    const attributes = await client.listAttributes({ objectId: config.objectId });
    const attr = attributes.find(
      (a) => a.apiSlug === config.parentReferenceField!.fieldId || a.id === config.parentReferenceField!.fieldId,
    );

    additionalFields = {
      [config.parentReferenceField.fieldId]: attr?.isMulti ? [refValue] : refValue,
    };
  }

  const preResolvedValues = new Map<string, unknown>(
    Object.entries(input.fieldValues),
  );

  // Four-tier search strategy for entity resolution (Tier 0 = linked objects)
  const { existingId, searchQuery } = await buildSearchStrategy(
    operations, config.objectId, input.fieldMappings, input.fieldValues, input.linkedObjects,
  );
  const isTier0 = existingId != null && input.linkedObjects.length > 0;

  logger.info(`[AttioV3] executeObject: ${preResolvedValues.size} pre-resolved values`, {
    keys: [...preResolvedValues.keys()],
    existingId: existingId ?? null,
    searchQuery: searchQuery ?? null,
    readOnly: input.readOnly ?? false,
  });

  // Read-only mode: look up only, never create or update
  if (input.readOnly) {
    let recordId = existingId;

    // If no Tier 0-2 match, try fuzzy search (Tier 3)
    if (!recordId && searchQuery) {
      const client = operations.getClient();
      const hits = await client.searchRecords({ objectId: config.objectId, query: searchQuery });
      if (hits.length > 0) recordId = hits[0].id;
    }

    if (!recordId) {
      return { skipped: true, skipReason: 'Record not found (read-only)' };
    }

    try {
      const client = operations.getClient();
      const record = await client.getRecord({ objectId: config.objectId, recordId });
      return {
        externalId: record.id.record_id,
        created: false,
        externalObjectType: await resolveObjectTypeName(config.objectId, operations),
        data: buildRecordData(record, config.objectId),
        parentRecord: { objectId: config.objectId, recordId: record.id.record_id },
      };
    } catch (err) {
      if (isTier0 && err instanceof Error && err.message.includes('404')) {
        throw new StaleLinkedObjectError(existingId);
      }
      throw err;
    }
  }

  const isUpdate = !!existingId;

  try {
    const record = await operations.createOrUpdateObject({
      objectId: config.objectId,
      searchQuery,
      existingId,
      userText: '',
      tracer: createNoopTracer(),
      fieldConfigurations: [],
      additionalFields,
      preResolvedValues,
    });

    return {
      externalId: record.id.record_id,
      created: !isUpdate,
      externalObjectType: await resolveObjectTypeName(config.objectId, operations),
      data: buildRecordData(record, config.objectId),
      parentRecord: { objectId: config.objectId, recordId: record.id.record_id },
    };
  } catch (err) {
    if (isTier0 && err instanceof Error && err.message.includes('404')) {
      throw new StaleLinkedObjectError(existingId);
    }
    throw err;
  }
}

async function executeListEntry(
  operations: AttioOperations,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  const config = input.adapterConfig as {
    listId: string;
    deduplicationWindow?: { years?: number; months?: number; days?: number };
  };

  if (!input.parentResult?.parentRecord) {
    throw new Error('Attio list-entry requires a parent record');
  }

  const preResolvedValues = new Map<string, unknown>(
    Object.entries(input.fieldValues),
  );

  logger.info(`[AttioV3] executeListEntry: ${preResolvedValues.size} pre-resolved values`, {
    keys: [...preResolvedValues.keys()],
  });

  // Read-only mode: resolve field values but don't create/update list entry
  if (input.readOnly) {
    return {
      skipped: true,
      skipReason: 'List entry not created (read-only)',
      externalObjectType: 'List Entry',
      parentRecord: input.parentResult.parentRecord,
    };
  }

  const entryId = await operations.createOrUpdateListEntry({
    listId: config.listId,
    parentObjectId: input.parentResult.parentRecord.objectId,
    parentRecordId: input.parentResult.parentRecord.recordId,
    userText: '',
    tracer: createNoopTracer(),
    fieldConfigurations: [],
    preResolvedValues,
    deduplicationWindow: config.deduplicationWindow,
  });

  return {
    externalId: entryId,
    externalObjectType: 'List Entry',
    data: buildFieldValuesData(input.fieldValues),
    parentRecord: input.parentResult.parentRecord,
  };
}

async function executeNote(
  operations: AttioOperations,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  if (!input.parentResult?.parentRecord) {
    throw new Error('Attio note requires a parent record');
  }

  const config = input.adapterConfig as {
    titlePrompt?: string;
    contentPrompt?: string;
  };

  const llmContext = config.contentPrompt || config.titlePrompt
    ? await buildLLMContext([input.contextNodeId], input.context)
    : null;

  let noteContent = '';

  if (config.contentPrompt && llmContext) {
    const result = await anthropicChat({
      system: `You are an intelligent function in a data extraction system.

The user will provide entity data along with the source document it was extracted from. Your task:
${config.contentPrompt}

Return ONLY the text. No XML, no labels, no preamble — just the content.`,
      userMessage: llmContext,
      model: HAIKU_MODEL,
      label: 'output_attio_note_content',
    });
    let trimmed = result.trim();
    if (input.afterEmbedValues?.size) trimmed = resolvePreserveTags(trimmed, input.afterEmbedValues);
    if (trimmed) noteContent = trimmed;
  }

  if (!noteContent) return { skipped: true, skipReason: 'No note content' };

  let noteTitle = 'Note';
  if (config.titlePrompt && llmContext) {
    const result = await anthropicChat({
      system: `You are an intelligent function in a data extraction system.

The user will provide entity data along with the source document it was extracted from. Your task:
${config.titlePrompt}

Return ONLY the text. No XML, no labels, no preamble — just the content.`,
      userMessage: llmContext,
      model: HAIKU_MODEL,
      label: 'output_attio_note_title',
    });
    let trimmed = result.trim();
    if (input.afterEmbedValues?.size) trimmed = resolvePreserveTags(trimmed, input.afterEmbedValues);
    if (trimmed) noteTitle = trimmed;
  }

  // Read-only mode: resolve note content but don't create
  if (input.readOnly) {
    return {
      externalObjectType: 'Note',
      displayValues: { Title: noteTitle, Content: noteContent },
    };
  }

  const noteId = await operations.createNote({
    parentObjectId: input.parentResult.parentRecord.objectId,
    parentRecordId: input.parentResult.parentRecord.recordId,
    title: noteTitle,
    content: noteContent,
    format: 'markdown',
  });

  const slug = await operations.getClient().getWorkspaceSlug();
  return {
    externalId: noteId,
    externalObjectType: 'Note',
    data: { title: noteTitle, url: `https://app.attio.com/${slug}/note/${noteId}` },
  };
}

async function executeTask(
  operations: AttioOperations,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  if (!input.parentResult?.parentRecord) {
    throw new Error('Attio task requires a parent record');
  }

  const config = input.adapterConfig as {
    assignees?: { workspaceMemberId: string }[];
    deadlineOffsetDays?: number;
  };

  const content = (input.fieldValues.content as string) ?? '';
  if (!content) return { skipped: true, skipReason: 'No task content' };

  // Read-only mode: resolve task content but don't create
  if (input.readOnly) {
    return {
      externalObjectType: 'Task',
      displayValues: { Content: content },
    };
  }

  let deadlineAt: string | null = null;
  if (config.deadlineOffsetDays !== undefined) {
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + config.deadlineOffsetDays);
    deadlineAt = deadline.toISOString();
  }

  await operations.createTask({
    content,
    assignees: config.assignees ?? [],
    linkedRecords: [
      {
        targetObject: input.parentResult.parentRecord.objectId,
        targetRecordId: input.parentResult.parentRecord.recordId,
      },
    ],
    deadlineAt,
  });
  return {};
}

async function executeUpload(
  operations: AttioOperations,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  if (!input.parentResult?.parentRecord) {
    throw new Error('Attio upload requires a parent record');
  }

  if (!input.resource) {
    return { skipped: true, skipReason: 'Context node has no attached resource to upload' };
  }

  if (!input.resource.documentObjectUri) {
    return { skipped: true, skipReason: `Resource "${input.resource.name}" has no downloadable document` };
  }

  // Read-only mode: resolve which file would be uploaded but don't upload
  if (input.readOnly) {
    return {
      externalObjectType: 'Upload',
      displayValues: { File: input.resource.name },
      parentRecord: input.parentResult.parentRecord,
    };
  }

  const { objectId, recordId } = input.parentResult.parentRecord;

  try {
    const stream = await services.document.getFileNodeStream({ objectUri: input.resource.documentObjectUri });
    const client = operations.getClient();
    const result = await client.uploadFile({
      file: stream,
      fileName: input.resource.name,
      objectSlug: objectId,
      recordId,
    });
    logger.info(`[AttioV3] Uploaded "${input.resource.name}" → ${result.fileId}`);

    const slug = await client.getWorkspaceSlug();
    return {
      externalId: result.fileId,
      created: true,
      externalObjectType: 'Upload',
      data: {
        name: result.name,
        url: `https://app.attio.com/${slug}`,
        resourceId: input.resource.resourceId,
      },
      parentRecord: input.parentResult.parentRecord,
    };
  } catch (err) {
    logger.error(`[AttioV3] Failed to upload "${input.resource.name}"`, { error: err });
    return { skipped: true, skipReason: `Upload failed: ${err}` };
  }
}

async function buildSearchStrategy(
  operations: AttioOperations,
  objectId: string,
  fieldMappings: V3AdapterExecuteInput['fieldMappings'],
  fieldValues: Record<string, unknown>,
  linkedObjects: V3AdapterExecuteInput['linkedObjects'],
): Promise<{ existingId?: string; searchQuery?: string }> {
  // Tier 0: Linked object — strongest signal, skip API calls entirely
  if (linkedObjects.length > 0) {
    logger.info(`[AttioV3] Tier 0 match: linked object → record ${linkedObjects[0].externalId}`);
    return { existingId: linkedObjects[0].externalId };
  }

  const client = operations.getClient();
  const attributes = await client.listAttributes({ objectId });
  const identityFields = classifyFieldValues(fieldMappings, fieldValues);

  // Tier 1: Attio-side unique attributes we're writing to
  for (const attr of attributes) {
    if (!attr.isUnique) continue;
    const slug = attr.apiSlug ?? attr.name;
    const value = fieldValues[slug];
    if (value == null || (typeof value === 'string' && !value.trim())) continue;

    const matches = await client.filterRecords({
      objectId,
      filters: { [slug]: value },
    });
    if (matches.length > 0) {
      logger.info(`[AttioV3] Tier 1 match: Attio unique attr "${slug}" → record ${matches[0].id}`);
      return { existingId: matches[0].id };
    }
  }

  // Tier 2: Our identity: 'unique' field mappings — exact filter
  const uniqueFields = getUniqueFields(identityFields);
  for (const field of uniqueFields) {
    const attr = attributes.find(
      (a) => (a.apiSlug ?? a.name) === field.targetField || a.name.toLowerCase() === field.targetField.toLowerCase(),
    );
    if (!attr) continue;

    const slug = attr.apiSlug ?? attr.name;
    const matches = await client.filterRecords({
      objectId,
      filters: { [slug]: field.value },
    });
    if (matches.length > 0) {
      logger.info(`[AttioV3] Tier 2 match: identity unique "${field.targetField}" → record ${matches[0].id}`);
      return { existingId: matches[0].id };
    }
  }

  // Tier 3: Our identity: 'fuzzy' field mappings → searchRecords query
  const fuzzyFields = getFuzzyFields(identityFields);
  if (fuzzyFields.length > 0) {
    const searchQuery = String(fuzzyFields[0].value);
    return { searchQuery };
  }

  return {};
}

// context-aware links
const SLUG_TO_SINGULAR: Record<string, string> = {
  companies: 'Company',
  people: 'Person',
  deals: 'Deal',
  workspaces: 'Workspace',
};

// Cache Attio object type listings per workspace (keyed by credential identity).
// 10-minute TTL avoids hammering the API for structural queries that rarely change.
const objectTypeCache = new LRUCache<string, Map<string, string>>({ max: 20, ttl: 10 * 60 * 1000 });

async function resolveObjectTypeName(objectId: string, operations: AttioOperations): Promise<string> {
  if (SLUG_TO_SINGULAR[objectId]) return SLUG_TO_SINGULAR[objectId];

  const cacheKey = 'attio-objects'; // single workspace per adapter instance
  let typeMap = objectTypeCache.get(cacheKey);

  if (!typeMap) {
    try {
      const objects = await operations.getClient().listObjects();
      typeMap = new Map();
      for (const obj of objects) {
        typeMap.set(obj.id, obj.name);
        if (obj.slug) typeMap.set(obj.slug, obj.name);
      }
      objectTypeCache.set(cacheKey, typeMap);
    } catch {
      typeMap = new Map();
    }
  }

  return typeMap.get(objectId) ?? objectId;
}

function buildRecordData(record: { id: { object_id: string; record_id: string }; web_url?: string; values: Record<string, unknown> }, objectId: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  // Extract simple string/number values from Attio's nested value format
  for (const [key, val] of Object.entries(record.values)) {
    if (!Array.isArray(val) || val.length === 0) continue;
    const first = val[0] as Record<string, unknown>;
    // Attio stores values as arrays of typed objects
    if (typeof first === 'object' && first !== null) {
      const displayValue = first.value ?? first.full_name ?? first.first_name ?? first.domain ?? first.email_address ?? first.original_email_address;
      if (displayValue != null && typeof displayValue !== 'object') {
        data[key] = displayValue;
      }
    }
  }

  if (record.web_url) {
    data.url = record.web_url;
  }

  return data;
}

function buildFieldValuesData(fieldValues: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(fieldValues)) {
    if (val != null && typeof val !== 'object') {
      data[key] = val;
    }
  }
  return data;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createNoopTracer(): any {
  return {
    add: () => {},
    child: () => createNoopTracer(),
    span: async <T>(fn: (t: unknown) => Promise<T>) => fn(createNoopTracer()),
    writeToContextLogs: async () => {},
  };
}

export { createAttioV3Adapter, buildRecordData };
