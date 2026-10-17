// Files through a module, both ways and over both transports. Out: a file the
// module reads out names itself by its handle, and the host names it as the
// install's (in process, `ownedFilesAdapter`; over protocol 2, the remote
// adapter), so its bytes are redeemed through the module's `resolveFileRef`
// — over protocol 2 at a URL serve-module holds for one fetch. In: a file
// handed to a write is read at its url, else through `ctx.files`.

import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';

import type { Adapter, FileRef } from 'movement-engine/public/adapter';

import { fileValue } from 'movement-engine/public/adapter';
import { makeStablePosition } from 'movement-engine/public/catalog';
import { createRemoteAdapter, fetchRemoteManifest, ownedFilesAdapter } from 'movement-engine/public/modules';

import type { ModuleFiles, ModuleLog, ServedFiles } from '../index';

import { adapterInProcess, moduleFileRef, noCredential, readHandedFile, refusingKv, servedFiles, serveModule } from '../index';
import blobs, { blobBytes } from './modules/blobs_module';

const quiet: ModuleLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const blob = (id: string) => makeStablePosition({ adapterType: 'blobs', recordType: 'Blob', recordId: id, data: {} });
const ownedBy = (handle: string) => ({ adapterType: 'blobs', credentialId: 'cred-1', handle });
const mutationContext = { source: { type: 'api' as const }, occurredAt: '2026-10-17T00:00:00.000Z' };

