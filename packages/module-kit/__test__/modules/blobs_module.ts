// A small adapter module for the kit's file tests: one `Blob` type whose
// `Bytes` field is a file the module serves from its "provider" (bytes it
// makes from the handle), and a write that reads the file it is handed.

import { Readable } from 'node:stream';

import type { Adapter, FileRef } from 'movement-engine/public/adapter';

import { BASE_RUNTIME_CAPABILITIES, isFileValue } from 'movement-engine/public/adapter';

import { defineModule, type ModuleContext } from '../../define';
import { moduleFileRef, readHandedFile } from '../../files';

export const BLOBS_MANIFEST = {
  adapterType: 'blobs',
  displayName: 'Blobs',
  description: 'A blob store.',
  supportedTriggers: [] as const,
  methods: ['listEntryPoints', 'describe', 'getFieldValue', 'getRelated', 'createRecord', 'resolveFileRef'],
};

/** The bytes the provider holds for a handle. */
export const blobBytes = (handle: string): string => `the bytes of ${handle}`;

function blobsAdapter(ctx: ModuleContext): Adapter {
  return {
    adapterType: 'blobs',
    supportedTriggers: [],
    runtimeCapabilities: () => BASE_RUNTIME_CAPABILITIES,
    listEntryPoints: async () => [{ typeId: 'Blob', displayName: 'Blob', readable: true, writable: true, collectionName: 'Blobs' }],
    describe: async (typeId) =>
      typeId === 'Blob'
        ? {
            typeId: 'Blob',
            displayName: 'Blob',
            fields: [
              { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: false },
              { fieldId: 'bytes', displayName: 'Bytes', kind: 'file', writable: true, required: false },
            ],
            references: [],
          }
        : null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async ({ position, fieldId }) => {
      const id = position.identity.kind === 'stable' ? position.identity.recordId : '';
      if (fieldId === 'Name') return { label: id };
      if (fieldId === 'Bytes') return moduleFileRef({ adapterType: 'blobs', handle: id, name: `${id}.txt`, contentType: 'text/plain' });
      return null;
    },
    getRelated: async () => [],
    resolveFileRef: async ({ ref }: { ref: FileRef }) => {
      const source = ref.source;
      const handle = source !== undefined && 'handle' in source ? source.handle : undefined;
      if (handle === undefined) throw new Error('blobs: the file names no blob');
      if (handle === 'missing') throw new Error('blobs: no blob "missing"');
      return { stream: Readable.from([Buffer.from(blobBytes(handle))]), contentType: 'text/plain' };
    },
    createRecord: async ({ fields }) => {
      const ref = fields.Bytes;
      if (!isFileValue(ref)) throw new Error('blobs: Bytes is not a file');
      const bytes = await readHandedFile(ctx, ref);
      return { adapterType: 'blobs', externalId: Buffer.from(bytes).toString('utf8'), data: {} };
    },
    updateRecord: async () => {
      throw new Error('blobs: no updates');
    },
    deleteRecord: async () => {
      throw new Error('blobs: no deletes');
    },
  };
}

export default defineModule({
  kind: 'adapter',
  name: '@lf/blobs',
  manifest: BLOBS_MANIFEST,
  credentials: [],
  create: blobsAdapter,
});
