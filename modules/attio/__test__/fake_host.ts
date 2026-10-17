// What an Attio adapter test builds it over: a tenant, a client every test
// replaces, and files the host holds by handle.

import type { FileRef } from 'movement-engine/public/adapter';

import type { AttioHost } from '../adapter';

const heldFiles = new Map<string, Uint8Array>();

const testFiles = {
  put: async (): Promise<never> => {
    throw new Error('no put in this test');
  },
  read: async (ref: FileRef): Promise<Uint8Array> => {
    const source = ref.source;
    const bytes = source !== undefined && 'handle' in source && typeof source.handle === 'string' ? heldFiles.get(source.handle) : undefined;
    if (bytes === undefined) throw new Error(`no such file: ${ref.name ?? '(unnamed)'}`);
    return bytes;
  },
  expose: async (): Promise<never> => {
    throw new Error('no expose in this test');
  },
};

export function testHost(tenant: string): AttioHost {
  return {
    tenant,
    client: async () => {
      throw new Error('this test replaces the client');
    },
    files: testFiles,
    fetch,
  };
}

export function testFileStore(): { file(bytes: Uint8Array | string, meta: { name?: string; contentType?: string }): FileRef } {
  return {
    file(bytes, meta) {
      const handle = `held-${heldFiles.size + 1}`;
      heldFiles.set(handle, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
      return { __brand: 'FileRef', ...meta, source: { adapterType: 'test', handle } };
    },
  };
}
