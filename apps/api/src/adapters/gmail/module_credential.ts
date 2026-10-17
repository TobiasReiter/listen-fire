// The credential the platform hands `@lf/gmail` for one install: whichever
// way the mailbox was connected, the module reads the same fields
// (modules/gmail/credential.ts) — the mailbox, a token per scope, how it was
// connected and what a sign-in was granted. Nothing stored changes.
//
// The row's `app_id` says which shape it is, without decrypting anything (a
// row from the retired per-user sign-in stays dead). Before anything reaches
// the module, the mailbox must be on this installation's allowlist: a
// credential connected under a wider list stops working the moment the list
// narrows, and the run's error says why.
//
//   signed in — the stored tokens through the secrets family, refreshed first
//     when they expire within google-auth-library's eager window, by the
//     standard grant with this installation's Gmail OAuth client (against the
//     dev loop's fake Google for the test-harness team). The family runs one
//     refresh at a time and the store's lock keeps two processes from
//     spending one refresh token; the rotated tokens are written back.
//   delegated — no token is stored at all. The service account mints one per
//     scope, held here until it nears expiry and never written down; a grant
//     without the send scope leaves reads working and names why a send is
//     refused. Under the dev loop no token is minted.

import type { ModuleCredential, CredentialFields } from 'module-kit';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';
import type { PayloadShape } from '../../services/credentials/secrets_postgres';

import { z } from 'zod';
import { GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE } from '@listen-fire/gmail/api_client';
import { createSecretsFamily, expiresWithin, oauth2Refresher, type SecretsFamily } from 'movement-engine/public/secrets';
import { logger } from 'movement-engine/public/log';

import { getAutomationsQb } from '../../lib/kysely';
import { injectFakeBaseUrl, isTestHarnessTeam } from '../../lib/recording';
import { gmailCredentialShape } from '../../services/credentials/app_id';
import { camelTokenPayloadShape, flatPayloadShape, postgresSecrets } from '../../services/credentials/secrets_postgres';
import { DEV_LOOP_GMAIL_TOKEN, checkGmailMailboxAllowed, classifyGmailError, mintDelegatedGmailToken } from './apiClient';
import { gmailOAuth2 } from './authClient';
import { gmailOAuthClientCredentials, gmailOAuthScopes } from './connect_method';

/** google-auth-library's eager threshold, which the platform's Gmail token
 *  clients refreshed by before Gmail was a module. */
const REFRESH_WINDOW_MS = 5 * 60_000;

/**
 * A signed-in mailbox's stored payload, `{ mailbox, accessToken,
 * refreshToken, expiresAt, grantedScopes }`, read as the module's fields:
 * the token fields as the protocol spells them, the granted scopes space
 * separated, the method named. Only the token fields are ever written back.
 */
export const gmailOAuthPayloadShape: PayloadShape = {
  toFields(payload) {
    const fields = camelTokenPayloadShape.toFields(payload);
    const granted = payload.grantedScopes;
    if (Array.isArray(granted)) fields.granted_scopes = granted.filter((scope): scope is string => typeof scope === 'string').join(' ');
    fields.method = 'oauth';
    return fields;
  },
  withFields(payload, changed) {
    const tokens: Record<string, string> = {};
    for (const [key, value] of Object.entries(changed)) if (key !== 'granted_scopes' && key !== 'method') tokens[key] = value;
    return camelTokenPayloadShape.withFields(payload, tokens);
  },
};

const signedIn = z.object({
  mailbox: z.string().email(),
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.string(),
});
const delegated = z.object({ mailbox: z.string().email() });

export interface GmailInstall {
  teamId: TeamId;
  credentialsId?: string;
}

function unusable(install: GmailInstall): Error {
  return new Error(
    `GmailAdapter: no usable Gmail mailbox for team ${install.teamId} ` +
      `(credentialsId=${install.credentialsId ?? 'unset'}). Connect Gmail.`,
  );
}

/** The dev loop's fake Google, for the test-harness team only. */
function harnessBaseUrl(teamId: TeamId): string | undefined {
  if (!isTestHarnessTeam(teamId)) return undefined;
  const redirected = injectFakeBaseUrl({}, 'GOOGLE_GMAIL').baseUrl;
  return typeof redirected === 'string' ? redirected : undefined;
}

async function shapeOf(install: GmailInstall & { credentialsId: string }): Promise<'oauth' | 'delegated' | null> {
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', install.credentialsId as ExternalServiceCredentialsId)
    .where('team_id', '=', install.teamId)
    .select(['app_id'])
    .executeTakeFirst();
  return row === undefined ? null : gmailCredentialShape(row.app_id);
}

function allowedOrThrow(mailbox: string, method: 'oauth' | 'delegated', env: NodeJS.ProcessEnv): void {
  const allowed = checkGmailMailboxAllowed(mailbox, { method, env });
  if (!allowed.ok) throw new Error(`GmailAdapter: ${allowed.message}`);
}

// ── Delegated tokens ────────────────────────────────────────────────────────

interface MintedFields {
  fields: CredentialFields;
  /** When the earliest of its tokens expires (epoch ms). */
  expiresAt: number;
}

/** Minted tokens per mailbox, never written down. */
const minted = new Map<string, MintedFields>();