async function text(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** A server that only holds files, as a host exposing bytes for a write. */
async function fileHost(): Promise<{ origin: string; files: ServedFiles; close(): Promise<void> }> {
  const files = servedFiles();
  const server = createServer((req, res) => {
    if (!files.serve(req, res)) res.writeHead(400).end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { origin: `http://127.0.0.1:${port}`, files, close: () => new Promise<void>((done) => server.close(() => done())) };
}

function inProcess(files: ModuleFiles): Adapter {
  const loaded = adapterInProcess(blobs, {
    tenant: 'team-1',
    credential: noCredential('none'),
    log: quiet,
    files,
    kv: refusingKv('none'),
    validateResults: true,
  });
  return ownedFilesAdapter(loaded.adapter, { adapterType: 'blobs', credentialsId: 'cred-1' });
}

describe('a file a module reads out', () => {
  it('is spelled by the module with its own handle', () => {
    expect(moduleFileRef({ adapterType: 'blobs', handle: 'b1', name: 'b1.txt' })).toEqual({
      __brand: 'FileRef',
      name: 'b1.txt',
      source: { ownerAdapterType: 'blobs', handle: 'b1' },
    });
  });

  it('in process, is named as the install’s, and its bytes come from the module', async () => {
    const adapter = inProcess({ put: async () => Promise.reject(new Error('no')), expose: async () => Promise.reject(new Error('no')), read: async () => Promise.reject(new Error('no')) });
    const ref = await adapter.getFieldValue({ position: blob('b1'), fieldId: 'Bytes' });
    expect(ref).toEqual({ __brand: 'FileRef', name: 'b1.txt', contentType: 'text/plain', source: ownedBy('b1') });
    // A field the catalog does not declare a file stays as it came.
    expect(await adapter.getFieldValue({ position: blob('b1'), fieldId: 'Name' })).toEqual({ label: 'b1' });
    const resolved = await adapter.resolveFileRef?.({ ref: ref as FileRef });
    expect(await text(resolved?.stream ?? Readable.from([]))).toBe(blobBytes('b1'));
  });
});

describe('a module served as a process', () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    const served = await serveModule({ definition: blobs, log: quiet });
    server = served.server;
    url = `http://127.0.0.1:${served.port}/`;
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  async function remote(): Promise<Adapter> {
    const config = { adapterType: 'blobs', teamId: 'team-1', baseUrl: url, authStrategy: { kind: 'bearer' as const }, credentialsId: 'cred-1' };
    return createRemoteAdapter({ config, secret: '', cacheScopeId: 's', manifest: await fetchRemoteManifest(config, ''), documents: {} as never });
  }

  it('names the files it reads out as the install’s, and serves their bytes at a URL of its own, once', async () => {
    const adapter = await remote();
    const ref = await adapter.getFieldValue({ position: blob('b2'), fieldId: 'Bytes' });
    expect(ref).toEqual({ __brand: 'FileRef', name: 'b2.txt', contentType: 'text/plain', source: ownedBy('b2') });
    const resolved = await adapter.resolveFileRef?.({ ref: ref as FileRef });
    expect(resolved?.contentType).toBe('text/plain');
    expect(await text(resolved?.stream ?? Readable.from([]))).toBe(blobBytes('b2'));
  });

  it('holds a file for one fetch only', async () => {
    const host = await fileHost();
    try {
      const held = host.files.expose({ stream: Readable.from(['once']), contentType: 'text/plain' }, host.origin);
      const first = await fetch(held);
      expect([first.status, first.headers.get('content-type'), await first.text()]).toEqual([200, 'text/plain', 'once']);
      expect((await fetch(held)).status).toBe(404);
    } finally {
      await host.close();
    }
  });

  it('refuses with the module’s own message when the bytes cannot be resolved', async () => {
    const adapter = await remote();
    await expect(adapter.resolveFileRef?.({ ref: { __brand: 'FileRef', source: ownedBy('missing') } })).rejects.toThrow('blobs: no blob "missing"');
  });

  it('reads a file handed to a write at its url', async () => {
    const adapter = await remote();
    const ref = (await adapter.getFieldValue({ position: blob('b3'), fieldId: 'Bytes' })) as FileRef;
    // The host exposes the bytes for the write, as the hosted document store does.
    const host = await fileHost();
    try {
      const exposed = { ...ref, url: host.files.expose({ stream: Readable.from([Buffer.from('handed bytes')]) }, host.origin) };
      const written = await adapter.createRecord({ recordType: 'Blob', fields: { Bytes: fileValue(exposed) }, mutationContext });
      expect(written.externalId).toBe('handed bytes');
    } finally {
      await host.close();
    }
  });
});

describe('a file handed to a module', () => {
  it('is read at its url when it has one', async () => {
    const fetched: string[] = [];
    const ctx = {
      fetch: (async (input: string | URL | Request) => {
        fetched.push(String(input));
        return new Response('from the url');
      }) as typeof fetch,
      files: { put: async () => Promise.reject(new Error('no')), expose: async () => Promise.reject(new Error('no')), read: async () => Promise.reject(new Error('not through files')) },
    };
    const bytes = await readHandedFile(ctx, { __brand: 'FileRef', url: 'https://files.test/1' });
    expect(Buffer.from(bytes).toString('utf8')).toBe('from the url');
    expect(fetched).toEqual(['https://files.test/1']);
  });

  it('refuses a url that does not answer', async () => {
    const ctx = {
      fetch: (async () => new Response('gone', { status: 410 })) as typeof fetch,
      files: { put: async () => Promise.reject(new Error('no')), expose: async () => Promise.reject(new Error('no')), read: async () => Promise.reject(new Error('no')) },
    };
    await expect(readHandedFile(ctx, { __brand: 'FileRef', name: 'a.txt', url: 'https://files.test/1' })).rejects.toThrow(
      "the file 'a.txt' could not be fetched from its url (status 410)",
    );
  });

  it('in process, without a url, is read through the host’s files', async () => {
    const read: FileRef[] = [];
    const adapter = inProcess({
      put: async () => Promise.reject(new Error('no')),
      expose: async () => Promise.reject(new Error('no')),
      read: async (ref) => {
        read.push(ref);
        return new Uint8Array(Buffer.from('from the host'));
      },
    });
    const ref: FileRef = { __brand: 'FileRef', source: { store: 'document', objectUri: 's3://doc' } };
    const written = await adapter.createRecord({ recordType: 'Blob', fields: { Bytes: fileValue(ref) }, mutationContext });
    expect(written.externalId).toBe('from the host');
    expect(read).toEqual([ref]);
  });
});
