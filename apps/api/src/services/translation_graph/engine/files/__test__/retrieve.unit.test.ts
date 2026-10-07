// Host-side byte resolution (`streamFileRef`): a descriptor names the
// instance that owns its bytes, and that instance — resolved with the
// descriptor's credential and construction args — serves them.

import { Readable } from 'node:stream';

const stored: Record<string, string> = { 'mem://doc-1': 'rendered' };
jest.mock('../../../../../adapters/registry', () => ({
  services: {
    document: {
      getFileNodeStream: async ({ objectUri }: { objectUri: string }) =>
        Object.assign(Readable.from(Buffer.from(stored[objectUri] ?? '')), { contentType: 'application/pdf' }),
    },
  },
}));

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { Adapter, FileRef } from '../../../adapter';
import { streamFileRef, type ResolveFileOwner } from '../retrieve';

const TEAM_ID = '00000000-0000-0000-0000-0000000000f1' as TeamId;

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

/** An owner that serves `bytes` for any handle, recording who it was built as
 *  and what it was asked. */
function ownerResolver(bytes: Record<string, string>) {
  const resolved: Array<Parameters<ResolveFileOwner>[0]> = [];
  const asked: string[] = [];
  const resolveOwner: ResolveFileOwner = (input) => {
    resolved.push(input);
    const adapter: Partial<Adapter> = {
      adapterType: input.adapterType,
      async resolveFileRef({ ref }) {
        const handle = ref.source !== undefined && 'handle' in ref.source ? ref.source.handle : '';
        asked.push(handle);
        return { stream: Readable.from(Buffer.from(bytes[handle] ?? '')), contentType: 'text/plain' };
      },
    };
    return adapter as Adapter;
  };
  return { resolveOwner, resolved, asked };
}

describe('streamFileRef', () => {
  it('resolves the owning instance by the identity the descriptor names, then asks it for the handle', async () => {
    const owner = ownerResolver({ 'file-9': 'hello' });
    const ref: FileRef = {
      __brand: 'FileRef',
      name: 'a.txt',
      source: {
        adapterType: 'attio',
        credentialId: 'cred-attio-1',
        constructionArgs: { workspace: 'acme' },
        handle: 'file-9',
      },
    };
    const { stream, contentType } = await streamFileRef(ref, { teamId: TEAM_ID, resolveOwner: owner.resolveOwner });
    expect(await collect(stream)).toBe('hello');
    expect(contentType).toBe('text/plain');
    expect(owner.resolved).toEqual([
      { adapterType: 'attio', teamId: TEAM_ID, credentialsId: 'cred-attio-1', constructionArgs: { workspace: 'acme' } },
    ]);
    expect(owner.asked).toEqual(['file-9']);
  });

  it('reads a document-store file from the store, resolving no adapter', async () => {
    const owner = ownerResolver({});
    const ref: FileRef = { __brand: 'FileRef', source: { store: 'document', objectUri: 'mem://doc-1' } };
    const { stream, contentType } = await streamFileRef(ref, { teamId: TEAM_ID, resolveOwner: owner.resolveOwner });
    expect(await collect(stream)).toBe('rendered');
    expect(contentType).toBe('application/pdf');
    expect(owner.resolved).toEqual([]);
  });

  it('gives fresh bytes on every call', async () => {
    const owner = ownerResolver({ h: 'x' });
    const ref: FileRef = { __brand: 'FileRef', source: { adapterType: 'email', handle: 'h' } };
    const options = { teamId: TEAM_ID, resolveOwner: owner.resolveOwner };
    expect(await collect((await streamFileRef(ref, options)).stream)).toBe('x');
    expect(await collect((await streamFileRef(ref, options)).stream)).toBe('x');
  });

  it("reads a file parked in the earlier spelling through its owner type, credential-free as it parked", async () => {
    const owner = ownerResolver({ 'att-1': 'memo' });
    const parked = JSON.parse(
      '{"__brand":"FileRef","name":"memo.pdf","source":{"ownerAdapterType":"email","handle":"att-1"}}',
    ) as FileRef;
    const { stream } = await streamFileRef(parked, { teamId: TEAM_ID, resolveOwner: owner.resolveOwner });
    expect(await collect(stream)).toBe('memo');
    expect(owner.resolved).toEqual([{ adapterType: 'email', teamId: TEAM_ID }]);
  });

  it('fails naming the owner when it cannot serve bytes', async () => {
    const resolveOwner: ResolveFileOwner = () => ({ adapterType: 'cron' }) as Adapter;
    const ref: FileRef = { __brand: 'FileRef', source: { adapterType: 'cron', handle: 'h' } };
    await expect(streamFileRef(ref, { teamId: TEAM_ID, resolveOwner })).rejects.toThrow(/'cron'.*cannot serve/);
  });

  it('fails when the descriptor has no way back to its bytes', async () => {
    await expect(
      streamFileRef({ __brand: 'FileRef', name: 'memo.pdf' }, { teamId: TEAM_ID }),
    ).rejects.toThrow(/'memo\.pdf' carries no handle/);
  });
});
