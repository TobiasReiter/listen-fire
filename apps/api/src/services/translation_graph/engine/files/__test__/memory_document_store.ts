// An in-memory document store for tests that write files. A FileRef is a
// descriptor, so a test that hands a target adapter a file stores the bytes
// here and hands over the descriptor; the adapter redeems it through the real
// `streamFileRef`, exactly as production does.

import { Readable } from 'node:stream';

import { services } from '../../../../../adapters/registry';
import type { DocumentProvider } from '../../../../../adapters/document/interface';
import type { FileRef } from '../../../adapter';

export interface MemoryDocumentStore {
  /** Store `content` and answer the descriptor of the stored file. */
  file(content: string | Buffer, meta?: { name?: string; contentType?: string }): FileRef;
}

/** Install a fresh in-memory store as `services.document`. */
export function installMemoryDocumentStore(): MemoryDocumentStore {
  const stored = new Map<string, { bytes: Buffer; contentType?: string }>();
  let next = 0;
  const put = (bytes: Buffer, contentType?: string): string => {
    const objectUri = `mem://doc/${++next}`;
    stored.set(objectUri, { bytes, ...(contentType !== undefined ? { contentType } : {}) });
    return objectUri;
  };
  const read = (objectUri: string) => {
    const entry = stored.get(objectUri);
    if (entry === undefined) throw new Error(`test document store: no ${objectUri}`);
    return entry;
  };
  const provider: DocumentProvider = {
    async upload(readable, { mimeType }) {
      const chunks: Buffer[] = [];
      for await (const chunk of readable) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return { objectUri: put(Buffer.concat(chunks), mimeType), checksum: 'test' };
    },
    async getFile({ objectUri }) {
      const entry = read(objectUri);
      return {
        webStream: new Blob([entry.bytes]).stream(),
        ContentLength: entry.bytes.byteLength,
        ContentType: entry.contentType,
      };
    },
    async getFileNodeStream({ objectUri }) {
      const entry = read(objectUri);
      return Object.assign(Readable.from(entry.bytes), {
        size: entry.bytes.byteLength,
        ...(entry.contentType !== undefined ? { contentType: entry.contentType } : {}),
      });
    },
    async getDownloadUrl({ objectUri }) {
      return `https://test-store.example/${encodeURIComponent(objectUri)}`;
    },
    async delete(uri) {
      stored.delete(uri);
    },
  };
  services.document = provider;
  return {
    file(content, meta = {}) {
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
      return {
        __brand: 'FileRef',
        ...(meta.name !== undefined ? { name: meta.name } : {}),
        ...(meta.contentType !== undefined ? { contentType: meta.contentType } : {}),
        size: bytes.byteLength,
        source: { store: 'document', objectUri: put(bytes, meta.contentType) },
      };
    },
  };
}
