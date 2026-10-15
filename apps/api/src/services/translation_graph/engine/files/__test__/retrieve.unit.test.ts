// Host-side byte resolution (`streamFileRef`): a descriptor names the
// instance that owns its bytes, and that instance — resolved with the
// descriptor's credential and construction args — serves them, but only an
// instance the run holds. Every read is the run's team's: a stored document
// the team does not own, or an owner the run holds no instance of, is refused
// by name.

import { Readable } from 'node:stream';

const stored: Record<string, string> = {
  'mem://doc-1': 'rendered',
  's3://bucket/movement-files/00000000-0000-0000-0000-0000000000f1/a/artifact.txt': 'ours',
  's3://bucket/movement-files/00000000-0000-0000-0000-0000000000f2/a/artifact.txt': 'theirs',
  's3://bucket/uuid-9/plugin.pdf': 'a plugin stored it',
};
/** The team-scoped document rows the database holds, each with its team. */
const rows: { document: Array<{ id: string; object_uri: string; team_id: string }> } = {
  document: [{ id: 'd-1', object_uri: 's3://bucket/uuid-9/plugin.pdf', team_id: '00000000-0000-0000-0000-0000000000f1' }],
};
/** A query builder over `rows`: `selectFrom(t).select(…).where(col, '=', v)….executeTakeFirst()`. */
function fakeQb() {
  return {
    selectFrom(table: keyof typeof rows) {
      const where: Array<[string, unknown]> = [];
      const query = {
        select: () => query,
        where: (column: string, _op: string, value: unknown) => {
          where.push([column.replace(/^.*\./, ''), value]);
          return query;
        },
        executeTakeFirst: async () =>
          (rows[table] as Array<Record<string, unknown>>).find((row) => where.every(([column, value]) => row[column] === value)),
      };
      return query;
    },
  };
}
jest.mock('../../../../../lib/kysely', () => ({ getKnowledgeQb: () => fakeQb() }));
jest.mock('../../../../../adapters/registry', () => ({
  services: {
    document: {
      // The store's own reading of a URI, as the S3 store reads one (bucket
      // `bucket`), and its in-memory `mem://` stand-in.
      keyOf: (objectUri: string) => {
        const { storeKey } = jest.requireActual('../../../../../adapters/document/interface');
        for (const prefix of ['s3://bucket/', 'mem://']) {
          if (objectUri.startsWith(prefix)) return storeKey(objectUri.slice(prefix.length));
        }
        return undefined;
      },
      getFileNodeStream: async ({ objectUri }: { objectUri: string }) =>
        Object.assign(Readable.from(Buffer.from(stored[objectUri] ?? '')), { contentType: 'application/pdf' }),
    },
  },
}));
import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { Adapter, FileRef } from 'movement-engine/services/translation_graph/adapter';

import { FileOutsideTeamError, streamFileRef, withFileOwners, type ResolveFileOwner } from '../retrieve';

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
    const { stream, contentType } = await streamFileRef(ref, {
      teamId: TEAM_ID,
      resolveOwner: owner.resolveOwner,
      documentOwnership: async () => true,
    });
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

