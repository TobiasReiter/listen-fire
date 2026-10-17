// An embedder's module credential read from its secrets: an OAuth 2 one is
// refreshed by the declared token URL, before a call when it is about to
// expire and when the provider refuses its token, one refresh at a time.

import type { WireCredentialDeclarationShape } from 'engine-contracts';
import { createMemoryVault, createSecretsFamily } from 'movement-engine/public/secrets';

import { secretsCredential } from '../embed';

const DECLARATION: WireCredentialDeclarationShape = {
  name: 'crm',
  kind: 'oauth2',
  fields: [],
  oauth2: { authorizeUrl: 'https://crm.example/authorize', tokenUrl: 'https://crm.example/token', scopes: [], clientAuth: 'body' },
};

const SOON = () => new Date(Date.now() + 5_000).toISOString();
const LATER = () => new Date(Date.now() + 3_600_000).toISOString();

/** A token endpoint that hands out `token-1`, `token-2`, … and keeps each form it was sent. */
function tokenEndpoint(): { fetch: typeof fetch; forms: URLSearchParams[] } {
  const forms: URLSearchParams[] = [];
  const fetchStub = (async (_url: string | URL | Request, init?: RequestInit) => {
    forms.push(new URLSearchParams(String(init?.body)));
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ access_token: `token-${forms.length}`, expires_in: 3600, refresh_token: `refresh-${forms.length}` }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: fetchStub, forms };
}

function credentialOver(fields: Record<string, string>, endpoint: ReturnType<typeof tokenEndpoint>, declaration = DECLARATION) {
  const vault = createMemoryVault({ 'crm:acme': fields });
  const secrets = createSecretsFamily({ backend: vault });
  const credential = secretsCredential({
    name: 'crm',
    ref: 'crm:acme',
    secrets,
    oauth2: { declaration, client: { clientId: 'saas-app', clientSecret: 'saas-secret' }, fetch: endpoint.fetch },
  });
  return { credential, vault };
}

describe('secretsCredential', () => {
  it('refreshes a token about to expire before handing it over, once however many calls ask, and keeps the rotation', async () => {
    const endpoint = tokenEndpoint();
    const { credential, vault } = credentialOver({ access_token: 'old', refresh_token: 'refresh-0', expires_at: SOON() }, endpoint);
    const read = await Promise.all([credential.fields(), credential.fields(), credential.fields()]);
    expect(read.map((fields) => fields.access_token)).toEqual(['token-1', 'token-1', 'token-1']);
    expect(endpoint.forms).toHaveLength(1);
    expect(Object.fromEntries(endpoint.forms[0] ?? [])).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-0',
      client_id: 'saas-app',
      client_secret: 'saas-secret',
    });
    expect((await vault.resolve('crm:acme'))?.fields).toMatchObject({ access_token: 'token-1', refresh_token: 'refresh-1' });
  });

  it('hands over a token that is not about to expire as it stands', async () => {
    const endpoint = tokenEndpoint();
    const { credential } = credentialOver({ access_token: 'current', refresh_token: 'refresh-0', expires_at: LATER() }, endpoint);
    expect((await credential.fields()).access_token).toBe('current');
    expect(endpoint.forms).toHaveLength(0);
  });

  it('refreshes when the provider refuses a token before its expiry', async () => {
    const endpoint = tokenEndpoint();
    const { credential } = credentialOver({ access_token: 'revoked', refresh_token: 'refresh-0', expires_at: LATER() }, endpoint);
    expect(credential.refresh).toBeDefined();
    expect((await credential.refresh?.())?.access_token).toBe('token-1');
    expect((await credential.fields()).access_token).toBe('token-1');
  });

  it('refreshes nothing for a static credential, or without the declaration', async () => {
    const endpoint = tokenEndpoint();
    const { credential } = credentialOver({ api_key: 'k', expires_at: SOON() }, endpoint, { name: 'crm', kind: 'static', fields: [{ name: 'api_key' }] });
    expect(await credential.fields()).toEqual({ api_key: 'k', expires_at: expect.any(String) });
    expect(credential.refresh).toBeUndefined();
    const plain = secretsCredential({ name: 'crm', ref: 'crm:acme', secrets: createSecretsFamily({ backend: createMemoryVault({ 'crm:acme': { access_token: 'a', expires_at: SOON() } }) }) });
    expect((await plain.fields()).access_token).toBe('a');
    expect(plain.refresh).toBeUndefined();
    expect(endpoint.forms).toHaveLength(0);
  });
});
