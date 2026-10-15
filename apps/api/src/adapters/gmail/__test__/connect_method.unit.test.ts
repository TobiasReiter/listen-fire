// How this deployment connects Gmail, and which scopes that consent asks for.
// Two decisions, both read from the environment, both of which change what a
// user is shown and what the mailbox may afterwards do.

import { GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE } from 'movement-engine/lib/google_cloud';
import {
  GMAIL_CONNECT_METHODS,
  gmailConnectMethod,
  gmailOAuthClientCredentials,
  gmailOAuthScopes,
  gmailSendEnabled,
} from '../connect_method';

describe('gmailConnectMethod', () => {
  it('defaults to signing in as the mailbox', () => {
    expect(gmailConnectMethod({})).toBe('oauth');
    expect(gmailConnectMethod({ GMAIL_CONNECT_METHOD: '' })).toBe('oauth');
    expect(gmailConnectMethod({ GMAIL_CONNECT_METHOD: '  ' })).toBe('oauth');
  });

  it('reads each method it offers', () => {
    for (const method of GMAIL_CONNECT_METHODS) {
      expect(gmailConnectMethod({ GMAIL_CONNECT_METHOD: method })).toBe(method);
    }
  });

  it('throws on anything else, naming the variable and every value it accepts', () => {
    expect(() => gmailConnectMethod({ GMAIL_CONNECT_METHOD: 'delegation' })).toThrow(
      /GMAIL_CONNECT_METHOD/,
    );
    expect(() => gmailConnectMethod({ GMAIL_CONNECT_METHOD: 'delegation' })).toThrow(/oauth/);
    expect(() => gmailConnectMethod({ GMAIL_CONNECT_METHOD: 'delegation' })).toThrow(/delegated/);
  });
});

describe('gmailSendEnabled', () => {
  it('is off unless the installation says exactly true', () => {
    expect(gmailSendEnabled({})).toBe(false);
    expect(gmailSendEnabled({ GMAIL_SEND_ENABLED: 'false' })).toBe(false);
    expect(gmailSendEnabled({ GMAIL_SEND_ENABLED: '1' })).toBe(false);
    expect(gmailSendEnabled({ GMAIL_SEND_ENABLED: 'True' })).toBe(true);
    expect(gmailSendEnabled({ GMAIL_SEND_ENABLED: 'true' })).toBe(true);
  });
});

describe('gmailOAuthClientCredentials', () => {
  const SHARED = {
    GOOGLE_INTEGRATIONS_CLIENT_ID: 'shared-id',
    GOOGLE_INTEGRATIONS_CLIENT_SECRET: 'shared-secret',
  };

  it('prefers a client registered for the connector', () => {
    expect(
      gmailOAuthClientCredentials({
        ...SHARED,
        GMAIL_OAUTH_CLIENT_ID: 'gmail-id',
        GMAIL_OAUTH_CLIENT_SECRET: 'gmail-secret',
      }),
    ).toEqual({ clientId: 'gmail-id', clientSecret: 'gmail-secret' });
  });

  it('falls back to the client Sheets and Drive already use', () => {
    expect(gmailOAuthClientCredentials(SHARED)).toEqual({
      clientId: 'shared-id',
      clientSecret: 'shared-secret',
    });
  });

  it('throws on half a pair, naming both variables', () => {
    for (const half of [
      { GMAIL_OAUTH_CLIENT_ID: 'gmail-id' },
      { GMAIL_OAUTH_CLIENT_SECRET: 'gmail-secret' },
    ]) {
      expect(() => gmailOAuthClientCredentials({ ...SHARED, ...half })).toThrow(
        /GMAIL_OAUTH_CLIENT_ID/,
      );
      expect(() => gmailOAuthClientCredentials({ ...SHARED, ...half })).toThrow(
        /GMAIL_OAUTH_CLIENT_SECRET/,
      );
    }
  });

  it('reports no client rather than half of one', () => {
    expect(gmailOAuthClientCredentials({})).toBeNull();
    expect(gmailOAuthClientCredentials({ GOOGLE_INTEGRATIONS_CLIENT_ID: 'only-id' })).toBeNull();
  });
});

describe('gmailOAuthScopes', () => {
  it('asks only to read when sending is not enabled', () => {
    expect(gmailOAuthScopes({})).toEqual([GMAIL_READONLY_SCOPE]);
  });

  it('adds the send scope only when the installation enabled sending', () => {
    expect(gmailOAuthScopes({ GMAIL_SEND_ENABLED: 'true' })).toEqual([
      GMAIL_READONLY_SCOPE,
      GMAIL_SEND_SCOPE,
    ]);
  });
});
