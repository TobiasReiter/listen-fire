// The sign-in link's two expiries, and what a link past them answers.
//
// A magic link is a JWT stored in a `magic_link_token` row, and BOTH carry an
// expiry. The verify path checks the row and then the JWT, so the row's number
// being the larger of the two opened a window — a link older than the JWT's
// life but younger than the row's — where the row check passed and the JWT
// check threw out of the handler as a 500. One constant closes it; a `null`
// from the verify step rather than a throw is what makes the window, if one
// ever reopens, answer the way every other rejection does.

import { AddressInfo } from 'node:net';

import express from 'express';

import type { Server } from 'node:http';

const ORIGINAL_TOKEN_SECRET = process.env.TOKEN_SECRET;
process.env.TOKEN_SECRET = 'test-token-secret';

import { sign, decode } from 'jsonwebtoken';

import {
  generateMagicLinkToken,
  verifyMagicLinkToken,
} from '../../../lib/middleware/authentication/token';
import { MAGIC_LINK_EXPIRY, SECOND } from '../../../constants';

const LIVE_ROW = {
  id: 'row-1',
  token: 'unused',
  userId: 'user-1',
  expiresAt: new Date(Date.now() + MAGIC_LINK_EXPIRY),
};

// The row lookup and the invite check are the two doors either side of the JWT
// check; the point of this suite is what happens BETWEEN them, so both are
// held open.
// The OIDC verifier for the Microsoft sign-in door, which this file shares a
// module with and does not exercise. It reaches `jose`, which ships ESM only —
// importing it is a syntax error under this jest transform, and has nothing to
// do with magic links either way.
jest.mock('jwks-rsa', () => ({ __esModule: true, default: () => ({}) }));

const getToken = jest.fn();
const expireToken = jest.fn();
jest.mock('../../../services/magicLinkToken', () => ({
  MagicLinkTokenService: {
    getToken: (...args: unknown[]) => getToken(...args),
    expireToken: (...args: unknown[]) => expireToken(...args),
  },
}));
jest.mock('../../../services/team_invite', () => ({
  TeamInviteService: {
    resolveSignInForVerifiedEmail: async ({ email }: { email: string }) => ({
      status: 'ok',
      email,
      userId: 'user-1',
    }),
  },
}));

import { verifyMagicLinkHandler } from '../auth';

describe('the sign-in link', () => {
  afterAll(() => {
    if (ORIGINAL_TOKEN_SECRET === undefined) delete process.env.TOKEN_SECRET;
    else process.env.TOKEN_SECRET = ORIGINAL_TOKEN_SECRET;
  });

  // The bug itself: two numbers where there should be one. Asserted on the
  // minted token rather than on the source, because the drift was between what
  // the row was stamped with and what the signer actually put in the JWT.
  it('signs the JWT with the same life the row is stamped with', () => {
    const claims = decode(generateMagicLinkToken('someone@example.com')) as {
      iat: number;
      exp: number;
    };

    expect((claims.exp - claims.iat) * SECOND).toBe(MAGIC_LINK_EXPIRY);
  });

  it('reads back the address it was minted for', () => {
    expect(verifyMagicLinkToken(generateMagicLinkToken('someone@example.com'))).toEqual({
      email: 'someone@example.com',
    });
  });

  it.each([
    ['expired', sign({ email: 'someone@example.com' }, 'test-token-secret', { expiresIn: -60 })],
    ['signed by another secret', sign({ email: 'someone@example.com' }, 'not-our-secret')],
    ['carrying no address', sign({ nothing: true }, 'test-token-secret')],
    ['not a JWT at all', 'not-a-jwt'],
  ])('refuses a token %s rather than throwing', (_case, token) => {
    expect(verifyMagicLinkToken(token)).toBeNull();
  });

  describe('the verify door', () => {
    let server: Server;
    let base: string;

    beforeAll(async () => {
      const app = express();
      app.use(express.json());
      app.post('/api/public/auth/verifyMagicLink', verifyMagicLinkHandler);
      await new Promise<void>((resolve) => {
        server = app.listen(0, resolve);
      });
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    beforeEach(() => {
      getToken.mockReset();
      expireToken.mockReset();
    });

    async function verify(token: string) {
      return fetch(`${base}/api/public/auth/verifyMagicLink`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    }

    it('signs in with a live row and a live token', async () => {
      getToken.mockResolvedValue(LIVE_ROW);
      const res = await verify(generateMagicLinkToken('someone@example.com'));

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ email: 'someone@example.com' });
      expect(expireToken).toHaveBeenCalledWith('row-1');
    });

    // The 500. A row that has outlived the token inside it is exactly the
    // state the two expiries used to produce, and the answer must be the
    // handler's own rejection rather than a thrown `verify()`.
    it('refuses an expired token on a live row, as a rejection and not an error', async () => {
      getToken.mockResolvedValue(LIVE_ROW);
      const stale = sign({ email: 'someone@example.com' }, 'test-token-secret', {
        expiresIn: -60,
      });

      const res = await verify(stale);

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ error: 'Invalid or expired token' });
      expect(expireToken).not.toHaveBeenCalled();
    });

    it('refuses a token with no row at all', async () => {
      getToken.mockResolvedValue(null);
      const res = await verify(generateMagicLinkToken('someone@example.com'));

      await expect(res.json()).resolves.toEqual({ error: 'Invalid or expired token' });
    });
  });
});
