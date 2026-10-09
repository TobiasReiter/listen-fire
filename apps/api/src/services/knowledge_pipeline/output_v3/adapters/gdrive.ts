import type { GoogleDriveClient } from '../../../../adapters/google/driveClient';
import type { V3Adapter, V3AdapterExecuteInput, AdapterResult } from './types';

import { services } from '../../../../adapters/registry';
import { logger } from '../../../logger';
import { buildLLMContext, resolvePreserveTags } from '../resolve';
import { anthropicChat } from '../../../../lib/anthropic';
import { HAIKU_MODEL } from '../../../agent_running_state';

function driveUrl(id: string, type: 'folder' | 'file'): string {
  return type === 'folder'
    ? `https://drive.google.com/drive/folders/${id}`
    : `https://drive.google.com/file/d/${id}`;
}

function createGDriveV3Adapter(client: GoogleDriveClient): V3Adapter {
  return {
    async execute(input: V3AdapterExecuteInput): Promise<AdapterResult> {
      const [, actionType] = input.type.split(':');

      if (actionType === 'folder') {
        return executeFolder(client, input);
      } else if (actionType === 'document') {
        return executeDocument(client, input);
      } else if (actionType === 'upload') {
        return executeUpload(client, input);
      }

      logger.warn(`Google Drive v3 adapter: unknown action type "${actionType}"`);
      return {};
    },
  };
}

async function executeFolder(
  client: GoogleDriveClient,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  const config = input.adapterConfig as { parentFolderId: string };

  // Folder name comes from field mappings (e.g., company name)
  const folderName = String(input.fieldValues.name ?? input.fieldValues.title ?? 'Untitled');

  // Determine parent: nested folder uses parentFolder from parent result, root uses config
  const parentId = input.parentResult?.parentFolder?.folderId ?? config.parentFolderId;

  // Tier 0: linked object — already created this folder before
  if (input.linkedObjects.length > 0) {
    const existing = input.linkedObjects[0];
    logger.info(`[GDrive] Reusing existing folder ${existing.externalId}`);
    return {
      externalId: existing.externalId,
      externalObjectType: 'Folder',
      data: existing.data,
      parentFolder: { folderId: existing.externalId },
    };
  }

  // Tier 1: search by name within parent
  const existingId = await client.findFolder({ name: folderName, parentId });
  if (existingId) {
    logger.info(`[GDrive] Found existing folder "${folderName}" → ${existingId}`);
    return {
      externalId: existingId,
      externalObjectType: 'Folder',
      data: { name: folderName, url: driveUrl(existingId, 'folder') },
      parentFolder: { folderId: existingId },
    };
  }

  // Create new folder
  const folder = await client.createFolder({ name: folderName, parentId });
  logger.info(`[GDrive] Created folder "${folderName}" → ${folder.id}`);

  return {
    externalId: folder.id,
    created: true,
    externalObjectType: 'Folder',
    data: { name: folderName, url: folder.webViewLink },
    parentFolder: { folderId: folder.id },
  };
}

async function executeDocument(
  client: GoogleDriveClient,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  if (!input.parentResult?.parentFolder) {
    throw new Error('Google Drive document requires a parent folder');
  }

  const config = input.adapterConfig as {
    titlePrompt?: string;
    contentPrompt: string;
  };

  const llmContext = await buildLLMContext([input.contextNodeId], input.context);
  if (!llmContext) return { skipped: true, skipReason: 'No context available for document generation' };

  // Generate content
  const content = await anthropicChat({
    system: `You are an intelligent function in a data extraction system.

The user will provide entity data along with the source document it was extracted from. Your task:
${config.contentPrompt}

Return ONLY the text. No XML, no labels, no preamble — just the content.`,
    userMessage: llmContext,
    model: HAIKU_MODEL,
    label: 'output_gdrive_document_content',
  });

  let trimmedContent = content.trim();
  if (!trimmedContent) return { skipped: true, skipReason: 'LLM returned empty document content' };
  if (input.afterEmbedValues?.size) trimmedContent = resolvePreserveTags(trimmedContent, input.afterEmbedValues);

  // Generate title
  let title = 'Document';
  if (config.titlePrompt) {
    const titleResult = await anthropicChat({
      system: `You are an intelligent function in a data extraction system.

The user will provide entity data along with the source document it was extracted from. Your task:
${config.titlePrompt}

Return ONLY the text. No XML, no labels, no preamble — just the content.`,
      userMessage: llmContext,
      model: HAIKU_MODEL,
      label: 'output_gdrive_document_title',
    });
    let trimmedTitle = titleResult.trim();
    if (input.afterEmbedValues?.size) trimmedTitle = resolvePreserveTags(trimmedTitle, input.afterEmbedValues);
    if (trimmedTitle) title = trimmedTitle;
  }

  const doc = await client.createDocument({
    name: title,
    content: trimmedContent,
    parentId: input.parentResult.parentFolder.folderId,
  });

  return {
    externalId: doc.id,
    created: true,
    externalObjectType: 'Document',
    data: { title, url: doc.webViewLink },
  };
}

// resource-oriented upload
async function executeUpload(
  client: GoogleDriveClient,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  if (!input.parentResult?.parentFolder) {
    throw new Error('Google Drive upload requires a parent folder');
  }

  if (!input.resource) {
    return { skipped: true, skipReason: 'Context node has no attached resource to upload' };
  }

  if (!input.resource.documentObjectUri) {
    return { skipped: true, skipReason: `Resource "${input.resource.name}" has no downloadable document` };
  }

  const parentId = input.parentResult.parentFolder.folderId;

  try {
    const stream = await services.document.getFileNodeStream({ objectUri: input.resource.documentObjectUri });
    const result = await client.uploadFile({
      name: input.resource.name,
      parentId,
      stream,
      mimeType: stream.contentType,
    });
    logger.info(`[GDrive] Uploaded "${input.resource.name}" → ${result.id}`);

    return {
      externalId: result.id,
      created: true,
      externalObjectType: 'Upload',
      data: { name: input.resource.name, url: driveUrl(result.id, 'file'), resourceId: input.resource.resourceId },
    };
  } catch (err) {
    logger.error(`[GDrive] Failed to upload "${input.resource.name}"`, { error: err });
    return { skipped: true, skipReason: `Upload failed: ${err}` };
  }
}

export { createGDriveV3Adapter };
