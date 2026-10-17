import { format } from 'date-fns';

import type { AffinityOperations } from '@lf/affinity/operations';
import type { V3Adapter, V3AdapterExecuteInput, AdapterResult, FieldConstraints, ResourceContext } from './types';
import type { FieldMapping } from 'movement-engine/public/output-v3';

import { valueType, locationFieldValue, AffinityMergedEntityError } from '@lf/affinity/api_client';
import { services } from '../../../../adapters/registry';
import { streamToBlob } from '../../../../lib/utils/stream';
import { logger } from 'movement-engine/public/log';
import { anthropicChat } from '../../../../lib/anthropic';
import { HAIKU_MODEL } from '../../../agent_running_state';
import { isExpressionConfig, resolveConfigField, StaleLinkedObjectError, MergedEntityError } from './types';
import { resolveFieldMapping, buildLLMContext, resolvePreserveTags, loadResources } from '../resolve';


// ── adapterConfig shapes for Affinity action nodes ──
// Built-in entity properties are stored in adapterConfig as field-mapping-like
// objects (same traversal/selection/aggregation as FieldMapping, minus targetField
// and identity). They get resolved at execution time using resolveFieldMapping.

type PropertyMapping = Pick<FieldMapping, 'traversal' | 'selection' | 'aggregation'>;

function isPropertyMapping(value: unknown): value is PropertyMapping {
  return typeof value === 'object' && value !== null && 'selection' in value;
}

async function resolvePropertyMapping(
  mapping: PropertyMapping,
  contextNodeId: Parameters<typeof resolveFieldMapping>[1],
  context: Parameters<typeof resolveFieldMapping>[2],
): Promise<string> {
  const value = await resolveFieldMapping(
    { ...mapping, targetField: '__builtin' },
    contextNodeId,
    context,
  );
  return value != null ? String(value) : '';
}

function createAffinityV3Adapter(operations: AffinityOperations): V3Adapter {
  let webBaseUrl: string | null = null;

  async function getWebBaseUrl(): Promise<string> {
    if (webBaseUrl) return webBaseUrl;
    try {
      const whoami = await operations.getClient().getWhoami();
      webBaseUrl = `https://${whoami.tenant.subdomain}.affinity.co`;
    } catch (err) {
      logger.warn('[AffinityV3] Failed to fetch whoami for web URL, falling back to default', { err });
      webBaseUrl = 'https://app.affinity.co';
    }
    return webBaseUrl;
  }

  return {
    async execute(input: V3AdapterExecuteInput): Promise<AdapterResult> {
      const [, actionType] = input.type.split(':');

      if (actionType === 'organization') {
        return executeOrganization(operations, input, await getWebBaseUrl());
      } else if (actionType === 'person') {
        return executePerson(operations, input, await getWebBaseUrl());
      } else if (actionType === 'list-entry') {
        return executeListEntry(operations, input);
      } else if (actionType === 'note') {
        return executeNote(operations, input);
      } else if (actionType === 'preview') {
        return executePreview(operations, input);
      } else if (actionType === 'file') {
        return executeFile(operations, input);
      }

      logger.warn(`Affinity v3 adapter: unknown action type "${actionType}"`);
      return {};
    },

    async getFieldConstraints(actionNode) {
      return getFieldConstraintsForAction(operations, actionNode);
    },
  };
}

// ── Field constraints (ranked_dropdown options) ──

