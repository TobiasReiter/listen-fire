// The oidc verifier against a real (fake) issuer: discovery and JWKS served
// over http, tokens signed in-test.

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
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringMatching(/^the issuer's keys could not be fetched/) });
  });
});
