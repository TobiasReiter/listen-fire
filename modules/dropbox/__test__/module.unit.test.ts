// The module as a host loads it: the client is made from the credential the
// host hands over, read per call; the dev loop's override wins over the
// credential's own base URL; and a Dropbox file is returned as a handle.

import { adapterInProcess, type ModuleHost } from 'module-kit';

import { dropboxModule } from '../index';

const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function host(over: Partial<ModuleHost> & { fields: () => Record<string, string>; fetch: typeof fetch }): ModuleHost {
  return {
    tenant: 'team-1',
    credential: { name: 'dropbox', fields: async () => over.fields(), update: async () => {} },
    fetch: over.fetch,
    log: quiet,
    files: { put: async () => ({ __brand: 'FileRef' }), read: async () => new Uint8Array() },
    kv: { get: async () => undefined, set: async () => {}, delete: async () => {}, list: async () => [] },
    ...(over.baseUrlOverride !== undefined ? { baseUrlOverride: over.baseUrlOverride } : {}),
    validateResults: true,
  };
}

function listing(seen: Array<{ url: string; authorization: string }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), authorization: String((init?.headers as Record<string, string>).Authorization) });
    return new Response(JSON.stringify({ entries: [{ '.tag': 'folder', name: 'Deals', path_display: '/Deals' }] }), { status: 200 });
  }) as typeof fetch;
}

const root = { position: { adapterType: 'dropbox', recordType: 'meta', identity: { kind: 'meta' } }, fieldId: 'Folders', direction: 'outgoing' } as never;

describe('@lf/dropbox as loaded by a host', () => {
  it('declares an OAuth credential and no inbound, poll or periodic task', () => {
    expect(dropboxModule.credentials).toEqual([
      expect.objectContaining({ name: 'dropbox', kind: 'oauth2', oauth2: expect.objectContaining({ tokenUrl: 'https://api.dropboxapi.com/oauth2/token' }) }),
    ]);
    for (const declaration of ['inbound', 'poll', 'periodic']) expect(declaration in dropboxModule).toBe(false);
  });

  it('reaches Dropbox with the credential read on each call, so a refreshed token is the next call’s', async () => {
    const seen: Array<{ url: string; authorization: string }> = [];
    let fields = { access_token: 'first' };
    const { adapter } = adapterInProcess(dropboxModule, host({ fields: () => fields, fetch: listing(seen) }));
    await adapter.getRelated(root);
    fields = { access_token: 'second' };
    await adapter.getRelated(root);
    expect(seen.map((s) => [s.url, s.authorization])).toEqual([
      ['https://api.dropboxapi.com/2/files/list_folder', 'Bearer first'],
      ['https://api.dropboxapi.com/2/files/list_folder', 'Bearer second'],
    ]);
  });

  it('the host’s base URL override wins over the credential’s own', async () => {
    const seen: Array<{ url: string; authorization: string }> = [];
    const fields = { access_token: 't', baseUrl: 'https://own.example' };
    const { adapter } = adapterInProcess(dropboxModule, host({ fields: () => fields, fetch: listing(seen), baseUrlOverride: 'http://fake.test/dropbox' }));
    await adapter.getRelated(root);
    expect(seen[0]?.url).toBe('http://fake.test/dropbox/2/files/list_folder');

    const own = adapterInProcess(dropboxModule, host({ fields: () => fields, fetch: listing(seen) }));
    await own.adapter.getRelated(root);
    expect(seen[1]?.url).toBe('https://own.example/2/files/list_folder');
  });

  it('refuses, naming Dropbox, a credential that holds no access token', async () => {
    const { adapter } = adapterInProcess(dropboxModule, host({ fields: () => ({}), fetch: listing([]) }));
    await expect(adapter.getRelated(root)).rejects.toThrow(/Dropbox: the connected credential holds no access token/);
  });
});