async function getFieldConstraintsForAction(
  operations: AffinityOperations,
  actionNode: { type: string; adapterConfig: Record<string, unknown>; fieldMappings: { targetField: unknown }[] },
): Promise<Map<string, FieldConstraints>> {
  const [, actionType] = actionNode.type.split(':');
  const result = new Map<string, FieldConstraints>();

  const entityType = actionType === 'organization' ? 'ORGANIZATION'
    : actionType === 'person' ? 'PERSON'
    : null;

  const listId = actionType === 'list-entry'
    ? (actionNode.adapterConfig as { listId?: number }).listId
    : undefined;

  const client = operations.getClient();
  const fields = await client.getFields({
    type: entityType ?? undefined,
    limitToListId: listId,
  });

  for (const mapping of actionNode.fieldMappings) {
    const targetField = String(mapping.targetField);
    const field = fields.find(
      (f) => String(f.id) === targetField || f.name === targetField || f.name.toLowerCase() === targetField.toLowerCase(),
    );
    if (!field) continue;

    const entry: FieldConstraints = { displayName: field.name };

    if (field.value_type === valueType.RANKED_DROPDOWN && field.dropdown_options?.length) {
      entry.options = field.dropdown_options.map((o) => o.text);
    } else if (field.value_type === valueType.DROPDOWN && field.dropdown_options?.length) {
      entry.options = field.dropdown_options.map((o) => o.text);
    }

    result.set(targetField, entry);
  }

  return result;
}

// ── Search strategy ──
// Resolves built-in entity properties from adapterConfig, then matches against
// existing entities using the operations layer.

type SearchResult = { existingId?: number; fromLinkedObject?: boolean; name: string; domain?: string; email?: string };

async function resolveBuiltinProperties(
  entityType: 'organization' | 'person',
  input: V3AdapterExecuteInput,
): Promise<{ name: string; domain?: string; email?: string }> {
  const config = input.adapterConfig;

  if (entityType === 'organization') {
    const name = isExpressionConfig(config.name)
      ? (await resolveConfigField('name', config, input) ?? '')
      : isPropertyMapping(config.name)
        ? await resolvePropertyMapping(config.name, input.contextNodeId, input.context)
        : '';
    const domain = isExpressionConfig(config.domain)
      ? await resolveConfigField('domain', config, input)
      : isPropertyMapping(config.domain)
        ? await resolvePropertyMapping(config.domain, input.contextNodeId, input.context)
        : undefined;
    return { name, domain: domain || undefined };
  }

  // Person: support firstName + lastName, or just name
  const firstName = isPropertyMapping(config.firstName)
    ? await resolvePropertyMapping(config.firstName, input.contextNodeId, input.context)
    : '';
  const lastName = isPropertyMapping(config.lastName)
    ? await resolvePropertyMapping(config.lastName, input.contextNodeId, input.context)
    : '';
  const fullName = isPropertyMapping(config.name)
    ? await resolvePropertyMapping(config.name, input.contextNodeId, input.context)
    : '';
  const name = fullName || [firstName, lastName].filter(Boolean).join(' ');

  const email = isPropertyMapping(config.email)
    ? await resolvePropertyMapping(config.email, input.contextNodeId, input.context)
    : undefined;

  return { name, email: email || undefined };
}

async function buildSearchStrategy(
  operations: AffinityOperations,
  entityType: 'organization' | 'person',
  input: V3AdapterExecuteInput,
): Promise<SearchResult> {
  const { name, domain, email } = await resolveBuiltinProperties(entityType, input);

  // Tier 0: Linked object — strongest signal, skip API calls entirely
  if (input.linkedObjects.length > 0) {
    const id = parseInt(input.linkedObjects[0].externalId);
    if (!isNaN(id)) {
      logger.info(`[AffinityV3] Tier 0 match: linked object → ${entityType} ${id}`);
      return { existingId: id, fromLinkedObject: true, name, domain, email };
    }
  }

  // Tier 1-3: Delegate to operations layer's existing matching logic
  if (entityType === 'organization') {
    const match = await operations.findMatchingOrganisation({
      name,
      domain: domain ?? null,
    });
    if (match) {
      logger.info(`[AffinityV3] Tier 1-3 match: found organization ${match.id}`);
      return { existingId: match.id, name, domain };
    }
  } else {
    const match = await operations.findMatchingPerson({
      name,
      email: email ?? null,
    });
    if (match) {
      logger.info(`[AffinityV3] Tier 1-3 match: found person ${match.id}`);
      return { existingId: match.id, name, email };
    }
  }

  return { name, domain, email };
}