describe("a byte read is the run's team's", () => {
  const document = (objectUri: string): FileRef => ({ __brand: 'FileRef', name: 'f', source: { store: 'document', objectUri } });

  it("reads a document under the team's own key prefix (a movement's artifact) without a row", async () => {
    const { stream } = await streamFileRef(
      document('s3://bucket/movement-files/00000000-0000-0000-0000-0000000000f1/a/artifact.txt'),
      { teamId: TEAM_ID },
    );
    expect(await collect(stream)).toBe('ours');
  });

  it("reads a document the team-scoped document table records as the team's", async () => {
    const { stream } = await streamFileRef(document('s3://bucket/uuid-9/plugin.pdf'), { teamId: TEAM_ID });
    expect(await collect(stream)).toBe('a plugin stored it');
  });

  it("refuses, by name, a document under another team's prefix", async () => {
    const read = streamFileRef(
      document('s3://bucket/movement-files/00000000-0000-0000-0000-0000000000f2/a/artifact.txt'),
      { teamId: TEAM_ID },
    );
    await expect(read).rejects.toBeInstanceOf(FileOutsideTeamError);
    await expect(read).rejects.toThrow(/stored document .* is not this team's/);
  });

  it('refuses a document no row of the team records, and one another team uploaded', async () => {
    await expect(streamFileRef(document('s3://bucket/uuid-1/forged.pdf'), { teamId: TEAM_ID })).rejects.toMatchObject({
      code: 'FILE_OUTSIDE_TEAM',
      owner: 'document',
    });
    await expect(
      streamFileRef(document('s3://bucket/uuid-9/plugin.pdf'), { teamId: '00000000-0000-0000-0000-0000000000f2' as TeamId }),
    ).rejects.toBeInstanceOf(FileOutsideTeamError);
  });

  it('refuses an earlier-spelled document-store file the team does not own', async () => {
    const parked: FileRef = { __brand: 'FileRef', source: { ownerAdapterType: 'document-store', handle: 's3://bucket/uuid-1/forged.pdf' } };
    await expect(streamFileRef(parked, { teamId: TEAM_ID })).rejects.toBeInstanceOf(FileOutsideTeamError);
  });

  it('reads through the instance the run holds for the type, never one the descriptor would build', async () => {
    const held = ownerResolver({ h: 'from our instance' });
    const ours = (await held.resolveOwner({ adapterType: 'attio', teamId: TEAM_ID })) as Adapter;
    const asked: unknown[] = [];
    const ref: FileRef = { __brand: 'FileRef', source: { adapterType: 'attio', credentialId: 'cred-ours', handle: 'h' } };
    const { stream } = await withFileOwners(
      (owner) => {
        asked.push(owner);
        return owner.adapterType === 'attio' && owner.credentialsId === 'cred-ours' ? ours : undefined;
      },
      () => streamFileRef(ref, { teamId: TEAM_ID }),
    );
    expect(await collect(stream)).toBe('from our instance');
    expect(asked).toEqual([{ adapterType: 'attio', credentialsId: 'cred-ours' }]);
  });

  it.each([
    ['a credential the run holds no instance with', { adapterType: 'attio', credentialId: 'cred-theirs', handle: 'h' }],
    ['an adapter type the run holds no instance of', { adapterType: 'whatsapp', handle: 'http://169.254.169.254/latest/meta-data' }],
    ['the earlier spelling, for a type the run does not hold', { ownerAdapterType: 'email', handle: 'https://evil.example/x' }],
  ])('refuses, by name, %s — never fetched', async (_what, source) => {
    const ref = { __brand: 'FileRef' as const, source };
    const read = withFileOwners(
      (owner) => (owner.adapterType === 'attio' && owner.credentialsId === 'cred-ours' ? ({} as Adapter) : undefined),
      () => streamFileRef(ref, { teamId: TEAM_ID }),
    );
    await expect(read).rejects.toMatchObject({ code: 'FILE_OUTSIDE_TEAM', owner: 'instance' });
  });

  it('refuses an adapter-owned file outside any run: no instance is held there', async () => {
    const ref: FileRef = { __brand: 'FileRef', source: { adapterType: 'manual', handle: 's3://bucket/uuid-9/plugin.pdf' } };
    await expect(streamFileRef(ref, { teamId: TEAM_ID })).rejects.toBeInstanceOf(FileOutsideTeamError);
  });

  it.each([
    ['another bucket', 's3://other-bucket/movement-files/00000000-0000-0000-0000-0000000000f1/a/artifact.txt'],
    ['a `..` segment out of the team prefix', 's3://bucket/movement-files/00000000-0000-0000-0000-0000000000f1/../00000000-0000-0000-0000-0000000000f2/a/artifact.txt'],
    ['a `.` segment', 's3://bucket/movement-files/00000000-0000-0000-0000-0000000000f1/./a/artifact.txt'],
    ['an empty segment', 's3://bucket/movement-files//00000000-0000-0000-0000-0000000000f1/a/artifact.txt'],
    ['the team prefix in the host', 's3://movement-files/00000000-0000-0000-0000-0000000000f1/a/artifact.txt'],
  ])('refuses a document URI the store would not read as given: %s', async (_what, objectUri) => {
    await expect(streamFileRef(document(objectUri), { teamId: TEAM_ID })).rejects.toMatchObject({
      code: 'FILE_OUTSIDE_TEAM',
      owner: 'document',
    });
  });
});