/** One token for one scope, acting as the mailbox. */
type Mint = (mailbox: string, scope: string) => Promise<{ token: string; expiresAt: number }>;

async function delegatedFields(mailbox: string, options: { fake: boolean; mint: Mint; now: number }): Promise<CredentialFields> {
  if (options.fake) {
    return { mailbox, method: 'delegated', access_token: DEV_LOOP_GMAIL_TOKEN, send_access_token: DEV_LOOP_GMAIL_TOKEN };
  }
  const held = minted.get(mailbox);
  if (held !== undefined && held.expiresAt - options.now > REFRESH_WINDOW_MS) return held.fields;

  // A read token Google refuses is the mailbox refusing the impersonation:
  // it fails the call, as it always did.
  const read = await options.mint(mailbox, GMAIL_READONLY_SCOPE);
  let send: { token: string; expiresAt: number } | undefined;
  let refusal: string | undefined;
  try {
    send = await options.mint(mailbox, GMAIL_SEND_SCOPE);
  } catch (error) {
    const classified = classifyGmailError(error, 'users.messages.send');
    // Anything but a refused scope is not a fact about the grant: the call
    // fails, and nothing is held, so the next one asks again.
    if (classified.failure !== 'missing_send_scope') throw classified;
    refusal = classified.message;
  }
  const fields: CredentialFields = {
    mailbox,
    method: 'delegated',
    access_token: read.token,
    expires_at: new Date(read.expiresAt).toISOString(),
    ...(send !== undefined ? { send_access_token: send.token } : {}),
    ...(refusal !== undefined ? { send_refusal: refusal } : {}),
  };
  minted.set(mailbox, { fields, expiresAt: Math.min(read.expiresAt, send?.expiresAt ?? read.expiresAt) });
  return fields;
}

/** Forget what was minted (a test, or a mailbox disconnected). */
export function forgetMintedGmailTokens(): void {
  minted.clear();
}

// ── Signed-in tokens ────────────────────────────────────────────────────────

async function signedInFields(input: {
  secrets: SecretsFamily;
  ref: string;
  install: GmailInstall;
  fakeBaseUrl: string | undefined;
  env: NodeJS.ProcessEnv;
}): Promise<CredentialFields> {
  const record = await input.secrets.resolve(input.ref);
  const parsed = signedIn.safeParse(record.fields);
  if (!parsed.success) throw unusable(input.install);
  allowedOrThrow(parsed.data.mailbox, 'oauth', input.env);
  if (!expiresWithin(record.fields, REFRESH_WINDOW_MS)) return record.fields;

  const client = gmailOAuthClientCredentials(input.env);
  if (client === null) {
    throw new Error(
      `GmailAdapter: the token for ${parsed.data.mailbox} has expired and this installation has no Gmail OAuth client to refresh it. ` +
        'Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET (or the GOOGLE_INTEGRATIONS pair).',
    );
  }
  const oauth2 = gmailOAuth2({ scopes: gmailOAuthScopes(input.env), ...(input.fakeBaseUrl !== undefined ? { fakeBaseUrl: input.fakeBaseUrl } : {}) });
  const refresher = oauth2Refresher({ tokenUrl: oauth2.tokenUrl, clientAuth: 'body', client });
  return (await input.secrets.refresh(input.ref, { seenVersion: record.version, refresher })).fields;
}

// ── The credential ──────────────────────────────────────────────────────────

/** The credential `@lf/gmail` is handed for one install on the platform. */
export function gmailModuleCredential(
  install: GmailInstall,
  options: { env?: NodeJS.ProcessEnv; mint?: Mint; now?: () => number } = {},
): ModuleCredential {
  const env = options.env ?? process.env;
  const familyOf = (shape: PayloadShape) =>
    createSecretsFamily({ backend: postgresSecrets({ teamId: install.teamId, shape }), warn: (message) => logger.warn(message) });
  return {
    name: 'gmail',
    fields: async () => {
      const ref = install.credentialsId;
      if (ref === undefined) throw unusable(install);
      const shape = await shapeOf({ ...install, credentialsId: ref });
      const fakeBaseUrl = harnessBaseUrl(install.teamId);
      switch (shape) {
        case null:
          throw unusable(install);
        case 'oauth':
          return signedInFields({ secrets: familyOf(gmailOAuthPayloadShape), ref, install, fakeBaseUrl, env });
        case 'delegated': {
          const parsed = delegated.safeParse((await familyOf(flatPayloadShape).resolve(ref)).fields);
          if (!parsed.success) throw unusable(install);
          allowedOrThrow(parsed.data.mailbox, 'delegated', env);
          return delegatedFields(parsed.data.mailbox, { fake: fakeBaseUrl !== undefined, mint: options.mint ?? mintDelegatedGmailToken, now: (options.now ?? Date.now)() });
        }
        default: {
          const unknownShape: never = shape;
          throw new Error(`GmailAdapter: unknown credential shape ${String(unknownShape)}`);
        }
      }
    },
    update: async (fields) => {
      const ref = install.credentialsId;
      if (ref === undefined) throw unusable(install);
      // Only a sign-in stores tokens; a delegated mailbox has none to write.
      if ((await shapeOf({ ...install, credentialsId: ref })) !== 'oauth') return;
      await familyOf(gmailOAuthPayloadShape).update(ref, fields);
    },
  };
}