// ── Organization execution ──

async function executeOrganization(
  operations: AffinityOperations,
  input: V3AdapterExecuteInput,
  webBaseUrl: string,
): Promise<AdapterResult> {
  const { existingId, fromLinkedObject, name, domain } = await buildSearchStrategy(operations, 'organization', input);

  if (!name) {
    return { skipped: true, skipReason: 'No organization name — configure a "name" property mapping in the action node' };
  }

  const builtinDisplayValues: Record<string, string> = { Name: name };
  if (domain) builtinDisplayValues.Domain = domain;

  // Read-only mode: look up only, never create or update
  if (input.readOnly) {
    if (!existingId) {
      return { skipped: true, skipReason: 'Organization not found (read-only)' };
    }
    try {
      const client = operations.getClient();
      const org = await client.getOrganisationById(existingId);
      return {
        externalId: String(org.id),
        created: false,
        externalObjectType: 'Organization',
        data: buildOrgData(org, webBaseUrl),
        displayValues: builtinDisplayValues,
        parentEntity: { profileId: String(org.id) },
        parentRecord: { objectId: 'organization', recordId: String(org.id) },
      };
    } catch (err) {
      if (fromLinkedObject && err instanceof AffinityMergedEntityError) {
        throw new MergedEntityError(String(existingId), err.newId);
      }
      if (fromLinkedObject && err instanceof Error && err.message.includes('404')) {
        throw new StaleLinkedObjectError(String(existingId));
      }
      throw err;
    }
  }

  try {
    const result = await operations.createOrUpdateOrganisation({
      searchQuery: { name, domain: domain ?? null },
      userText: '',
      tracer: createNoopTracer(),
      fieldConfigurations: [],
      affinityId: existingId,
    });

    const client = operations.getClient();
    const org = await client.getOrganisationById(result.id);

    // Write custom field values (all fieldMappings are custom fields now)
    await writeFieldValues(operations, {
      entityId: result.id,
      entityType: 'organization',
      fieldValues: input.fieldValues,
      fieldMappings: input.fieldMappings,
      forceOverwrite: result.isNew,
    });

    return {
      externalId: String(result.id),
      created: result.isNew,
      externalObjectType: 'Organization',
      data: buildOrgData(org, webBaseUrl),
      displayValues: builtinDisplayValues,
      parentEntity: { profileId: String(result.id) },
      parentRecord: { objectId: 'organization', recordId: String(result.id) },
    };
  } catch (err) {
    if (fromLinkedObject && err instanceof AffinityMergedEntityError) {
      throw new MergedEntityError(String(existingId), err.newId);
    }
    if (fromLinkedObject && err instanceof Error && err.message.includes('404')) {
      throw new StaleLinkedObjectError(String(existingId));
    }
    throw err;
  }
}

// ── Person execution ──

