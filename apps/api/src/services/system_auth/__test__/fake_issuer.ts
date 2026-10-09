// A stand-in OpenID Connect issuer, for the oidc verifier's tests and the dev
// loop (`pnpm dev:fake-issuer`): an RSA key pair, its discovery document and
// JWKS served over http, and a `/mint` endpoint that signs a token for anyone
// who asks. That last part is why it exists only here.

import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';

import jwt from 'jsonwebtoken';

import type { AddressInfo } from 'node:net';

interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

interface MintClaims {
  sub?: string;
  aud?: string;
  email?: string;
  /** Overrides the issuer's own `iss`. */
  iss?: string;
  /** Seconds from now; negative mints an expired token. Default 300. */
  expiresIn?: number;
}

interface MintOptions {
  /** Names this key id instead of the current key's. */
  kid?: string;
  /** Signs with a key the issuer never published, under the current kid. */
  foreignKey?: boolean;
}

interface FakeIssuer {
  url: string;
  mint(claims: MintClaims, options?: MintOptions): string;
  /** A new current key; the JWKS serves only it from now on. */
  rotate(): void;
  /** How many times the JWKS has been fetched. */
  jwksFetches(): number;
  close(): Promise<void>;
}

function newKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid: randomUUID(), privateKey, publicKey };
}

async function startFakeIssuer(options: { port?: number; host?: string } = {}): Promise<FakeIssuer> {
  const host = options.host ?? '127.0.0.1';
  let current = newKey();
  const foreign = newKey();
  let fetches = 0;
  let url = '';

  function mint(claims: MintClaims, mintOptions: MintOptions = {}): string {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload = {
      iss: claims.iss ?? url,
      iat: nowSeconds,
      exp: nowSeconds + (claims.expiresIn ?? 300),
      ...(claims.sub !== undefined ? { sub: claims.sub } : {}),
      ...(claims.aud !== undefined ? { aud: claims.aud } : {}),
      ...(claims.email !== undefined ? { email: claims.email, email_verified: true } : {}),
    };
    const key = mintOptions.foreignKey === true ? foreign.privateKey : current.privateKey;
    return jwt.sign(payload, key, { algorithm: 'RS256', keyid: mintOptions.kid ?? current.kid });
  }

  const server: Server = createServer((req, res) => {
    const requested = new URL(req.url ?? '/', url);
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    switch (requested.pathname) {
      case '/.well-known/openid-configuration':
        json({ issuer: url, jwks_uri: `${url}/jwks` });
        return;
      case '/jwks':
        fetches += 1;
        json({ keys: [{ ...current.publicKey.export({ format: 'jwk' }), kid: current.kid, use: 'sig', alg: 'RS256' }] });
        return;
      case '/mint': {
        const param = (name: string) => requested.searchParams.get(name) ?? undefined;
        const expiresIn = param('expiresIn');
        const token = mint({
          sub: param('sub'),
          aud: param('aud'),
          email: param('email'),
          ...(expiresIn !== undefined ? { expiresIn: Number(expiresIn) } : {}),
        });
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(token);
        return;
      }
      default:
        res.writeHead(404).end();
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === 'string') throw new Error('the fake issuer has no port');
  url = `http://${host}:${address.port}`;

  return {
    url,
    mint,
    rotate: () => {
      current = newKey();
    },
    jwksFetches: () => fetches,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export { startFakeIssuer, type FakeIssuer, type MintClaims };
