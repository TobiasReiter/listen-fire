// The remote adapter's credential door (protocol `credentials`, request
// `credential`, response `credentialUpdate`, method `refreshCredential`),
// against a real module server on loopback and an in-memory vault as the
// secrets store: what the module is sent, what it may write back, and when
// the host refreshes.

import { createServer, type IncomingMessage, type Server } from 'node:http';

import { createMemoryVault, createSecretsFamily, type MemoryVault } from 'movement-engine/public/secrets';
import type { WireCredentialDeclarationShape } from 'engine-contracts';
import {
  CredentialChannelRefused,
  createRemoteAdapter,
  type RemoteManifest,
} from 'movement-engine/services/translation_graph/adapters/remote';
import { hostedDocumentStore } from '../../../engine/files/retrieve';

interface Received {
  method: string;
  credential?: { name: string; fields: Record<string, string> };
}

type Answer = (request: Received) => unknown;

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

/** A module server: records each request and answers with `answer`. */
async function moduleServer(answer: Answer): Promise<{ url: string; received: Received[]; close(): Promise<void> }> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    void readBody(req).then((body) => {
      const request: Received = JSON.parse(body);
      received.push(request);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer(request)));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('no address');
  return { url: `http://127.0.0.1:${address.port}/`, received, close: () => new Promise((ok) => server.close(() => ok())) };
}