async function executePerson(
  operations: AffinityOperations,
  input: V3AdapterExecuteInput,
  webBaseUrl: string,
): Promise<AdapterResult> {
  const { existingId, fromLinkedObject, name, email } = await buildSearchStrategy(operations, 'person', input);

  if (!name) {
    return { skipped: true, skipReason: 'No person name — configure "firstName"/"lastName" or "name" property mappings' };
  }

  const builtinDisplayValues: Record<string, string> = { Name: name };
  if (email) builtinDisplayValues.Email = email;

  const orgId = input.parentResult?.parentRecord
    ? parseInt(input.parentResult.parentRecord.recordId)
    : undefined;

  // Read-only mode: look up only, never create or update
  if (input.readOnly) {
    if (!existingId) {
      return { skipped: true, skipReason: 'Person not found (read-only)' };
    }
    try {
      const client = operations.getClient();
      const person = await client.getPersonById(existingId);
      return {
        externalId: String(person.id),
        created: false,
        externalObjectType: 'Person',
        data: buildPersonData(person, webBaseUrl),
        displayValues: builtinDisplayValues,
        parentEntity: { profileId: String(person.id) },
        parentRecord: { objectId: 'person', recordId: String(person.id) },
      };
    } catch (err) {
      if (fromLinkedObject && err instanceof AffinityMergedEntityError) {
        throw new MergedEntityError(String(existingId), err.newId);
      }
      if (fromLinkedObject && err instanceof Error && err.message.includes('404')) {
        throw new StaleLinkedObjectError(String(existingId));
      }
      throw err;
    }
  }

  try {
    const result = await operations.createOrUpdatePerson({
      searchQuery: { name, email: email ?? null },
      userText: '',
      tracer: createNoopTracer(),
      fieldConfigurations: [],
      orgId,
      affinityId: existingId,
    });

    if (!result) {
      return { skipped: true, skipReason: 'Could not create person: empty name' };
    }

    const client = operations.getClient();
    const person = await client.getPersonById(result.id);

    // Write custom field values
    await writeFieldValues(operations, {
      entityId: result.id,
      entityType: 'person',
      fieldValues: input.fieldValues,
      fieldMappings: input.fieldMappings,
      forceOverwrite: result.isNew,
    });

    return {
      externalId: String(result.id),
      created: result.isNew,
      externalObjectType: 'Person',
      data: buildPersonData(person, webBaseUrl),
      displayValues: builtinDisplayValues,
      parentEntity: { profileId: String(result.id) },
      parentRecord: { objectId: 'person', recordId: String(person.id) },
    };
  } catch (err) {
    if (fromLinkedObject && err instanceof AffinityMergedEntityError) {
      throw new MergedEntityError(String(existingId), err.newId);
    }
    if (fromLinkedObject && err instanceof Error && err.message.includes('404')) {
      throw new StaleLinkedObjectError(String(existingId));
    }
    throw err;
  }
}

// ── List entry execution ──

async function executeListEntry(
  operations: AffinityOperations,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  const rawConfig = input.adapterConfig as {
    listId: number;
    deduplicationWindow?: number | string | {
      years?: number;
      months?: number;
      weeks?: number;
      days?: number;
    };
  };

  // Normalize bare-number/string dedup window (e.g. 6 or "4") to duration object ({ months: N })
  const rawWindow = rawConfig.deduplicationWindow;
  const config = {
    ...rawConfig,
    deduplicationWindow:
      typeof rawWindow === 'number'
        ? { months: rawWindow }
        : typeof rawWindow === 'string'
          ? { months: parseInt(rawWindow, 10) }
          : rawWindow,
  };

  if (!input.parentResult?.parentRecord) {
    throw new Error('Affinity list-entry requires a parent record');
  }

  const entityId = parseInt(input.parentResult.parentRecord.recordId);
  const entityType = input.parentResult.parentRecord.objectId === 'person' ? 'person' as const : 'organization' as const;

  // Read-only mode: resolve field values but don't create list entry
  if (input.readOnly) {
    return {
      skipped: true,
      skipReason: 'List entry not created (read-only)',
      externalObjectType: 'List Entry',
      parentRecord: input.parentResult.parentRecord,
    };
  }

  // Tier 0: If a linked object exists for this list entry, reuse it
  const listEntryLinkedObject = input.linkedObjects.find((lo) =>
    lo.externalObjectType === 'List Entry' && !isNaN(parseInt(lo.externalId)),
  );
  if (listEntryLinkedObject) {
    const existingId = parseInt(listEntryLinkedObject.externalId);
    logger.info(`[AffinityV3] Tier 0 list-entry match: linked object → ${existingId}`);
    return {
      externalId: String(existingId),
      created: false,
      externalObjectType: 'List Entry',
      parentRecord: input.parentResult.parentRecord,
    };
  }

  const entryResult = await operations.createListEntry({
    listId: config.listId,
    entityId,
    entityType,
    deduplicationWindow: config.deduplicationWindow,
    tracer: createNoopTracer(),
  });

  // Write field values to list-specific fields
  // Only force-overwrite on newly created entries — existing deduped entries keep their values
  if (entryResult) {
    await writeFieldValues(operations, {
      entityId,
      entityType: input.parentResult.parentRecord.objectId === 'person' ? 'person' : 'organization',
      fieldValues: input.fieldValues,
      fieldMappings: input.fieldMappings,
      listEntryId: entryResult.id,
      listId: config.listId,
      forceOverwrite: entryResult.isNew,
    });
  }

  return {
    externalId: entryResult ? String(entryResult.id) : undefined,
    created: entryResult?.isNew,
    externalObjectType: 'List Entry',
    parentRecord: input.parentResult.parentRecord,
  };
}

