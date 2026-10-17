// The dev loop's OAuth proof: a Dropbox credential signed in against the fake
// OAuth provider in fake-channels, and the two moves a refresh test needs —
// making the stored token stale, and reading what the provider was asked.

import { randomUUID } from 'node:crypto';

import { createSecretsFamily } from 'movement-engine/public/secrets';

import { DropboxAuthClient } from '../../../adapters/dropbox/authClient';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';
import type { TeamId } from '../../../generated/kysely/core/Team';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { encryptToken } from '../../../lib/credentials';
import { getAutomationsQb } from '../../../lib/kysely';
import { camelTokenPayloadShape, postgresSecrets } from '../../../services/credentials/secrets_postgres';

export const DEV_LOOP_DROPBOX_CREDENTIAL_NAME = 'Dev Loop Dropbox';

export function fakeChannelsUrl(): string {
  return (process.env.FAKE_CHANNELS_URL ?? 'http://localhost:5556').replace(/\/$/, '');
}

interface TokenCall {
  grant: string;
  outcome: string;
  presented: string;
  issuedAccess?: string;
  issuedRefresh?: string | null;
  at: string;
}

export interface OAuthFakeState {
  config: { expiresIn: number; rotate: boolean; failNext: number; failWith: string };
  access: { id: string; refreshToken: string; expiresAt: number; expired: boolean }[];
  refresh: { id: string; active: boolean }[];
  calls: TokenCall[];
}

export async function fakeOAuthState(): Promise<OAuthFakeState> {
  const res = await fetch(`${fakeChannelsUrl()}/oauth/control/state`);
  if (!res.ok) throw new Error(`fake-channels /oauth/control/state failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as OAuthFakeState;
}

export async function fakeOAuthControl(route: 'config' | 'expire', body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${fakeChannelsUrl()}/oauth/control/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`fake-channels /oauth/control/${route} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Sign in against the fake provider through the real auth client (authorize
 *  redirect, code exchange) and store the tokens as a Dropbox credential. */
export async function ensureDevLoopDropboxCredential(input: { teamId: string }): Promise<{ id: string; created: boolean }> {
  const qb = getAutomationsQb(['external_service_credentials']);
  const existing = await qb
    .selectFrom('external_service_credentials')
    .where('team_id', '=', input.teamId as TeamId)
    .where('type', '=', ExternalServiceType.DROPBOX)
    .where('name', '=', DEV_LOOP_DROPBOX_CREDENTIAL_NAME)
    .select('id')
    .executeTakeFirst();
  if (existing) return { id: existing.id, created: false };

  const fakeBaseUrl = fakeChannelsUrl();
  const authClient = new DropboxAuthClient({
    clientId: process.env.DROPBOX_CLIENT_ID || 'dev-loop-dropbox-client',
    clientSecret: process.env.DROPBOX_CLIENT_SECRET || 'dev-loop-dropbox-secret',
    redirectBaseUrl: process.env.OAUTH_REDIRECT_BASE_URL || 'http://localhost:3003',
    fakeBaseUrl,
  });
  const consent = await fetch(authClient.generateInstallUrl(), { redirect: 'manual' });
  const location = consent.headers.get('location');
  if (!location) {
    throw new Error(`The fake OAuth consent at ${fakeBaseUrl} did not redirect back (${consent.status}). Is fake-channels running?`);
  }
  const back = new URL(location);
  const tokens = await authClient.codeToToken({
    state: back.searchParams.get('state') ?? '',
    code: back.searchParams.get('code') ?? '',
  });

  const id = randomUUID() as ExternalServiceCredentialsId;
  await qb
    .insertInto('external_service_credentials')
    .values({
      id,
      name: DEV_LOOP_DROPBOX_CREDENTIAL_NAME,
      type: ExternalServiceType.DROPBOX,
      credentials: await encryptToken(JSON.stringify(tokens), id),
      team_id: input.teamId as TeamId,
    } as never)
    .execute();
  return { id, created: true };
}

async function devLoopDropboxCredentialIds(teamId: string): Promise<string[]> {
  const rows = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', teamId as TeamId)
    .where('type', '=', ExternalServiceType.DROPBOX)
    .where('name', '=', DEV_LOOP_DROPBOX_CREDENTIAL_NAME)
    .select('id')
    .execute();
  return rows.map((r) => r.id);
}

/** What the team's Dropbox credential holds right now, with the token values
 *  cut to their ends — enough to see that one changed, never a usable secret. */
export async function readDevLoopDropboxCredential(teamId: string): Promise<{ id: string; accessToken: string; refreshToken: string; expiresAt: string }[]> {
  const secrets = createSecretsFamily({ backend: postgresSecrets({ shape: camelTokenPayloadShape, teamId }) });
  const shown = (value: string | undefined) => (value === undefined ? '' : `…${value.slice(-12)}`);
  const out = [];
  for (const id of await devLoopDropboxCredentialIds(teamId)) {
    const { fields } = await secrets.resolve(id);
    out.push({
      id,
      accessToken: shown(fields.access_token),
      refreshToken: shown(fields.refresh_token),
      expiresAt: fields.expires_at ?? '',
    });
  }
  return out;
}

/** Make the team's Dropbox credential stale on both sides: the stored expiry
 *  moves into the past (so the adapter refreshes) and the provider refuses the
 *  stored access token (so a run that skipped the refresh would fail). */
export async function expireDevLoopDropboxCredential(teamId: string): Promise<{ credentials: string[]; providerExpired: unknown }> {
  const secrets = createSecretsFamily({ backend: postgresSecrets({ shape: camelTokenPayloadShape, teamId }) });
  const ids = await devLoopDropboxCredentialIds(teamId);
  const providerExpired = await fakeOAuthControl('expire', {});
  for (const id of ids) {
    const { version } = await secrets.resolve(id);
    await secrets.writeBack(id, { expires_at: new Date(Date.now() - 60_000).toISOString() }, version);
  }
  return { credentials: ids, providerExpired };
}
