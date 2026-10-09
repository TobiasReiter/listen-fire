// The oidc verifier against a real (fake) issuer: discovery and JWKS served
// over http, tokens signed in-test.

import jwt from 'jsonwebtoken';

import type { SystemCallerVerifier } from '../verifier';

import { createOidcVerifier } from '../oidc';
import { startFakeIssuer, type FakeIssuer } from './fake_issuer';


const AUDIENCE = 'https://api.example.com/api/v1/system/automations/drain';
const SUBJECT = 'scheduler@project.iam.gserviceaccount.com';

let issuer: FakeIssuer;
let verifier: SystemCallerVerifier;

beforeEach(async () => {
  issuer = await startFakeIssuer();
  verifier = createOidcVerifier({ issuer: issuer.url, audience: AUDIENCE, allowedSubjects: [SUBJECT] });
});

afterEach(async () => {
  await issuer.close();
});

function withBearer(token: string) {
  return verifier.verify({ method: 'POST', path: '/api/v1/system/automations/drain', headers: { authorization: `Bearer ${token}` } });
}

describe('the oidc verifier', () => {
  it('accepts a token the issuer signed for this audience and an allowed subject, as that subject', async () => {
    await expect(withBearer(issuer.mint({ sub: SUBJECT, aud: AUDIENCE }))).resolves.toEqual({
      ok: true,
      principal: { id: SUBJECT },
      actions: ['drain'],
    });
  });

  it('accepts an allowed verified email when the subject is an opaque id, as Google service account tokens carry', async () => {
    await expect(withBearer(issuer.mint({ sub: '1234567890', email: SUBJECT, aud: AUDIENCE }))).resolves.toEqual({
      ok: true,
      principal: { id: '1234567890', display: SUBJECT },
      actions: ['drain'],
    });
  });

  it.each([
    ['a wrong audience', () => issuer.mint({ sub: SUBJECT, aud: 'https://elsewhere.example.com' }), "the token's audience is not the configured audience"],
    ['an expired token', () => issuer.mint({ sub: SUBJECT, aud: AUDIENCE, expiresIn: -60 }), 'the token has expired'],
    ['an unknown subject', () => issuer.mint({ sub: 'stranger@example.com', aud: AUDIENCE }), "the token's subject is not on the allow-list"],
    ['a bad signature', () => issuer.mint({ sub: SUBJECT, aud: AUDIENCE }, { foreignKey: true }), "the token's signature does not verify"],
    ['a wrong issuer', () => issuer.mint({ sub: SUBJECT, aud: AUDIENCE, iss: 'https://accounts.example.com' }), "the token's issuer is not the configured issuer"],
  ])('refuses %s, by name', async (_case, token, reason) => {
    await expect(withBearer(token())).resolves.toEqual({ ok: false, reason });
  });

  it('refuses a request with no bearer, or a bearer that is not a JWT (an API key)', async () => {
    await expect(verifier.verify({ method: 'POST', path: '/', headers: {} })).resolves.toEqual({
      ok: false,
      reason: 'the request carries no bearer token',
    });
    await expect(withBearer('lf_0123456789abcdef')).resolves.toEqual({ ok: false, reason: 'the bearer is not a JWT' });
  });

  it('caches the keys, and refetches once when a token names a key it has not seen', async () => {
    await expect(withBearer(issuer.mint({ sub: SUBJECT, aud: AUDIENCE }))).resolves.toMatchObject({ ok: true });
    await expect(withBearer(issuer.mint({ sub: SUBJECT, aud: AUDIENCE }))).resolves.toMatchObject({ ok: true });
    expect(issuer.jwksFetches()).toBe(1);

    issuer.rotate();
    await expect(withBearer(issuer.mint({ sub: SUBJECT, aud: AUDIENCE }))).resolves.toMatchObject({ ok: true });
    expect(issuer.jwksFetches()).toBe(2);

    // Another unknown kid straight after does not cost the issuer a fetch.
    await expect(withBearer(issuer.mint({ sub: SUBJECT, aud: AUDIENCE }, { kid: 'invented' }))).resolves.toEqual({
      ok: false,
      reason: "the token's signing key is not one the issuer publishes",
    });
    expect(issuer.jwksFetches()).toBe(2);
  });

  it('refuses, naming the fetch, when the issuer cannot be reached', async () => {
    const unreachable = createOidcVerifier({ issuer: 'http://127.0.0.1:1', audience: AUDIENCE, allowedSubjects: [SUBJECT] });
    const verdict = await unreachable.verify({
      method: 'POST',
      path: '/',
      headers: { authorization: `Bearer ${issuer.mint({ sub: SUBJECT, aud: AUDIENCE })}` },
    });
    expect(verdict).toEqual({ ok: false, reason: "the issuer's keys could not be fetched" });
  });
});

