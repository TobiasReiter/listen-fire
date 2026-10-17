// The module's side of its credential: the declarations it answers with, and
// how the fields a host hands it become a client.

import { loadedModule, moduleManifest, refusingFiles, refusingIdentities, refusingKv, refusingModels } from 'module-kit';

import { GMAIL_SCOPES, GMAIL_SEND_SCOPE } from '../api_client';
import { gmailClientFromFields } from '../credential';
import { gmailModule } from '../index';
import { silentLog } from './host';

describe('the declarations', () => {
  it('declares its credential and its poll, and pairs the poll with a method', () => {
    const credential = { name: 'gmail', fields: async () => ({}), update: async () => undefined };
    const manifest = moduleManifest(
      loadedModule(gmailModule, {
        credential,
        fetch,
        log: silentLog,
        files: refusingFiles('none'),
        kv: refusingKv('none'),
        models: refusingModels('none'),
        identities: refusingIdentities('none'),
        config: { tenant: 't', constructionArgs: {} },
      }),
    );
    expect(manifest.adapterType).toBe('gmail');
    expect(manifest.poll).toEqual({ intervalSeconds: 60 });
    expect(manifest.methods).toContain('poll');
    expect(manifest.inbound).toBeUndefined();
    expect(manifest.credentials?.[0]).toMatchObject({ name: 'gmail', kind: 'oauth2', oauth2: { scopes: [...GMAIL_SCOPES], clientAuth: 'body', pkce: true } });
  });
});

describe('fields to a client', () => {
  const base = { mailbox: 'deals@example.com', access_token: 'tok' };

  it('reads a sign-in with no granted scopes as holding the ones it asks for', () => {
    expect(gmailClientFromFields(base, { fetch }).canSend()).toBe(true);
    expect(gmailClientFromFields({ ...base, granted_scopes: 'https://www.googleapis.com/auth/gmail.readonly' }, { fetch }).canSend()).toBe(false);
    expect(gmailClientFromFields({ ...base, granted_scopes: GMAIL_SCOPES.join(' ') }, { fetch }).credentials.grantedScopes).toContain(GMAIL_SEND_SCOPE);
  });

  it('refuses fields that name no mailbox or hold no token, and a method it does not know', () => {
    expect(() => gmailClientFromFields({ access_token: 'tok' }, { fetch })).toThrow(/Connect Gmail/);
    expect(() => gmailClientFromFields({ mailbox: 'deals@example.com' }, { fetch })).toThrow(/Connect Gmail/);
    expect(() => gmailClientFromFields({ ...base, method: 'delegation' }, { fetch })).toThrow(/'delegation'/);
  });

  it('refuses a delegated send the host holds no token for, naming why, with the delegated remedy', async () => {
    const client = gmailClientFromFields({ ...base, method: 'delegated', send_refusal: 'unauthorized_client' }, { fetch });
    await expect(client.sendMessage({ raw: 'cmF3' })).rejects.toMatchObject({ failure: 'missing_send_scope', message: expect.stringMatching(/unauthorized_client/) });
  });
});
