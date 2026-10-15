// Files attached to a conversation — the read side.
//
// The web assistant uploads files through `/api/upload_retrievable`
// (DocumentService.createAndUpload → S3) and records the resulting
// document ids on the user message (`metadata.uploadedDocumentIds`,
// written by the queryAgent tRPC view). This module is how an agent
// gets at those files later: enumerate everything attached across the
// conversation, and read a single file back as text.
//
// Text comes from the existing extraction path, in order of preference:
//   1. `document.rawTextId` → the already-extracted RawText row.
//   2. For .pdf / .pptx / .xlsx: run the extract_document_text tool
//      (OCR / office parsers), which persists rawTextId for next time.
//   3. Plain-text fallback: read the stored object as UTF-8 (covers
//      .txt / .csv / .md / .json uploads that never need extraction).
//
// Deliberately NOT here: the raw-SQL bulk-import tools the legacy query
// agent layered on top of uploads. The unified agent reads files; it
// does not bulk-import through them.

import { currentContext } from '../../services/context';
import { services } from '../../adapters/registry';
import { logger } from 'movement-engine/services/logger';
import { extractDocumentTextTool } from '../agent/tools/extract_document_text';

const EXTRACTABLE_EXTENSIONS = ['.pdf', '.pptx', '.xlsx'];

export interface ConversationFile {
  index: number;
  filename: string;
}

/**
 * Every document id attached to this conversation, oldest first,
 * deduplicated. Read from the user messages' metadata — the same rows
 * the tRPC view writes at send time — so the current turn's uploads are
 * already visible by the time the agent runs.
 */
export async function collectConversationDocumentIds(conversationId: string): Promise<string[]> {
  const ctx = currentContext();
  const messages = await ctx.prisma.agentMessage.findMany({
    where: { conversationId, role: 'user' },
    orderBy: { createdAt: 'asc' },
    select: { metadata: true },
  });

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    const meta = msg.metadata as Record<string, unknown> | null;
    if (!meta || !Array.isArray(meta.uploadedDocumentIds)) continue;
    for (const id of meta.uploadedDocumentIds) {
      if (typeof id === 'string' && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

export async function listConversationFiles(conversationId: string): Promise<ConversationFile[]> {
  const ctx = currentContext();
  const documentIds = await collectConversationDocumentIds(conversationId);
  const files: ConversationFile[] = [];
  for (let i = 0; i < documentIds.length; i++) {
    const doc = await ctx.prisma.document.findUnique({
      where: { id: documentIds[i] },
      select: { description: true },
    });
    if (doc) files.push({ index: i, filename: doc.description ?? 'document' });
  }
  return files;
}

export async function readConversationFile(options: {
  conversationId: string;
  index: number;
}): Promise<{ filename: string; content: string } | { error: string }> {
  const { conversationId, index } = options;
  const documentIds = await collectConversationDocumentIds(conversationId);
  if (documentIds.length === 0) {
    return { error: 'No files have been attached to this conversation.' };
  }
  if (index < 0 || index >= documentIds.length) {
    return { error: `Invalid file index ${index}. Use listUploadedFiles to see the available files.` };
  }
  return readDocumentText(documentIds[index]);
}

async function readDocumentText(
  documentId: string,
): Promise<{ filename: string; content: string } | { error: string }> {
  const ctx = currentContext();
  const doc = await ctx.prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, description: true, objectUri: true, rawTextId: true },
  });
  if (!doc?.objectUri) return { error: 'Could not find this file.' };

  const filename = doc.description ?? 'document';

  const fromRawText = async (rawTextId: string) => {
    const rawText = await ctx.prisma.rawText.findUnique({
      where: { id: rawTextId },
      select: { content: true },
    });
    return rawText?.content ?? null;
  };

  if (doc.rawTextId) {
    const content = await fromRawText(doc.rawTextId);
    if (content) return { filename, content };
  }

  // Not yet extracted — run the existing extraction tool for formats
  // that need it (persists rawTextId so the next read is cheap).
  if (EXTRACTABLE_EXTENSIONS.some((ext) => filename.toLowerCase().endsWith(ext))) {
    try {
      const result = await extractDocumentTextTool({ documentId });
      if (result.type === 'DOCUMENT_WITH_CONTENT') {
        const content = await fromRawText(result.rawTextId);
        if (content) return { filename, content };
      }
    } catch (err) {
      logger.warn('[conversation_files] text extraction failed', {
        documentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { error: `Could not extract text from "${filename}".` };
  }

  // Plain-text formats: read the stored object directly.
  try {
    const file = await services.document.getFile({ objectUri: doc.objectUri });
    if (!file) return { error: 'Could not read this file.' };
    const chunks: Buffer[] = [];
    const reader = file.webStream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    const text = Buffer.concat(chunks).toString('utf-8');
    if (!text.trim() || text.includes('\u0000')) {
      return { error: `"${filename}" does not contain readable text.` };
    }
    return { filename, content: text };
  } catch {
    return { error: 'Could not read this file.' };
  }
}
