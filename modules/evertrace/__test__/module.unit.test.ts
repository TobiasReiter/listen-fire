// The module's seams with its host: how the context's credential becomes a
// client, and what the module declares.

import type { CredentialFields, ModuleContext } from 'module-kit';

import { EVERTRACE_API_VERSION } from '../api_client';
import { evertraceClientFrom, evertraceModule, EVERTRACE_POLL_INTERVAL_SECONDS } from '../index';

interface Seen {
  url: string;
  headers: Record<string, string>;
}

function contextOver(fields: () => CredentialFields, config: { baseUrlOverride?: string } = {}): { ctx: ModuleContext; seen: Seen[] } {
  const refuse = (): never => {
    throw new Error('not used');
  };
  const seen: Seen[] = [];
  const ctx: ModuleContext = {
    credential: { name: 'evertrace', fields: async () => fields(), update: async () => refuse() },
    credentialNamed: refuse,
    spend: { charge: () => undefined },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch,
    log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    files: { put: refuse, read: refuse, expose: refuse },
    kv: { get: refuse, set: refuse, delete: refuse, list: refuse },
    models: { chat: refuse, chatStructured: refuse },
    identities: { list: refuse, find: refuse },
    config: { tenant: 'team-1', constructionArgs: {}, ...config },
  };
  return { ctx, seen };
}

describe('evertraceClientFrom', () => {
  it('says to connect Evertrace when the credential holds no API key', async () => {
    const source = evertraceClientFrom(contextOver(() => ({})).ctx);
    await expect(source()).rejects.toThrow(/Connect Evertrace/);
  });

  it('reaches Evertrace through the host fetch, with the key and the pinned version', async () => {
    const { ctx, seen } = contextOver(() => ({ apiKey: 'k', baseUrl: 'https://evertrace.example' }));
    await (await evertraceClientFrom(ctx)()).listSearches();
    expect(seen).toEqual([
      {
        url: 'https://evertrace.example/searches',
        headers: { Authorization: 'Bearer k', 'X-API-Version': EVERTRACE_API_VERSION, Accept: 'application/json' },
      },
    ]);
  });

  it('prefers the host base URL override (the dev loop fake) over the credential', async () => {
    const { ctx, seen } = contextOver(() => ({ apiKey: 'k', baseUrl: 'https://evertrace.example' }), { baseUrlOverride: 'http://127.0.0.1:1/evertrace' });
    await (await evertraceClientFrom(ctx)()).listLists();
    expect(seen.map((s) => s.url)).toEqual(['http://127.0.0.1:1/evertrace/lists']);
  });

  it('reads the credential per call, so an edit between calls is seen by the next', async () => {
    let fields: CredentialFields = { apiKey: 'one', baseUrl: 'https://one.example' };
    const { ctx, seen } = contextOver(() => fields);
    const source = evertraceClientFrom(ctx);
    const first = await source();
    expect(await source()).toBe(first);
    fields = { apiKey: 'two', baseUrl: 'https://two.example' };
    await (await source()).listLists();
    expect(seen.map((s) => s.url)).toEqual(['https://two.example/lists']);
  });
});

describe('evertraceModule', () => {
  it('declares an API key credential and a five-minute poll', () => {
    expect(evertraceModule.credentials[0]?.fields.map((f) => f.name)).toEqual(['apiKey', 'baseUrl']);
    expect(evertraceModule.poll).toEqual({ intervalSeconds: EVERTRACE_POLL_INTERVAL_SECONDS });
    expect(EVERTRACE_POLL_INTERVAL_SECONDS).toBe(300);
  });

  it('is a polled source with no inbound, and a write surface', () => {
    expect(evertraceModule.manifest.supportedTriggers).toEqual(['poll']);
    expect('inbound' in evertraceModule).toBe(false);
    expect(evertraceModule.manifest.methods).toEqual(expect.arrayContaining(['createRecord', 'updateRecord', 'deleteRecord']));
  });
});
