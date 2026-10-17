// The module's seams with its host: how the context's credential becomes a
// client, and what the module declares.

import type { CredentialFields, ModuleContext } from 'module-kit';

import { granolaClientFrom, granolaModule, GRANOLA_POLL_INTERVAL_SECONDS } from '../index';

function contextOver(fields: () => CredentialFields, config: { baseUrlOverride?: string } = {}): ModuleContext {
  const refuse = (): never => {
    throw new Error('not used');
  };
  const requests: string[] = [];
  const ctx: ModuleContext = {
    credential: { name: 'granola', fields: async () => fields(), update: async () => refuse() },
    fetch: (async (url: string | URL | Request) => {
      requests.push(String(url));
      return new Response(JSON.stringify({ notes: [], hasMore: false, cursor: null }), { status: 200 });
    }) as typeof fetch,
    log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    files: { put: refuse, read: refuse, expose: refuse },
    kv: { get: refuse, set: refuse, delete: refuse, list: refuse },
    models: { chat: refuse, chatStructured: refuse },
    identities: { list: refuse, find: refuse },
    config: { tenant: 'team-1', constructionArgs: {}, ...config },
  };
  return Object.assign(ctx, { requests });
}

describe('granolaClientFrom', () => {
  it('says to connect Granola when the credential holds no API key', async () => {
    const source = granolaClientFrom(contextOver(() => ({})));
    await expect(source()).rejects.toThrow(/Connect Granola/);
  });

  it('reaches Granola through the host fetch, at the credential base URL', async () => {
    const ctx = contextOver(() => ({ apiKey: 'k', baseUrl: 'https://granola.example' }));
    await (await granolaClientFrom(ctx)()).listNotes({});
    expect((ctx as unknown as { requests: string[] }).requests).toEqual(['https://granola.example/v1/notes']);
  });

  it('prefers the host base URL override (the dev loop fake) over the credential', async () => {
    const ctx = contextOver(() => ({ apiKey: 'k', baseUrl: 'https://granola.example' }), { baseUrlOverride: 'http://127.0.0.1:1/granola' });
    await (await granolaClientFrom(ctx)()).listNotes({});
    expect((ctx as unknown as { requests: string[] }).requests).toEqual(['http://127.0.0.1:1/granola/v1/notes']);
  });

  it('reads the credential per call, so an edit between calls is seen by the next', async () => {
    let fields: CredentialFields = { apiKey: 'one', baseUrl: 'https://one.example' };
    const ctx = contextOver(() => fields);
    const source = granolaClientFrom(ctx);
    const first = await source();
    expect(await source()).toBe(first);
    fields = { apiKey: 'two', baseUrl: 'https://two.example' };
    await (await source()).listNotes({});
    expect((ctx as unknown as { requests: string[] }).requests).toEqual(['https://two.example/v1/notes']);
  });
});

describe('granolaModule', () => {
  it('declares an API key credential and a five-minute poll', () => {
    expect(granolaModule.credentials[0]?.fields.map((f) => f.name)).toEqual(['apiKey', 'baseUrl']);
    expect(granolaModule.poll).toEqual({ intervalSeconds: GRANOLA_POLL_INTERVAL_SECONDS });
    expect(GRANOLA_POLL_INTERVAL_SECONDS).toBe(300);
  });

  it('is a polled source with no inbound', () => {
    expect(granolaModule.manifest.supportedTriggers).toEqual(['poll']);
    expect('inbound' in granolaModule).toBe(false);
  });
});
