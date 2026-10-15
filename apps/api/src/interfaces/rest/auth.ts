import { RequestHandler } from 'express';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';

import {
  generateJWT,
  generateRealtimeToken,
  generateMagicLinkToken,
  verifyMagicLinkToken,
} from '../../lib/middleware/authentication/token';
import { getEnvVar, requireEnv } from '../../lib/utils/environment';
import { UserService } from '../../services/user';
import { MagicLinkTokenService } from '../../services/magicLinkToken';
import { magicLinkEmail } from '../../email/magicLinkEmail';
import { logger } from 'movement-engine/services/logger';
import { services } from '../../adapters/registry';
import { AUTH_COOKIE, IMPERSONATE_COOKIE, isProd } from '../../constants';
import { clearAuthCookies, setAuthCookies } from './auth_cookies';
import { ensureAdmin } from '../../lib/utils/admin';
import { unauthorisedGetUserById } from '../../lib/middleware/authentication/identify_user';
import { SignupService } from '../../services/signup';
import { TeamInviteService } from '../../services/team_invite';
import { parseAttribution } from '../../services/signup/attribution';
import { loginWithPassword } from '../../services/auth/password_login';
import { startPasswordSignup, confirmPasswordSignup } from '../../services/auth/password_signup';

/**
 * Send a sign-in link. An INVITED address that has no account yet resolves to
 * one here (the magic-link token is keyed to a user row, so the account has to
 * exist before the link can be minted) — which is safe because an admin already
 * wrote the address down, and the emailed link, not this request, is what
 * authenticates. Anything neither invited nor known answers 200 and sends
 * nothing: this route never says whether an address exists.
 */
/** What an uninvited address is told, everywhere it is told anything. */
const NOT_INVITED_MESSAGE = 'Ask an admin of your team to add you.';

const requestMagicLinkHandler: RequestHandler = async (req, res) => {
  const email = req.body.email;
  const redirectUrl: string | undefined = req.body.redirectUrl;
  if (!email) {
    return res.status(200).send();
  }
  const resolution = await TeamInviteService.resolveSignInForVerifiedEmail({ email });
  if (resolution.status === 'not_invited') {
    return res.status(200).send();
  }
  const user = await unauthorisedGetUserById(resolution.userId);
  const token = generateMagicLinkToken(resolution.email);
  await MagicLinkTokenService.create({ token, userId: user.id });

  const webBaseUrl = getEnvVar('WEB_BASE_URL', { devDefault: 'http://localhost:3003' }).replace(
    /\/$/,
    '',
  );
  await magicLinkEmail({
    magicLink:
      `${webBaseUrl}/magic?token=${token}` +
      (redirectUrl ? `&redirectUrl=${encodeURIComponent(redirectUrl)}` : ''),
    recipientEmail: resolution.email,
    recipientName: user.username,
  });

  return res.status(200).send();
};

const verifyMagicLinkHandler: RequestHandler = async (req, res) => {
  const token = req.body.token;
  const expire = req.body.expire ?? true;

  const tokenData = await MagicLinkTokenService.getToken(token);

  if (!tokenData) {
    return res.json({ error: 'Invalid or expired token' });
  }

  // The row says the link has not been used or timed out; this says the link is
  // genuinely ours and still inside its own life. Both have to hold.
  const claims = verifyMagicLinkToken(token);
  if (claims) {
    const { email } = claims;
    // The link proves control of the address, so it goes through the same door
    // as every other verified sign-in — which is also what refuses a member
    // removed between the link being sent and being clicked.
    const resolution = await TeamInviteService.resolveSignInForVerifiedEmail({ email });
    if (resolution.status === 'not_invited') {
      return res.json({ error: 'Invalid or expired token' });
    }

    if (expire) {
      await MagicLinkTokenService.expireToken(tokenData.id);
    }

    const jwt = generateJWT(resolution.email);

    setAuthCookies(res, jwt);
    return res.json({ token: jwt, email: resolution.email });
  }
  return res.json({ error: 'Invalid or expired token' });
};

class GoogleOAuth2 {
  private _client: OAuth2Client | undefined;

  get client() {
    if (!this._client) {
      const env = requireEnv('GOOGLE_AUTH_CLIENT_SECRET', 'GOOGLE_AUTH_CLIENT_ID');

      this._client = new OAuth2Client({
        clientId: env.GOOGLE_AUTH_CLIENT_ID,
        clientSecret: env.GOOGLE_AUTH_CLIENT_SECRET,
      });
    }

    return this._client;
  }
}
const googleOAuth2 = new GoogleOAuth2();