// ── Note execution ──

async function executeNote(
  operations: AffinityOperations,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  if (!input.parentResult?.parentRecord) {
    throw new Error('Affinity note requires a parent record');
  }

  const parentType = input.parentResult.parentRecord.objectId;
  const parentId = parseInt(input.parentResult.parentRecord.recordId);

  const config = input.adapterConfig as {
    prompt?: string;
  };

  let content = (input.fieldValues.content as string) ?? '';

  // If a prompt is provided, use LLM to generate note content
  if (config.prompt && !content) {
    const llmContext = await buildLLMContext([input.contextNodeId], input.context);
    if (llmContext) {
      const result = await anthropicChat({
        system: `You are an intelligent function in a data extraction system.

The user will provide entity data along with the source document it was extracted from. Your task:
${config.prompt}

Return ONLY the text. No XML, no labels, no preamble — just the content.`,
        userMessage: llmContext,
        model: HAIKU_MODEL,
        label: 'output_affinity_note_content',
      });
      let trimmed = result.trim();
      if (input.afterEmbedValues?.size) trimmed = resolvePreserveTags(trimmed, input.afterEmbedValues);
      if (trimmed) content = trimmed;
    }
  }

  if (!content) return { skipped: true, skipReason: 'No note content' };

  // Read-only mode: resolve note content but don't create
  if (input.readOnly) {
    return {
      externalObjectType: 'Note',
      displayValues: { Content: content },
    };
  }

  await operations.createNote({
    organizationId: parentType === 'organization' ? parentId : undefined,
    personId: parentType === 'person' ? parentId : undefined,
    content,
    tracer: createNoopTracer(),
  });

  return { externalObjectType: 'Note' };
}

// ── Preview execution ──

const EMAIL_CHANNELS = new Set(['MAILGUN', 'INBOUND_EMAIL', 'CUSTOM_EMAIL']);

