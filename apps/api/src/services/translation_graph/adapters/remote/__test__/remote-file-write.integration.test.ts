// Writing a file INTO a remote adapter over real HTTP.
//
// Raw bytes can't ride the JSON wire, so when a FileRef is written to a remote
// adapter the boundary buffers the bytes to S3 (`exposeFile`) and sends a
// fetchable URL on the wire FileRef. This proves the RemoteAdapter does that:
// it stands up a target over a real socket, writes a record whose field holds a
// FileRef descriptor of a stored file, and asserts the bytes were redeemed and
// exposed and the target RECEIVED a wire FileRef carrying the exposed `url`, its
// source in the wire's spelling. `exposeFile` is mocked so the test needs no S3
// / Postgres; the document store is in memory.

import http from 'node:http';
import type { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';

import type { Adapter } from '../../../adapter';
import { installMemoryDocumentStore } from '../../../engine/files/__test__/memory_document_store';
import { createAdapterProtocolHandler } from '../../../protocol/server';
import { createRemoteAdapter, fetchRemoteManifest, RemoteAdapter } from '../index';
import type { RemoteAdapterConfig } from '../index';

const EXPOSED_URL = 'https://example.test/api/files/blob/xyz';

/** What each exposed stream held. */
const mockExposedBytes: string[] = [];
jest.mock('../../../engine/files/expose', () => ({
  exposeFile: jest.fn(async ({ stream }: { stream: Readable }) => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    mockExposedBytes.push(Buffer.concat(chunks).toString('utf8'));
    return { url: EXPOSED_URL, expiresAt: new Date(0) };
  }),
}));
// eslint-disable-next-line import/first
import { exposeFile } from '../../../engine/files/expose';
import type { TeamId } from '../../../../../generated/kysely/core/Team';

/** The team the adapter's calls are made for (sent as `x-listen-fire-team`). */
const CONFIG_TEAM_ID = '00000000-0000-4000-8000-0000000000c1' as TeamId;

const SECRET = 'test-secret';

const DOC_TYPE = {
  typeId: 'Doc',
  displayName: 'Doc',
  fields: [{ fieldId: 'file', displayName: 'file', kind: 'file', writable: true, required: false }],
  references: [],
};

/** A write-target adapter that records every createRecord input it receives. */
function createRecordingTarget(received: unknown[]): Adapter {
  return {
    adapterType: 'doc_store',
    supportedTriggers: [],
    runtimeCapabilities: () => ({
      traversal: { incoming: false, edgeProperties: false },
      resources: false,
    }),
    async listEntryPoints() {
      return [{ typeId: 'Doc', displayName: 'Doc', writable: true, readable: false }];
    },
    async describe(typeId: string) {
      return typeId === 'Doc' ? DOC_TYPE : null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue() {
      return null;
    },
    async getRelated() {
      return [];
    },
    async createRecord(input: Record<string, unknown>) {
      received.push(input);
      return { adapterType: 'doc_store', externalId: 'doc-1', recordType: 'Doc', data: {} };
    },
    async updateRecord(input: { externalId: string }) {
      return { adapterType: 'doc_store', externalId: input.externalId, recordType: 'Doc', data: {} };
    },
    async deleteRecord() {
      return {};
    },
  } as unknown as Adapter;
}

describe('RemoteAdapter write with a FileRef exposes bytes to a URL (over real HTTP)', () => {
  let server: http.Server;
  let remote: RemoteAdapter;
  const received: unknown[] = [];

  beforeAll(async () => {
    const target = createRecordingTarget(received);
    const handler = createAdapterProtocolHandler({
      adapter: target,
      authenticate: (headers) => headers['authorization'] === `Bearer ${SECRET}`,
    });
    server = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const config: RemoteAdapterConfig = {
      teamId: CONFIG_TEAM_ID,
      adapterType: 'doc_store',
      baseUrl: `http://127.0.0.1:${port}/`,
      authStrategy: { kind: 'bearer' },
      credentialsId: 'test',
    };
    const manifest = await fetchRemoteManifest(config, SECRET);
    remote = createRemoteAdapter({ config, secret: SECRET, cacheScopeId: 'file-write', manifest });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('redeems the FileRef, buffers its bytes to a URL and sends that on the wire (no raw bytes)', async () => {
    const fileRef = installMemoryDocumentStore().file('PDF-BYTES', { name: 'deck.pdf', contentType: 'application/pdf' });
    const objectUri = fileRef.source !== undefined && 'store' in fileRef.source ? fileRef.source.objectUri : '';

    await remote.createRecord({
      recordType: 'Doc',
      fields: { file: fileRef },
      mutationContext: { source: {}, occurredAt: '2026-07-09T00:00:00Z' },
    } as unknown as Parameters<RemoteAdapter['createRecord']>[0]);

    expect(exposeFile).toHaveBeenCalledTimes(1);
    expect(mockExposedBytes).toEqual(['PDF-BYTES']);
    expect(received).toHaveLength(1);
    const sent = received[0] as { fields: { file: Record<string, unknown> } };
    const wireFile = sent.fields.file;
    // The exposed, fetchable URL rode the wire…
    expect(wireFile.url).toBe(EXPOSED_URL);
    // …metadata survived…
    expect(wireFile.name).toBe('deck.pdf');
    // …and the source travels in the wire's spelling: the owner type and its
    // handle, nothing of this side's.
    expect(wireFile.source).toEqual({ ownerAdapterType: 'document-store', handle: objectUri });
  });
});