/** A verified OAuth identity: the email plus the profile display name (when the
 *  provider supplies one). Shared shape for Google + Microsoft. */
type VerifiedIdentity = { email: string; name: string | null };

/** Best-effort human name from the OIDC name claims: the full `name`, else
 *  given + family joined, else null. Callers pass the individual claims (Google's
 *  `TokenPayload` and Microsoft's `JwtPayload` expose them with different types). */
function nameFromOidcClaims(claims: {
  name?: unknown;
  given_name?: unknown;
  family_name?: unknown;
}): string | null {
  const asString = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const full = asString(claims.name);
  if (full) return full;
  const joined = [claims.given_name, claims.family_name].map(asString).filter(Boolean).join(' ');
  return joined || null;
}

/**
 * Verify a Google idToken with the same client/audience the login callback uses,
 * returning the verified identity (email lowercased + profile name) or null.
 * Shared by login + signup.
 */
async function verifyGoogleIdToken(idToken: string): Promise<VerifiedIdentity | null> {
  const env = requireEnv('GOOGLE_AUTH_CLIENT_ID');
  const ticket = await googleOAuth2.client.verifyIdToken({
    idToken,
    audience: env.GOOGLE_AUTH_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  const email = payload?.email;
  if (!email) return null;
  return {
    email: email.toLowerCase(),
    name: nameFromOidcClaims({
      name: payload?.name,
      given_name: payload?.given_name,
      family_name: payload?.family_name,
    }),
  };
}

const authGoogleAdminCallbackHandler: RequestHandler = async (req, res) => {
  const env = requireEnv('GOOGLE_AUTH_CLIENT_ID');
  const { idToken } = req.body as { idToken: string };

  const ticket = await googleOAuth2.client.verifyIdToken({
    idToken,
    audience: env.GOOGLE_AUTH_CLIENT_ID,
  });

  const payload = ticket.getPayload();

  if (!payload?.email) {
    return res.status(400).send('No email found in the payload');
  }

  const user = await UserService.findByEmail(payload.email?.toLowerCase());

  if (!user) {
    logger.error(`User not found for email: ${payload.email}`);
    return res.status(404).send('User not found');
  }

  if (!user.isPlatformAdmin) {
    logger.warn(`Non-admin admin-login attempt: ${payload.email}`);
    return res.status(403).send('Admin access required');
  }

  const jwt = generateJWT(payload.email);

  setAuthCookies(res, jwt);
  return res.status(200).send({ token: jwt, email: payload.email });
};

class MicrosoftOAuth2 {
  private _jwksClient: jwksRsa.JwksClient | undefined;

  get jwksClient() {
    if (!this._jwksClient) {
      this._jwksClient = jwksRsa({
        jwksUri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
        cache: true,
        cacheMaxAge: 600_000,
        rateLimit: true,
      });
    }
    return this._jwksClient;
  }
}
const microsoftOAuth2 = new MicrosoftOAuth2();

/**
 * Verify a Microsoft idToken via the same JWKS + issuer-pattern path the login
 * callback uses, returning the verified email (lowercased) or null. Shared by
 * login + signup.
 */
async function verifyMicrosoftIdToken(idToken: string): Promise<VerifiedIdentity | null> {
  const env = requireEnv('MICROSOFT_CLIENT_ID');

  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || typeof decoded === 'string') return null;

  const key = await microsoftOAuth2.jwksClient.getSigningKey(decoded.header.kid);
  const signingKey = key.getPublicKey();

  const payload = jwt.verify(idToken, signingKey, {
    algorithms: ['RS256'],
    audience: env.MICROSOFT_CLIENT_ID,
  }) as jwt.JwtPayload;

  const issuer = payload.iss ?? '';
  if (!/^https:\/\/login\.microsoftonline\.com\/[^/]+\/v2\.0$/.test(issuer)) return null;

  const email = (payload.email ?? payload.preferred_username) as string | undefined;
  if (!email) return null;
  return {
    email: email.toLowerCase(),
    name: nameFromOidcClaims({
      name: payload.name,
      given_name: payload.given_name,
      family_name: payload.family_name,
    }),
  };
}

/**
 * Issue the auth cookie + JWT for a signed-in email, or refuse an address
 * nobody invited (403 + a line the frontend shows verbatim). Shared by the
 * Google + Microsoft auth handlers (both login and signup route through here —
 * `signupFromVerifiedEmail` joins an invited address on first sign-in).
 */
function finishSignup(
  res: Parameters<RequestHandler>[1],
  result: Awaited<ReturnType<typeof SignupService.signupFromVerifiedEmail>>,
) {
  if (!result.ok) {
    return res.status(403).send({ reason: result.reason, message: NOT_INVITED_MESSAGE });
  }
  const sessionJwt = generateJWT(result.email);
  setAuthCookies(res, sessionJwt);
  return res.status(200).send({ token: sessionJwt, email: result.email });
}

// Create-or-login: verify the OAuth identity, then find-or-provision the account
// (`signupFromVerifiedEmail` logs an existing user in, provisions a new one, or
// relays a gate refusal). Serves BOTH /google/callback (login) and /google/signup
// (signup) — first-time login therefore provisions a new account. (`/google/admin/
// callback` stays strict — no provisioning.)
const authGoogleAuthHandler: RequestHandler = async (req, res) => {
  const { idToken, attribution } = req.body as {
    idToken: string;
    attribution?: unknown;
  };

  const identity = await verifyGoogleIdToken(idToken);
  if (!identity) {
    return res.status(400).send('No email found in the payload');
  }

  const result = await SignupService.signupFromVerifiedEmail({
    email: identity.email,
    name: identity.name,
    source: 'google',
    attribution: parseAttribution(attribution),
  });
  return finishSignup(res, result);
};

// Create-or-login for Microsoft — serves both /microsoft/callback and
// /microsoft/signup (see the Google handler above).
const authMicrosoftAuthHandler: RequestHandler = async (req, res) => {
  const { idToken, attribution } = req.body as {
    idToken: string;
    attribution?: unknown;
  };

  let identity: VerifiedIdentity | null;
  try {
    identity = await verifyMicrosoftIdToken(idToken);
  } catch (err) {
    logger.error('Microsoft token verification failed', { error: err });
    return res.status(401).send('Invalid Microsoft token');
  }
  if (!identity) {
    return res.status(400).send('No email found in token');
  }

  const result = await SignupService.signupFromVerifiedEmail({
    email: identity.email,
    name: identity.name,
    source: 'microsoft',
    attribution: parseAttribution(attribution),
  });
  return finishSignup(res, result);
};

const authGoogleIntegrationsCallbackHandler: RequestHandler = async (req, res) => {
  if (services.google) {
    await services.google?.handleCallback(req, res);
    return;
  } else {
    return res.status(400).send('Google not configured');
  }
};

const authGmailCallbackHandler: RequestHandler = async (req, res) => {
  if (services.gmail) {
    await services.gmail.handleCallback(req, res);
    return;
  } else {
    return res.status(400).send('Gmail not configured');
  }
};

const authSlackCallbackHandler: RequestHandler = async (req, res) => {
  if (services.slack) {
    await services.slack?.handleCallback(req, res);
    return;
  } else {
    return res.status(400).send('Slack not configured');
  }
};

const authAirtableCallbackHandler: RequestHandler = async (req, res) => {
  if (services.airtable) {
    await services.airtable?.handleCallback(req, res);
    return;
  } else {
    return res.status(400).send('Airtable not configured');
  }
};

const authAttioCallbackHandler: RequestHandler = async (req, res) => {
  if (services.attio) {
    await services.attio.handleCallback(req, res);
    return;
  } else {
    return res.status(400).send('Attio not configured');
  }
};

const authDropboxCallbackHandler: RequestHandler = async (req, res) => {
  if (services.dropbox) {
    await services.dropbox.handleCallback(req, res);
    return;
  } else {
    return res.status(400).send('Dropbox not configured');
  }
};

/**
 * Email + password login. On a match, issue the same auth cookie + JWT the
 * OAuth/magic-link paths do. Every failure — unknown email, no password set,
 * wrong password — returns one generic 401 (no user-enumeration).
 */
const authPasswordLoginHandler: RequestHandler = async (req, res) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      return res.status(401).send({ error: 'Invalid email or password' });
    }

    const result = await loginWithPassword({ email, password });
    if (!result) {
      return res.status(401).send({ error: 'Invalid email or password' });
    }

    const sessionJwt = generateJWT(result.email);
    setAuthCookies(res, sessionJwt);
    return res.status(200).send({ token: sessionJwt, email: result.email });
  } catch (err) {
    logger.error('Password login failed', { error: err });
    return res.status(500).send({ error: 'Login failed' });
  }
};

