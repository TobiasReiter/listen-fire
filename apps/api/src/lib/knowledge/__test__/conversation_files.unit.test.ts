/**
 * Conversation file reads — the backbone of the assistant's
 * `files.read` scope (listUploadedFiles / readUploadedFile).
 *
 * Covers:
 *  1. Document ids are collected from user-message metadata across the
 *     whole conversation, oldest first, deduplicated.
 *  2. listConversationFiles resolves filenames from document rows and
 *     skips ids whose document no longer exists.
 *  3. readConversationFile prefers the already-extracted RawText row.
 *  4. .pdf uploads without rawText go through the existing extraction
 *     tool (extract_document_text), then read the persisted RawText.
 *  5. Plain-text uploads without rawText are read straight from
 *     storage; binary garbage is refused rather than returned.
 *  6. Out-of-range / empty-conversation indices return friendly errors.
 */

const mockMessages: any[] = [];
const mockDocumentsById = new Map<string, any>();
const mockRawTextsById = new Map<string, any>();

jest.mock('../../../services/context', () => ({
  currentContext: () => ({
    prisma: {
      agentMessage: {
        findMany: jest.fn(async () => mockMessages),
      },
      document: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
          mockDocumentsById.get(where.id) ?? null,
        ),
      },
      rawText: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
          mockRawTextsById.get(where.id) ?? null,
        ),
      },
    },
  }),
}));

jest.mock('movement-engine/services/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockGetFile = jest.fn();
jest.mock('../../../adapters/registry', () => ({
  services: {
    document: {
      getFile: (...args: any[]) => mockGetFile(...args),
    },
  },
}));

const mockExtract = jest.fn();
jest.mock('../../agent/tools/extract_document_text', () => ({
  extractDocumentTextTool: (...args: any[]) => mockExtract(...args),
}));

import {
  collectConversationDocumentIds,
  listConversationFiles,
  readConversationFile,
} from '../conversation_files';

function userMessage(uploadedDocumentIds?: string[]) {
  return {
    role: 'user',
    metadata: uploadedDocumentIds ? { uploadedDocumentIds } : null,
  };
}

function webStreamOf(text: string | Buffer) {
  const buf = typeof text === 'string' ? Buffer.from(text, 'utf-8') : text;
  let done = false;
  return {
    webStream: {
      getReader: () => ({
        read: async () => {
          if (done) return { done: true, value: undefined };
          done = true;
          return { done: false, value: buf };
        },
      }),
    },
  };
}

beforeEach(() => {
  mockMessages.length = 0;
  mockDocumentsById.clear();
  mockRawTextsById.clear();
  mockGetFile.mockReset();
  mockExtract.mockReset();
});

describe('collectConversationDocumentIds', () => {
  it('collects ids across messages, oldest first, deduplicated', async () => {
    mockMessages.push(
      userMessage(['doc-a', 'doc-b']),
      userMessage(),
      userMessage(['doc-b', 'doc-c']),
    );
    const ids = await collectConversationDocumentIds('conv-1');
    expect(ids).toEqual(['doc-a', 'doc-b', 'doc-c']);
  });

  it('returns empty for a conversation with no uploads', async () => {
    mockMessages.push(userMessage(), userMessage());
    expect(await collectConversationDocumentIds('conv-1')).toEqual([]);
  });
});

describe('listConversationFiles', () => {
  it('resolves filenames and keeps stable indices', async () => {
    mockMessages.push(userMessage(['doc-a', 'doc-gone', 'doc-b']));
    mockDocumentsById.set('doc-a', { description: 'notes.txt' });
    mockDocumentsById.set('doc-b', { description: 'deck.pdf' });
    const files = await listConversationFiles('conv-1');
    expect(files).toEqual([
      { index: 0, filename: 'notes.txt' },
      { index: 2, filename: 'deck.pdf' },
    ]);
  });
});

describe('readConversationFile', () => {
  it('returns extracted RawText content when present', async () => {
    mockMessages.push(userMessage(['doc-a']));
    mockDocumentsById.set('doc-a', {
      id: 'doc-a',
      description: 'deck.pdf',
      objectUri: 's3://x/deck.pdf',
      rawTextId: 'rt-1',
    });
    mockRawTextsById.set('rt-1', { content: 'Extracted deck text' });

    const result = await readConversationFile({ conversationId: 'conv-1', index: 0 });
    expect(result).toEqual({ filename: 'deck.pdf', content: 'Extracted deck text' });
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it('extracts a .pdf without rawText through the extraction tool', async () => {
    mockMessages.push(userMessage(['doc-a']));
    mockDocumentsById.set('doc-a', {
      id: 'doc-a',
      description: 'deck.pdf',
      objectUri: 's3://x/deck.pdf',
      rawTextId: null,
    });
    mockExtract.mockImplementation(async () => {
      mockRawTextsById.set('rt-new', { content: 'OCR text' });
      return { type: 'DOCUMENT_WITH_CONTENT', documentId: 'doc-a', rawTextId: 'rt-new' };
    });

    const result = await readConversationFile({ conversationId: 'conv-1', index: 0 });
    expect(result).toEqual({ filename: 'deck.pdf', content: 'OCR text' });
    expect(mockExtract).toHaveBeenCalledWith({ documentId: 'doc-a' });
  });

  it('surfaces an error when extraction fails', async () => {
    mockMessages.push(userMessage(['doc-a']));
    mockDocumentsById.set('doc-a', {
      id: 'doc-a',
      description: 'deck.pdf',
      objectUri: 's3://x/deck.pdf',
      rawTextId: null,
    });
    mockExtract.mockRejectedValue(new Error('OCR down'));

    const result = await readConversationFile({ conversationId: 'conv-1', index: 0 });
    expect(result).toEqual({ error: 'Could not extract text from "deck.pdf".' });
  });

  it('reads plain-text uploads straight from storage', async () => {
    mockMessages.push(userMessage(['doc-a']));
    mockDocumentsById.set('doc-a', {
      id: 'doc-a',
      description: 'notes.txt',
      objectUri: 's3://x/notes.txt',
      rawTextId: null,
    });
    mockGetFile.mockResolvedValue(webStreamOf('hello world'));

    const result = await readConversationFile({ conversationId: 'conv-1', index: 0 });
    expect(result).toEqual({ filename: 'notes.txt', content: 'hello world' });
  });

  it('refuses binary content masquerading as text', async () => {
    mockMessages.push(userMessage(['doc-a']));
    mockDocumentsById.set('doc-a', {
      id: 'doc-a',
      description: 'blob.bin',
      objectUri: 's3://x/blob.bin',
      rawTextId: null,
    });
    mockGetFile.mockResolvedValue(webStreamOf(Buffer.from([0x68, 0x69, 0x00, 0x01])));

    const result = await readConversationFile({ conversationId: 'conv-1', index: 0 });
    expect(result).toEqual({ error: '"blob.bin" does not contain readable text.' });
  });

  it('returns friendly errors for empty conversations and bad indices', async () => {
    expect(await readConversationFile({ conversationId: 'conv-1', index: 0 })).toEqual({
      error: 'No files have been attached to this conversation.',
    });

    mockMessages.push(userMessage(['doc-a']));
    expect(await readConversationFile({ conversationId: 'conv-1', index: 5 })).toEqual({
      error: 'Invalid file index 5. Use listUploadedFiles to see the available files.',
    });
  });
});