function isEmailPayload(resource: ResourceContext): boolean {
  if (resource.type === 'EMAIL') return true;
  const payloadChannel = resource.metadata.payloadChannel as string | undefined;
  return payloadChannel ? EMAIL_CHANNELS.has(payloadChannel) : false;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getEmailBodyHtml(payload: Record<string, unknown>): string {
  const bodyHtml = payload['body-html'] as string | undefined;
  if (bodyHtml) return bodyHtml;

  const bodyPlain = (payload['body-plain'] ?? payload['stripped-text']) as string | undefined;
  if (bodyPlain) {
    return `<pre style="font-family: sans-serif; white-space: pre-wrap; word-wrap: break-word;">${escapeHtml(bodyPlain)}</pre>`;
  }

  return '<p style="color: #999;">No body content</p>';
}

function buildEmailNoteHtml(payload: Record<string, unknown>, metadata: Record<string, unknown>): string {
  const subject = (payload.subject ?? metadata.subject ?? 'No subject') as string;
  const sender = (payload.sender ?? payload['X-Original-From'] ?? metadata.from_address ?? '') as string;
  const to = (payload.To ?? metadata.to_address ?? payload.recipient ?? '') as string;
  const cc = (payload.Cc ?? '') as string;

  const headerLines: string[] = [];
  if (sender) headerLines.push(`<strong>From:</strong> ${escapeHtml(sender)}`);
  if (to) headerLines.push(`<strong>To:</strong> ${escapeHtml(to)}`);
  if (cc) headerLines.push(`<strong>Cc:</strong> ${escapeHtml(cc)}`);

  const headerHtml = headerLines.length > 0
    ? `<div style="margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid #ddd;">${headerLines.join('<br>')}</div>`
    : '';

  const bodyHtml = getEmailBodyHtml(payload);

  return `<h2>${escapeHtml(subject)}</h2>${headerHtml}${bodyHtml}`;
}

async function executePreview(
  operations: AffinityOperations,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  if (!input.parentResult?.parentRecord) {
    throw new Error('Affinity preview requires a parent record');
  }

  const parentType = input.parentResult.parentRecord.objectId;
  const parentId = parseInt(input.parentResult.parentRecord.recordId);

  // Load resource with payload
  let resources: ResourceContext[];
  if (input.resource) {
    resources = [input.resource];
  } else {
    resources = await loadResources(input.contextNodeId, input.context, { includePayload: true });
  }

  if (resources.length === 0) {
    return { skipped: true, skipReason: 'No resources found for preview' };
  }

  // Prefer email resources
  const contentTypeOrder: Record<string, number> = { EMAIL: 0, TEXT: 1, WHATSAPP: 2, URL: 3, FILE: 4 };
  resources.sort((a, b) => (contentTypeOrder[a.type] ?? 99) - (contentTypeOrder[b.type] ?? 99));

  const resource = resources[0];
  logger.info(
    `[AffinityV3] Preview using resource "${resource.name}" (type=${resource.type}, id=${resource.resourceId}) from ${resources.length} candidate(s)`,
  );

  // Ensure payload is loaded
  if (!resource.payload) {
    const enriched = await loadResources(input.contextNodeId, input.context, { includePayload: true });
    const match = enriched.find((r) => r.resourceId === resource.resourceId);
    if (match) {
      resource.payload = match.payload;
      if (match.metadata.payloadChannel) {
        (resource.metadata as Record<string, unknown>).payloadChannel = match.metadata.payloadChannel;
      }
    }
  }

  const payload = resource.payload ?? {};
  const metadata = resource.metadata;

  // Build HTML content
  let noteHtml: string;
  if (isEmailPayload(resource)) {
    noteHtml = buildEmailNoteHtml(payload, metadata);
  } else {
    // Generic: use body-html if available, otherwise wrap plain text
    const bodyHtml = payload['body-html'] as string | undefined;
    if (bodyHtml) {
      noteHtml = `<h2>${escapeHtml(resource.name)}</h2>${bodyHtml}`;
    } else {
      const bodyPlain = (payload['body-plain'] ?? payload['stripped-text'] ?? payload.text ?? resource.content ?? '') as string;
      noteHtml = `<h2>${escapeHtml(resource.name)}</h2><pre style="font-family: sans-serif; white-space: pre-wrap; word-wrap: break-word;">${escapeHtml(bodyPlain)}</pre>`;
    }
  }

  if (input.readOnly) {
    return {
      externalObjectType: 'Note',
      displayValues: { Preview: resource.name },
    };
  }

  await operations.createNote({
    organizationId: parentType === 'organization' ? parentId : undefined,
    personId: parentType === 'person' ? parentId : undefined,
    content: noteHtml,
    type: 2,
    tracer: createNoopTracer(),
  });

  logger.info(`[AffinityV3] Created preview note for "${resource.name}" on ${parentType} ${parentId}`);

  return { externalObjectType: 'Note' };
}

// ── File upload execution ──

async function executeFile(
  operations: AffinityOperations,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  if (!input.parentResult?.parentRecord || input.parentResult.parentRecord.objectId !== 'organization') {
    throw new Error('Affinity file action requires a parent organization');
  }

  if (!input.resource) {
    return { skipped: true, skipReason: 'Context node has no attached resource to upload' };
  }

  if (!input.resource.documentObjectUri) {
    return { skipped: true, skipReason: `Resource "${input.resource.name}" has no downloadable document` };
  }

  const config = input.adapterConfig as {
    prettyDeckNames?: boolean;
    fileTypes?: string | string[];
  };

  const fileTypeList = Array.isArray(config.fileTypes)
    ? config.fileTypes
    : typeof config.fileTypes === 'string' && config.fileTypes.length > 0
      ? [config.fileTypes]
      : [];
  const allowedExtensions = (fileTypeList.length ? fileTypeList : ['.pdf', '.pptx']).map((e) => e.toLowerCase());
  const extension = input.resource.name.match(/(\.[^.]+)$/)?.[0]?.toLowerCase();
  if (!extension || !allowedExtensions.includes(extension)) {
    return { skipped: true, skipReason: `Resource "${input.resource.name}" has unsupported extension` };
  }

  if (input.readOnly) {
    return {
      externalObjectType: 'File',
      displayValues: { File: input.resource.name },
    };
  }

  const parentEntityId = parseInt(input.parentResult.parentRecord.recordId);

  const fileResponse = await services.document.getFile({ objectUri: input.resource.documentObjectUri });
  if (!fileResponse) {
    return { skipped: true, skipReason: `Could not retrieve file for resource "${input.resource.name}"` };
  }

  const { webStream, ContentType } = fileResponse;
  const blob = await streamToBlob(webStream);

  let fileName = input.resource.name;
  if (extension === '.pdf' && config.prettyDeckNames) {
    const orgName = (input.parentResult.data?.name as string | undefined) ?? 'Company';
    const sanitized = orgName.replace(/\s+/g, '-');
    fileName = `${sanitized}-${format(new Date(), 'MMM-yyyy')}.pdf`;
  }

  const file = new File([blob], encodeURIComponent(fileName), { type: ContentType });

  await operations.getClient().uploadEntityFile({
    entity: { id: parentEntityId },
    file,
  });

  logger.info(`[AffinityV3] Uploaded file "${fileName}" to organization ${parentEntityId}`);

  return {
    externalObjectType: 'File',
    data: { name: fileName, resourceId: input.resource.resourceId },
  };
}

// ── Generic field value writing ──

async function writeFieldValues(
  operations: AffinityOperations,
  options: {
    entityId: number;
    entityType: 'organization' | 'person';
    fieldValues: Record<string, unknown>;
    fieldMappings: V3AdapterExecuteInput['fieldMappings'];
    listEntryId?: number;
    listId?: number;
    forceOverwrite?: boolean;
  },
): Promise<void> {
  const { entityId, entityType, fieldValues, fieldMappings, listEntryId, listId, forceOverwrite } = options;

  // All fieldMappings are custom field values now (built-in properties are in adapterConfig)
  const writableMappings = fieldMappings.filter((m) => {
    const val = fieldValues[String(m.targetField)];
    return val != null && val !== '';
  });

  if (writableMappings.length === 0) return;

  const client = operations.getClient();
  const fields = await client.getFields({
    type: entityType === 'organization' ? 'ORGANIZATION' : 'PERSON',
    limitToListId: listId,
  });

  const entityFieldValues = await client.getFieldValues(
    entityType === 'organization' ? { organization_id: entityId } : { person_id: entityId },
  );
  const listEntryFieldValues = listEntryId
    ? await client.getFieldValues({ list_entry_id: listEntryId })
    : [];
  const entityByFieldId = new Map(
    entityFieldValues.filter((v) => v.list_entry_id == null).map((v) => [v.field_id, v]),
  );
  const listEntryByFieldId = new Map(listEntryFieldValues.map((v) => [v.field_id, v]));

  for (const mapping of writableMappings) {
    const targetField = String(mapping.targetField);
    const value = fieldValues[targetField];
    if (value == null || value === '') continue;

    const fieldDef = fields.find(
      (f) => String(f.id) === targetField || f.name === targetField || f.name.toLowerCase() === targetField.toLowerCase(),
    );
    if (!fieldDef) {
      logger.warn(`[AffinityV3] writeFieldValues: field "${targetField}" not found`);
      continue;
    }

    if (fieldDef.list_id && !listEntryId) continue;

    const existing = fieldDef.list_id
      ? listEntryByFieldId.get(fieldDef.id)
      : entityByFieldId.get(fieldDef.id);
    if (existing && !forceOverwrite) continue;

    const resolvedValue = await resolveFieldValue(operations, fieldDef, value);
    if (resolvedValue === null) continue;

    try {
      if (existing) {
        await client.updateFieldValue({ id: existing.id, value: resolvedValue });
      } else {
        await client.createFieldValue({
          field_id: fieldDef.id,
          value: resolvedValue,
          list_entry_id: fieldDef.list_id && listEntryId ? listEntryId : undefined,
          entity_id: entityId,
        });
      }
    } catch (err) {
      logger.warn(`[AffinityV3] writeFieldValues: failed to write field "${targetField}"`, { err });
    }
  }
}

// ── Field value resolution (pre-resolved values → Affinity API format) ──

async function resolveFieldValue(
  operations: AffinityOperations,
  fieldDef: { value_type: number; dropdown_options?: { id: number; text: string }[] | null },
  value: unknown,
): Promise<unknown> {
  if (fieldDef.value_type === valueType.PERSON) {
    const name = String(value);
    let match = await operations.findMatchingPerson({ name });
    if (!match) {
      match = await operations.createPerson({ name });
    }
    return match ? match.id : null;
  } else if (fieldDef.value_type === valueType.ORGANIZATION) {
    const name = String(value);
    let match: { id: number } | null = await operations.findMatchingOrganisation({ name });
    if (!match) {
      const client = operations.getClient();
      const newOrg = await client.createOrganisation({ name });
      match = newOrg ? { id: newOrg.id } : null;
    }
    return match ? match.id : null;
  } else if (fieldDef.value_type === valueType.LOCATION) {
    const formattedLocation = await anthropicChat({
      model: 'claude-sonnet-5',
      temperature: 0,
      label: 'affinity_location_format',
      system: `You are a location formatter. You will be given a location and you must format it into a string that can be used in a location field.
Output a JSON object with the following keys:
- street_address
- city
- state
- country
- continent

The corresponding values must be a string if an appropriate value appears in the user's input, or null otherwise.

Output: strictly this JSON format. Do not include any additional text.`,
      userMessage: String(value),
    });
    try {
      return locationFieldValue.parse(JSON.parse(formattedLocation));
    } catch {
      return null;
    }
  } else if (fieldDef.value_type === valueType.RANKED_DROPDOWN) {
    const option = fieldDef.dropdown_options?.find((opt) => opt.text === String(value));
    return option ? option.id : null;
  } else if (fieldDef.value_type === valueType.NUMBER) {
    const num = Number(value);
    return isNaN(num) ? null : num;
  } else if (fieldDef.value_type === valueType.DATE) {
    try {
      return new Date(String(value)).toISOString();
    } catch {
      return null;
    }
  }
  // TEXT, DROPDOWN, and other types: pass through as string
  return String(value);
}

// ── Data builders ──

function buildOrgData(org: { id: number; name?: string | null; domain?: string | null; domains?: string[] | null }, webBaseUrl: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (org.name) data.name = org.name;
  if (org.domain) data.domain = org.domain;
  if (org.domains?.length) data.domains = org.domains;
  data.url = `${webBaseUrl}/companies/${org.id}`;
  return data;
}

function buildPersonData(person: { id: number; first_name?: string | null; last_name?: string | null; primary_email?: string | null; emails?: string[] | null }, webBaseUrl: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (person.first_name || person.last_name) {
    data.name = [person.first_name, person.last_name].filter(Boolean).join(' ');
  }
  if (person.primary_email) data.email = person.primary_email;
  if (person.emails?.length) data.emails = person.emails;
  data.url = `${webBaseUrl}/persons/${person.id}`;
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

export { createAffinityV3Adapter };