function unsigned(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part(header)}.${part(payload)}.`;
}

function claims(extra: Record<string, unknown> = {}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return { iss: issuer.url, aud: AUDIENCE, sub: SUBJECT, iat: nowSeconds, exp: nowSeconds + 300, ...extra };
}

/** A fetch that counts its calls, through to the real one. */
function countingFetch() {
  const calls: string[] = [];
  const counted: typeof fetch = (input, init) => {
    calls.push(String(input));
    return fetch(input, init);
  };
  return { calls, fetch: counted };
}

describe('the oidc verifier, hardened', () => {
  it('refuses alg none and a symmetric algorithm in fixed words, whatever the header says', async () => {
    const kid = 'any';
    await expect(withBearer(unsigned({ alg: 'none', kid }, claims()))).resolves.toEqual({
      ok: false,
      reason: "the token's algorithm is not an asymmetric one",
    });
    await expect(withBearer(jwt.sign(claims(), 'a-shared-secret', { algorithm: 'HS256', keyid: kid }))).resolves.toEqual({
      ok: false,
      reason: "the token's algorithm is not an asymmetric one",
    });
    await expect(withBearer(unsigned({ alg: '<script>attacker text</script>', kid }, claims()))).resolves.toEqual({
      ok: false,
      reason: "the token's algorithm is not an asymmetric one",
    });
  });

  it('refuses a token with no expiry', async () => {
    await expect(withBearer(issuer.mint({ sub: SUBJECT, aud: AUDIENCE, expiresIn: null }))).resolves.toEqual({
      ok: false,
      reason: 'the token has no expiry',
    });
  });

  it('honours nbf and exp with a minute of clock tolerance', async () => {
    await expect(withBearer(issuer.mint({ sub: SUBJECT, aud: AUDIENCE, notBefore: 30 }))).resolves.toMatchObject({ ok: true });
    await expect(withBearer(issuer.mint({ sub: SUBJECT, aud: AUDIENCE, notBefore: 120 }))).resolves.toEqual({
      ok: false,
      reason: 'the token is not valid yet',
    });
    await expect(withBearer(issuer.mint({ sub: SUBJECT, aud: AUDIENCE, expiresIn: -30 }))).resolves.toMatchObject({ ok: true });
    await expect(withBearer(issuer.mint({ sub: SUBJECT, aud: AUDIENCE, expiresIn: -120 }))).resolves.toEqual({
      ok: false,
      reason: 'the token has expired',
    });
  });

  it('refuses an allow-listed email the issuer does not vouch for', async () => {
    await expect(
      withBearer(issuer.mint({ sub: '1234567890', email: SUBJECT, emailVerified: false, aud: AUDIENCE })),
    ).resolves.toEqual({ ok: false, reason: "the token's subject is not on the allow-list" });
  });

  it('keeps verifying with the keys it holds while the issuer is down, and backs off its refetches', async () => {
    const counted = countingFetch();
    verifier = createOidcVerifier({ issuer: issuer.url, audience: AUDIENCE, allowedSubjects: [SUBJECT], fetch: counted.fetch });
    await expect(withBearer(issuer.mint({ sub: SUBJECT, aud: AUDIENCE }))).resolves.toMatchObject({ ok: true });
    const afterLoad = counted.calls.length;

    issuer.setMode('down');
    // An unknown kid tries one refetch, which fails; the next unknown kid waits out the backoff.
    await expect(withBearer(issuer.mint({ sub: SUBJECT, aud: AUDIENCE }, { kid: 'new-1' }))).resolves.toMatchObject({ ok: false });
    expect(counted.calls.length).toBe(afterLoad + 1);
    await expect(withBearer(issuer.mint({ sub: SUBJECT, aud: AUDIENCE }))).resolves.toMatchObject({ ok: true });
    expect(counted.calls.length).toBe(afterLoad + 1);
  });

  it('refuses a key fetch failure without naming where it fetched from', async () => {
    issuer.setMode('down');
    const verdict = await withBearer(issuer.mint({ sub: SUBJECT, aud: AUDIENCE }));
    expect(verdict).toEqual({ ok: false, reason: "the issuer's keys could not be fetched" });
  });

  it('does not follow a redirect for the keys', async () => {
    issuer.setMode('redirect');
    await expect(withBearer(issuer.mint({ sub: SUBJECT, aud: AUDIENCE }))).resolves.toEqual({
      ok: false,
      reason: "the issuer's keys could not be fetched",
    });
  });

  it('refuses a plain http key URL when https is required', async () => {
    verifier = createOidcVerifier({ issuer: issuer.url, audience: AUDIENCE, allowedSubjects: [SUBJECT], requireHttps: true });
    await expect(withBearer(issuer.mint({ sub: SUBJECT, aud: AUDIENCE }))).resolves.toEqual({
      ok: false,
      reason: "the issuer's keys could not be fetched",
    });
  });

  it("accepts both spellings of Google's issuer when the issuer is Google's, and only those", async () => {
    const GOOGLE = 'https://accounts.google.com';
    const googleFetch: typeof fetch = (input, init) =>
      String(input) === `${GOOGLE}/.well-known/openid-configuration`
        ? Promise.resolve(new Response(JSON.stringify({ issuer: GOOGLE, jwks_uri: `${issuer.url}/jwks` })))
        : fetch(input, init);
    verifier = createOidcVerifier({ issuer: GOOGLE, audience: AUDIENCE, allowedSubjects: [SUBJECT], fetch: googleFetch });
    for (const iss of [GOOGLE, 'accounts.google.com']) {
      await expect(withBearer(issuer.mint({ sub: SUBJECT, aud: AUDIENCE, iss }))).resolves.toMatchObject({ ok: true });
    }
    await expect(withBearer(issuer.mint({ sub: SUBJECT, aud: AUDIENCE, iss: 'google.com' }))).resolves.toEqual({
      ok: false,
      reason: "the token's issuer is not the configured issuer",
    });
  });
});
