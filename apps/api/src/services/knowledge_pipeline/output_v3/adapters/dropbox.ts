import type { DropboxClient } from '../../../../adapters/dropbox/apiClient';
import type { V3Adapter, V3AdapterExecuteInput, AdapterResult } from './types';

import { services } from '../../../../adapters/registry';
import { logger } from 'movement-engine/services/logger';
import { buildLLMContext, resolvePreserveTags } from '../resolve';
import { anthropicChat } from '../../../../lib/anthropic';
import { HAIKU_MODEL } from '../../../agent_running_state';

function dropboxWebUrl(path: string): string {
  return `https://www.dropbox.com/home${path}`;
}

function createDropboxV3Adapter(client: DropboxClient): V3Adapter {
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

      logger.warn(`Dropbox v3 adapter: unknown action type "${actionType}"`);
      return {};
    },
  };
}

async function executeFolder(
  client: DropboxClient,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  const config = input.adapterConfig as { parentFolderPath: string };

  const folderName = String(input.fieldValues.name ?? input.fieldValues.title ?? 'Untitled');
  const parentPath = input.parentResult?.parentFolder?.folderId ?? config.parentFolderPath;

  // Tier 0: linked object — already created this folder before
  if (input.linkedObjects.length > 0) {
    const existing = input.linkedObjects[0];
    logger.info(`[Dropbox] Reusing existing folder ${existing.externalId}`);
    return {
      externalId: existing.externalId,
      externalObjectType: 'Folder',
      data: existing.data,
      parentFolder: { folderId: existing.externalId },
    };
  }

  // Tier 1: search by name within parent
  const existingPath = await client.findFolder({ name: folderName, parentPath });
  if (existingPath) {
    logger.info(`[Dropbox] Found existing folder "${folderName}" → ${existingPath}`);
    return {
      externalId: existingPath,
      externalObjectType: 'Folder',
      data: { name: folderName, path: existingPath, url: dropboxWebUrl(existingPath) },
      parentFolder: { folderId: existingPath },
    };
  }

  // Create new folder
  const folder = await client.createFolder({ name: folderName, parentPath });
  logger.info(`[Dropbox] Created folder "${folderName}" → ${folder.path}`);

  return {
    externalId: folder.path,
    created: true,
    externalObjectType: 'Folder',
    data: { name: folderName, path: folder.path, url: dropboxWebUrl(folder.path) },
    parentFolder: { folderId: folder.path },
  };
}

async function executeDocument(
  client: DropboxClient,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  if (!input.parentResult?.parentFolder) {
    throw new Error('Dropbox document requires a parent folder');
  }

  const config = input.adapterConfig as {
    titlePrompt?: string;
    contentPrompt: string;
  };

  const llmContext = await buildLLMContext([input.contextNodeId], input.context);
  if (!llmContext) return { skipped: true, skipReason: 'No context available for document generation' };

  const content = await anthropicChat({
    system: `You are an intelligent function in a data extraction system.

The user will provide entity data along with the source document it was extracted from. Your task:
${config.contentPrompt}

Return ONLY the text. No XML, no labels, no preamble — just the content.`,
    userMessage: llmContext,
    model: HAIKU_MODEL,
    label: 'output_dropbox_document_content',
  });

  let trimmedContent = content.trim();
  if (!trimmedContent) return { skipped: true, skipReason: 'LLM returned empty document content' };
  if (input.afterEmbedValues?.size) trimmedContent = resolvePreserveTags(trimmedContent, input.afterEmbedValues);

  let title = 'Document';
  if (config.titlePrompt) {
    const titleResult = await anthropicChat({
      system: `You are an intelligent function in a data extraction system.

The user will provide entity data along with the source document it was extracted from. Your task:
${config.titlePrompt}

Return ONLY the text. No XML, no labels, no preamble — just the content.`,
      userMessage: llmContext,
      model: HAIKU_MODEL,
      label: 'output_dropbox_document_title',
    });
    let trimmedTitle = titleResult.trim();
    if (input.afterEmbedValues?.size) trimmedTitle = resolvePreserveTags(trimmedTitle, input.afterEmbedValues);
    if (trimmedTitle) title = trimmedTitle;
  }

  const fileName = title.endsWith('.txt') ? title : `${title}.txt`;
  const result = await client.createTextFile({
    name: fileName,
    content: trimmedContent,
    parentPath: input.parentResult.parentFolder.folderId,
  });

  return {
    externalId: result.path,
    created: true,
    externalObjectType: 'Document',
    data: { title, path: result.path, url: dropboxWebUrl(result.path) },
  };
}

async function executeUpload(
  client: DropboxClient,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  if (!input.parentResult?.parentFolder) {
    throw new Error('Dropbox upload requires a parent folder');
  }

  if (!input.resource) {
    return { skipped: true, skipReason: 'Context node has no attached resource to upload' };
  }

  if (!input.resource.documentObjectUri) {
    return { skipped: true, skipReason: `Resource "${input.resource.name}" has no downloadable document` };
  }

  const parentPath = input.parentResult.parentFolder.folderId;

  try {
    const stream = await services.document.getFileNodeStream({ objectUri: input.resource.documentObjectUri });
    const result = await client.uploadFile({
      name: input.resource.name,
      parentPath,
      stream,
      mimeType: stream.contentType,
    });
    logger.info(`[Dropbox] Uploaded "${input.resource.name}" → ${result.path}`);

    return {
      externalId: result.path,
      created: true,
      externalObjectType: 'Upload',
      data: { name: input.resource.name, path: result.path, url: dropboxWebUrl(result.path), resourceId: input.resource.resourceId },
    };
  } catch (err) {
    logger.error(`[Dropbox] Failed to upload "${input.resource.name}"`, { error: err });
    return { skipped: true, skipReason: `Upload failed: ${err}` };
  }
}

export { createDropboxV3Adapter };