/** A token endpoint on loopback, counting its calls. */
async function tokenServer(): Promise<{ url: string; forms: URLSearchParams[]; headers: Record<string, string | undefined>[]; close(): Promise<void> }> {
  const forms: URLSearchParams[] = [];
  const headers: Record<string, string | undefined>[] = [];
  const server = createServer((req, res) => {
    void readBody(req).then((body) => {
      forms.push(new URLSearchParams(body));
      headers.push({ authorization: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: `host-access-${forms.length}`, expires_in: 3600 }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('no address');
  return { url: `http://127.0.0.1:${address.port}/token`, forms, headers, close: () => new Promise((ok) => server.close(() => ok())) };
}

const oauth2 = (tokenUrl: string): WireCredentialDeclarationShape => ({
  name: 'crm',
  kind: 'oauth2',
  fields: [{ name: 'workspace', secret: false }],
  oauth2: { authorizeUrl: 'https://crm.example.test/authorize', tokenUrl },
});

function manifestOf(credentials: WireCredentialDeclarationShape[] | undefined, extraMethods: string[] = []): RemoteManifest {
  return {
    adapterType: 'crm',
    supportedTriggers: ['snapshot'],
    runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
    methods: ['manifest', 'listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated', 'createRecord', 'updateRecord', 'deleteRecord', ...extraMethods],
    ...(credentials !== undefined ? { credentials } : {}),
  };
}

const FRESH = () => new Date(Date.now() + 3_600_000).toISOString();
const STALE = '2000-01-01T00:00:00.000Z';

function adapterFor(input: { url: string; manifest: RemoteManifest; vault?: MemoryVault; bind?: boolean; client?: { clientId: string; clientSecret: string } }) {
  const secrets = createSecretsFamily({ backend: input.vault ?? createMemoryVault() });
  return createRemoteAdapter({
    config: { adapterType: 'crm', teamId: 'team-1', baseUrl: input.url, authStrategy: { kind: 'bearer' }, credentialsId: 'install-1' },
    secret: 'adapter-auth',
    cacheScopeId: 'scope-1',
    manifest: input.manifest,
    documents: hostedDocumentStore,
    ...(input.bind === false ? {} : { credential: { name: 'crm', secrets, ref: 'install-1', ...(input.client !== undefined ? { client: input.client } : {}) } }),
  });
}

const ok = (result: unknown, extra: object = {}) => ({ ok: true, result, ...extra });

describe('remote adapter: the declared credential', () => {
  it('is sent on every call with its declared and token fields only', async () => {
    const vault = createMemoryVault({
      'install-1': { access_token: 'a0', refresh_token: 'r0', expires_at: FRESH(), workspace: 'w1', client_secret: 'host-only', token_url: 'host-only-too' },
    });
    const server = await moduleServer(() => ok([]));
    try {
      await adapterFor({ url: server.url, manifest: manifestOf([oauth2('https://crm.example.test/token')]), vault }).listEntryPoints();
      expect(server.received[0]?.credential).toEqual({
        name: 'crm',
        fields: { access_token: 'a0', refresh_token: 'r0', expires_at: expect.any(String), workspace: 'w1' },
      });
    } finally {
      await server.close();
    }
  });

  it('is not sent to a module that declares none, and binding one it does not declare is refused', async () => {
    const server = await moduleServer(() => ok([]));
    try {
      await adapterFor({ url: server.url, manifest: manifestOf(undefined), bind: false }).listEntryPoints();
      expect(server.received[0]?.credential).toBeUndefined();
      expect(() => adapterFor({ url: server.url, manifest: manifestOf(undefined) })).toThrow(/declares no credential "crm"/);
    } finally {
      await server.close();
    }
  });

  it('is never sent over plain HTTP to a host that is not loopback', () => {
    expect(() => adapterFor({ url: 'http://crm.example.test/rpc', manifest: manifestOf([oauth2('https://crm.example.test/token')]) })).toThrow(CredentialChannelRefused);
  });

  it('a credentialUpdate is written back, from a successful call and from a failed one', async () => {
    const vault = createMemoryVault({ 'install-1': { access_token: 'a0', refresh_token: 'r0', expires_at: FRESH() } });
    let calls = 0;
    const server = await moduleServer(() => {
      calls += 1;
      return calls === 1
        ? ok([], { credentialUpdate: { name: 'crm', fields: { access_token: 'a1', refresh_token: 'r1' } } })
        : { ok: false, error: { code: 'not_found', message: 'gone', retryable: false }, credentialUpdate: { name: 'crm', fields: { refresh_token: 'r2' } } };
    });
    try {
      const adapter = adapterFor({ url: server.url, manifest: manifestOf([oauth2('https://crm.example.test/token')]), vault });
      await adapter.listEntryPoints();
      expect((await vault.resolve('install-1'))?.fields).toMatchObject({ access_token: 'a1', refresh_token: 'r1' });
      await expect(adapter.listEntryPoints()).rejects.toThrow(/not_found/);
      expect(server.received[1]?.credential?.fields.access_token).toBe('a1');
      expect((await vault.resolve('install-1'))?.fields).toMatchObject({ access_token: 'a1', refresh_token: 'r2' });
    } finally {
      await server.close();
    }
  });

  it('a credentialUpdate naming a field the module does not declare is refused, naming the field and not its value', async () => {
    const vault = createMemoryVault({ 'install-1': { access_token: 'a0', refresh_token: 'r0', expires_at: FRESH() } });
    const server = await moduleServer(() => ok([], { credentialUpdate: { name: 'crm', fields: { client_secret: 'stolen-value' } } }));
    try {
      const failure = adapterFor({ url: server.url, manifest: manifestOf([oauth2('https://crm.example.test/token')]), vault }).listEntryPoints();
      await expect(failure).rejects.toThrow(/does not declare: client_secret/);
      await expect(failure).rejects.not.toThrow(/stolen-value/);
      expect((await vault.resolve('install-1'))?.fields.client_secret).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('an expiring oauth2 credential is refreshed by the host from the declaration before the call', async () => {
    const vault = createMemoryVault({ 'install-1': { access_token: 'a0', refresh_token: 'r0', expires_at: STALE } });
    const tokens = await tokenServer();
    const server = await moduleServer(() => ok([]));
    try {
      await adapterFor({ url: server.url, manifest: manifestOf([oauth2(tokens.url)]), vault, client: { clientId: 'cid', clientSecret: 'csecret' } }).listEntryPoints();
      expect(tokens.forms).toHaveLength(1);
      expect(tokens.forms[0]?.get('refresh_token')).toBe('r0');
      // The declaration's default client auth: HTTP Basic.
      expect(tokens.headers[0]?.authorization).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
      expect(server.received[0]?.credential?.fields.access_token).toBe('host-access-1');
      expect((await vault.resolve('install-1'))?.fields).toMatchObject({ access_token: 'host-access-1', refresh_token: 'r0' });
    } finally {
      await server.close();
      await tokens.close();
    }
  });

  it('a call answered unauthorized is refreshed once and retried', async () => {
    const vault = createMemoryVault({ 'install-1': { access_token: 'a0', refresh_token: 'r0' } });
    const tokens = await tokenServer();
    const server = await moduleServer((request) =>
      request.credential?.fields.access_token === 'a0' ? { ok: false, error: { code: 'unauthorized', message: 'expired', retryable: false } } : ok([]),
    );
    try {
      await adapterFor({ url: server.url, manifest: manifestOf([oauth2(tokens.url)]), vault }).listEntryPoints();
      expect(tokens.forms).toHaveLength(1);
      expect(server.received.map((r) => r.credential?.fields.access_token)).toEqual(['a0', 'host-access-1']);
    } finally {
      await server.close();
      await tokens.close();
    }
  });

  it('a module that lists refreshCredential is asked to refresh instead of the token endpoint', async () => {
    const vault = createMemoryVault({ 'install-1': { access_token: 'a0', refresh_token: 'r0', expires_at: STALE } });
    const tokens = await tokenServer();
    const server = await moduleServer((request) =>
      request.method === 'refreshCredential'
        ? ok({ fields: { access_token: 'module-access', expires_at: FRESH() } }, { credentialUpdate: { name: 'crm', fields: { refresh_token: 'module-refresh' } } })
        : ok([]),
    );
    try {
      await adapterFor({ url: server.url, manifest: manifestOf([oauth2(tokens.url)], ['refreshCredential']), vault }).listEntryPoints();
      expect(tokens.forms).toHaveLength(0);
      expect(server.received.map((r) => r.method)).toEqual(['refreshCredential', 'listEntryPoints']);
      expect(server.received[0]?.credential?.fields.refresh_token).toBe('r0');
      expect(server.received[1]?.credential?.fields.access_token).toBe('module-access');
      expect((await vault.resolve('install-1'))?.fields).toMatchObject({ access_token: 'module-access', refresh_token: 'module-refresh' });
    } finally {
      await server.close();
      await tokens.close();
    }
  });

  it('a static credential is sent and never refreshed', async () => {
    const vault = createMemoryVault({ 'install-1': { api_key: 'k1', expires_at: STALE } });
    const server = await moduleServer(() => ({ ok: false, error: { code: 'unauthorized', message: 'no', retryable: false } }));
    try {
      const declaration: WireCredentialDeclarationShape = { name: 'crm', kind: 'static', fields: [{ name: 'api_key' }] };
      await expect(adapterFor({ url: server.url, manifest: manifestOf([declaration]), vault }).listEntryPoints()).rejects.toThrow(/unauthorized/);
      expect(server.received).toHaveLength(1);
      expect(server.received[0]?.credential).toEqual({ name: 'crm', fields: { api_key: 'k1' } });
    } finally {
      await server.close();
    }
  });
});