/**
 * Begin a password signup — email-verified, so this creates NO account: it emails
 * a confirm link and reports status. Weak password → 400, early-access refusal →
 * 403, existing account → 200 `{status:'exists'}` (frontend routes to login),
 * otherwise 200 `{status:'check_email'}`.
 */
const authPasswordSignupHandler: RequestHandler = async (req, res) => {
  try {
    const { email, password, name, attribution } = req.body as {
      email?: string;
      password?: string;
      name?: string;
      attribution?: unknown;
    };
    if (!email || !password) {
      return res.status(400).send({ error: 'Email and password are required.' });
    }
    if (!name || !name.trim()) {
      return res.status(400).send({ error: 'Your name is required.' });
    }

    const result = await startPasswordSignup({
      email,
      password,
      name: name.trim(),
      source: 'password',
      attribution: parseAttribution(attribution),
    });
    switch (result.status) {
      case 'weak_password':
        return res.status(400).send({ error: result.reason });
      case 'not_invited':
        return res.status(403).send({ reason: 'not_invited', message: NOT_INVITED_MESSAGE });
      case 'exists':
        return res.status(200).send({ status: 'exists' });
      case 'check_email':
        return res.status(200).send({ status: 'check_email' });
    }
  } catch (err) {
    logger.error('Password signup failed', { error: err });
    return res.status(500).send({ error: 'Signup failed' });
  }
};

