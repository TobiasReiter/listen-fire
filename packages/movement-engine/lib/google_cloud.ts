// The one Google service account this deployment has, and the four variables
// that describe it.
//
// Read straight from the environment rather than through `getEnvVar`, because
// "no Google credentials" has to be expressible without throwing: image
// generation falls back to another vendor when they are absent, and the model
// route asks whether they are there before deciding anything. A helper that
// throws in production on an unset variable cannot answer that question.

import { GoogleAuth } from 'google-auth-library';

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Where image generation and OCR address Google. Claude's endpoint is chosen
 *  separately (`GOOGLE_MODEL_REGION`) — it wants the global one, not a region. */
const DEFAULT_PROJECT_LOCATION = 'europe-west1';

export interface GoogleServiceAccount {
  privateKey: string;
  clientEmail: string;
  projectId: string;
  projectLocation: string;
}

/** The variables that must carry a value for the account to exist at all.
 *  `GOOGLE_PROJECT_LOCATION` is not among them: it has a default. */
const REQUIRED_VARS = ['GOOGLE_PRIVATE_KEY', 'GOOGLE_CLIENT_EMAIL', 'GOOGLE_PROJECT_ID'] as const;

/**
 * A PEM private key carried in an environment variable usually arrives with its
 * line breaks escaped — one `\n` per line, as two characters. Unescaping is a
 * no-op for a key that already has real newlines, so it is safe either way.
 */
function unescapeNewlines(key: string): string {
  return key.replace(/\\n/g, '\n');
}

export function isGoogleServiceAccountConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return REQUIRED_VARS.every((name) => Boolean(env[name]));
}

/** The variables a caller still has to set. Empty when the account is complete. */
export function missingGoogleServiceAccountVars(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return REQUIRED_VARS.filter((name) => !env[name]);
}

export function googleServiceAccount(env: NodeJS.ProcessEnv = process.env): GoogleServiceAccount {
  const missing = missingGoogleServiceAccountVars(env);
  if (missing.length > 0) {
    throw new Error(
      `Google Cloud credentials are not configured — set ${missing.join(', ')}.`,
    );
  }
  return {
    privateKey: unescapeNewlines(env.GOOGLE_PRIVATE_KEY ?? ''),
    clientEmail: env.GOOGLE_CLIENT_EMAIL ?? '',
    projectId: env.GOOGLE_PROJECT_ID ?? '',
    projectLocation: env.GOOGLE_PROJECT_LOCATION || DEFAULT_PROJECT_LOCATION,
  };
}

/** The service account as `google-auth-library` wants it, scoped for every
 *  Google Cloud API this deployment reaches. */
export function googleAuth(env: NodeJS.ProcessEnv = process.env): GoogleAuth {
  const { privateKey, clientEmail } = googleServiceAccount(env);
  return new GoogleAuth({
    credentials: {
      type: 'service_account',
      private_key: privateKey,
      client_email: clientEmail,
    },
    scopes: [CLOUD_PLATFORM_SCOPE],
  });
}

/** The two Gmail scopes a connected mailbox is reached through. Read and send,
 *  and nothing else: the account can never label, move or delete mail. A
 *  Workspace admin grants exactly these against the service account's client id
 *  under domain wide delegation. */
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/**
 * The service account acting AS a mailbox, rather than as itself.
 *
 * {@link googleAuth} authenticates the account for its own cloud resources;
 * this one impersonates a Workspace user, which is what reading someone's inbox
 * requires. The impersonation is granted once by a Workspace admin against the
 * account's client id, so nothing here can widen it — an ungranted subject or
 * scope fails at the token exchange with `unauthorized_client`.
 *
 * Proven shape: `interfaces/cli/commands/watch-gmail.ts` has called Gmail this
 * way since long before the connector existed.
 */
export function delegatedGoogleAuth(input: {
  subject: string;
  scopes: readonly string[];
  env?: NodeJS.ProcessEnv;
}): GoogleAuth {
  const { privateKey, clientEmail } = googleServiceAccount(input.env ?? process.env);
  return new GoogleAuth({
    credentials: {
      type: 'service_account',
      private_key: privateKey,
      client_email: clientEmail,
    },
    scopes: [...input.scopes],
    clientOptions: { subject: input.subject },
  });
}

/**
 * The mailboxes THIS installation will act as. Google's domain wide delegation
 * has no per-mailbox limit of its own — once granted, the service account can
 * impersonate ANY address in the Workspace — so this list is the only thing
 * standing between "the delegation is granted" and "anyone can connect anyone
 * else's mailbox". Comma separated, compared case insensitively after
 * trimming.
 *
 * Unset (or empty) parses to an empty set, which every caller reads as "no
 * mailbox may be connected or used" — never as "every mailbox is allowed". An
 * unset list defaulting to "everything" would be a guarantee that silently is
 * not one.
 */
export function gmailMailboxAllowlist(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.GMAIL_MAILBOX_ALLOWLIST ?? '';
  return new Set(
    raw
      .split(',')
      .map((address) => address.trim().toLowerCase())
      .filter((address) => address !== ''),
  );
}

/**
 * A bearer token source for a long-lived client that must ask again on every
 * request — a Google access token lasts about an hour, and a process that runs
 * longer than that outlives the one it was built with.
 *
 * Bound to ONE `GoogleAuth`, deliberately: the library caches the token on its
 * client and mints a new one only as the old one expires, so asking per request
 * costs a property read rather than a round trip.
 */
export function googleBearerTokens(env: NodeJS.ProcessEnv = process.env): () => Promise<string> {
  const auth = googleAuth(env);
  return async () => {
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('Google Cloud refused an access token for the service account.');
    return token;
  };
}

/**
 * Where this deployment addresses Google's MODELS. The global endpoint is the
 * recommended one and the only one without a regional price premium —
 * deliberately NOT {@link GoogleServiceAccount.projectLocation}, which is a real
 * region that OCR and image generation need.
 */
export function googleModelRegion(env: NodeJS.ProcessEnv = process.env): string {
  return env.GOOGLE_MODEL_REGION || 'global';
}
