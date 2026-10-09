// The reference second verifier: an OpenID Connect identity token, as a Google
// Pub/Sub push subscription or a Cloud Scheduler job sends one, signed by the
// issuer's published keys.
//
// A token is accepted when its signature verifies against the issuer's JWKS,
// it has not expired, its `iss` is the configured issuer, its `aud` the
// configured audience (the drain URL, for Google), and its subject (`sub`, or a
// verified `email`) is on the allow-list. Each refusal names the check that
// failed, never the token or the configured values.

import { createPublicKey, type KeyObject } from 'node:crypto';

import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { SYSTEM_ACTIONS, type SystemCallerVerdict, type SystemCallerVerifier } from './verifier';

interface OidcVerifierOptions {
  issuer: string;
  audience: string;
  allowedSubjects: readonly string[];
  /** Injection point for tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  now?: () => number;
}

// Asymmetric only: a symmetric algorithm would let a published key sign, and
// `none` signs nothing.
const ALGORITHMS: readonly jwt.Algorithm[] = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];

// An unknown `kid` refetches the keys, but at most this often: otherwise every
// request carrying an invented `kid` would cost the issuer a fetch.
const KID_MISS_REFETCH_EVERY_MS = 30_000;
// Keys an issuer has withdrawn stop verifying within this long.
const KEYS_MAX_AGE_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

const discoverySchema = z.object({ issuer: z.string(), jwks_uri: z.string().url() });
const jwksSchema = z.object({
  keys: z.array(z.object({ kid: z.string().optional(), use: z.string().optional() }).passthrough()),
});
const claimsSchema = z.object({
  iss: z.string().optional(),
  aud: z.union([z.string(), z.array(z.string())]).optional(),
  exp: z.number().optional(),
  sub: z.string().optional(),
  email: z.string().optional(),
  email_verified: z.union([z.boolean(), z.string()]).optional(),
});

function bearerToken(headers: Readonly<Record<string, string | readonly string[] | undefined>>): string | undefined {
  const header = headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

function isAlgorithm(alg: string): alg is jwt.Algorithm {
  return ALGORITHMS.some((allowed) => allowed === alg);
}

/** The issuer's signing keys by `kid`, fetched through its discovery document. */
class IssuerKeys {
  private keys = new Map<string, KeyObject>();
  private fetchedAt: number | undefined;
  private lastMissRefetchAt: number | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly options: { issuer: string; fetch: typeof fetch; now: () => number },
  ) {}

  async forKid(kid: string): Promise<KeyObject | undefined> {
    const now = this.options.now();
    if (this.fetchedAt === undefined || now - this.fetchedAt >= KEYS_MAX_AGE_MS) await this.refetch();
    const known = this.keys.get(kid);
    if (known !== undefined) return known;
    if (this.lastMissRefetchAt !== undefined && now - this.lastMissRefetchAt < KID_MISS_REFETCH_EVERY_MS) {
      return undefined;
    }
    this.lastMissRefetchAt = now;
    await this.refetch();
    return this.keys.get(kid);
  }

  private refetch(): Promise<void> {
    this.inFlight ??= this.load().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async load(): Promise<void> {
    const discovery = discoverySchema.parse(
      await this.getJson(`${this.options.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`),
    );
    if (discovery.issuer !== this.options.issuer) {
      throw new Error("the issuer's discovery document names a different issuer");
    }
    const jwks = jwksSchema.parse(await this.getJson(discovery.jwks_uri));
    const keys = new Map<string, KeyObject>();
    for (const jwk of jwks.keys) {
      if (jwk.kid === undefined || jwk.use === 'enc') continue;
      try {
        keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
      } catch {
        // A key type this runtime cannot read verifies nothing; the others still do.
      }
    }
    this.keys = keys;
    this.fetchedAt = this.options.now();
  }

  private async getJson(url: string): Promise<unknown> {
    const response = await this.options.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    return response.json();
  }
}

function createOidcVerifier(options: OidcVerifierOptions): SystemCallerVerifier {
  const now = options.now ?? Date.now;
  const keys = new IssuerKeys({ issuer: options.issuer, fetch: options.fetch ?? fetch, now });
  const allowed = new Set(options.allowedSubjects);

  async function verify(token: string): Promise<SystemCallerVerdict> {
    const decoded = jwt.decode(token, { complete: true });
    if (decoded === null) return { ok: false, reason: 'the bearer is not a JWT' };
    const { alg, kid } = decoded.header;
    if (!isAlgorithm(alg)) return { ok: false, reason: `the token's algorithm (${alg}) is not an asymmetric one` };
    if (kid === undefined) return { ok: false, reason: 'the token names no signing key (kid)' };

    let key: KeyObject | undefined;
    try {
      key = await keys.forKid(kid);
    } catch (error) {
      return {
        ok: false,
        reason: `the issuer's keys could not be fetched: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (key === undefined) return { ok: false, reason: "the token's signing key is not one the issuer publishes" };

    let payload: unknown;
    try {
      payload = jwt.verify(token, key, { algorithms: [alg], clockTimestamp: Math.floor(now() / 1000) });
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) return { ok: false, reason: 'the token has expired' };
      if (error instanceof jwt.NotBeforeError) return { ok: false, reason: 'the token is not valid yet' };
      return { ok: false, reason: "the token's signature does not verify" };
    }

    const claims = claimsSchema.safeParse(payload);
    if (!claims.success) return { ok: false, reason: "the token's claims are malformed" };
    const { iss, aud, exp, sub, email, email_verified } = claims.data;
    if (exp === undefined) return { ok: false, reason: 'the token has no expiry' };
    if (iss !== options.issuer) return { ok: false, reason: "the token's issuer is not the configured issuer" };
    const audiences = aud === undefined ? [] : typeof aud === 'string' ? [aud] : aud;
    if (!audiences.includes(options.audience)) {
      return { ok: false, reason: "the token's audience is not the configured audience" };
    }
    // An unverified email is whatever the account holder typed.
    const verifiedEmail = email !== undefined && (email_verified === true || email_verified === 'true') ? email : undefined;
    const subject =
      sub !== undefined && allowed.has(sub)
        ? sub
        : verifiedEmail !== undefined && allowed.has(verifiedEmail)
          ? verifiedEmail
          : undefined;
    if (subject === undefined) return { ok: false, reason: "the token's subject is not on the allow-list" };
    return {
      ok: true,
      principal: { id: sub ?? subject, ...(verifiedEmail !== undefined ? { display: verifiedEmail } : {}) },
      actions: SYSTEM_ACTIONS,
    };
  }

  return {
    name: 'oidc',
    async verify({ headers }) {
      const token = bearerToken(headers);
      if (token === undefined) return { ok: false, reason: 'the request carries no bearer token' };
      return verify(token);
    },
  };
}

export { createOidcVerifier, type OidcVerifierOptions };