/**
 * Complete a password signup from the emailed token — provisions the account and
 * logs the new user in (cookie + JWT, like the magic-link landing). An
 * invalid/expired/used token → 400 generic.
 */
const authPasswordConfirmHandler: RequestHandler = async (req, res) => {
  try {
    const { token } = req.body as { token?: string };
    if (!token) {
      return res.status(400).send({ error: 'Invalid or expired link' });
    }

    const result = await confirmPasswordSignup({ token });
    if (!result) {
      return res.status(400).send({ error: 'Invalid or expired link' });
    }

    const sessionJwt = generateJWT(result.email);
    setAuthCookies(res, sessionJwt);
    return res.status(200).send({ token: sessionJwt, email: result.email });
  } catch (err) {
    logger.error('Password signup confirmation failed', { error: err });
    return res.status(500).send({ error: 'Confirmation failed' });
  }
};

/**
 * Mint a SHORT-LIVED realtime token for the WebSocket subprotocol, authenticated
 * by the httpOnly session cookie (which the web client can't read itself, and
 * which can't reach the cross-origin WS handshake). Same-origin + cookie-authed,
 * so the long-lived session token never leaves httpOnly. 401 if not signed in.
 */
const authRealtimeTokenHandler: RequestHandler = (req, res) => {
  try {
    const sessionToken = (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${AUTH_COOKIE}=`))
      ?.slice(AUTH_COOKIE.length + 1);
    if (!sessionToken) {
      return res.status(401).send({ error: 'Not authenticated' });
    }
    const { TOKEN_SECRET } = requireEnv('TOKEN_SECRET');
    const decoded = jwt.verify(decodeURIComponent(sessionToken), TOKEN_SECRET) as jwt.JwtPayload;
    const emailKey = Object.keys(decoded).find((k) => k.endsWith('/email')) ?? '';
    const email = decoded[emailKey];
    if (!email || typeof email !== 'string') {
      return res.status(401).send({ error: 'Not authenticated' });
    }
    return res.status(200).send({ token: generateRealtimeToken(email) });
  } catch {
    return res.status(401).send({ error: 'Not authenticated' });
  }
};

const logoutHandler: RequestHandler = (_req, res) => {
  clearAuthCookies(res);
  res.clearCookie(IMPERSONATE_COOKIE, { path: '/' });
  return res.status(200).send();
};

const impersonateHandler: RequestHandler = async (req, res) => {
  await ensureAdmin();
  const { userId } = req.body as { userId?: string };
  if (!userId) {
    return res.status(400).send({ error: 'userId is required' });
  }
  const targetUser = await unauthorisedGetUserById(userId);
  res.cookie(IMPERSONATE_COOKIE, userId, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  });
  return res.status(200).send({ userId: targetUser.id, username: targetUser.username });
};

const stopImpersonateHandler: RequestHandler = (_req, res) => {
  res.clearCookie(IMPERSONATE_COOKIE, { path: '/' });
  return res.status(200).send();
};

export {
  authGoogleAdminCallbackHandler,
  authGoogleAuthHandler,
  authMicrosoftAuthHandler,
  authGoogleIntegrationsCallbackHandler,
  authGmailCallbackHandler,
  requestMagicLinkHandler,
  verifyMagicLinkHandler,
  authPasswordLoginHandler,
  authPasswordSignupHandler,
  authPasswordConfirmHandler,
  authRealtimeTokenHandler,
  authSlackCallbackHandler,
  authAirtableCallbackHandler,
  authAttioCallbackHandler,
  authDropboxCallbackHandler,
  logoutHandler,
  impersonateHandler,
  stopImpersonateHandler,
};
