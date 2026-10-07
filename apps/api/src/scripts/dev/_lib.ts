import './_profile_loader';

import { randomUUID } from 'node:crypto';

import { getAutomationsQb, getCoreQb, getKnowledgeQb, getQb } from '../../lib/kysely';
import { materializeTemplate } from '../../lib/knowledge/templates/materialize';
import { generateJWT } from '../../lib/middleware/authentication/token';
import { encryptToken, decryptToken } from '../../lib/credentials';
import {
  GMAIL_APP_ID,
  gmailCredentialShape,
  isLegacyApp,
  defaultAppIdForType,
} from '../../services/credentials/app_id';
import { GmailAuthClient } from '../../adapters/gmail/authClient';
import {
  gmailConnectMethod,
  type GmailConnectMethod,
} from '../../adapters/gmail/connect_method';
import { intrinsicProvisionerForType } from '../../services/credentials/intrinsic_provision';
import { persistCredential } from '../../services/credentials/persist_credential';
import { Context } from '../../services/context';
import { ensurePublicIdentity } from '../../startup/core';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';
import type { PipelineConfigurationId } from '../../generated/kysely/public/PipelineConfiguration';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';
import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { installRemoteAdapterFromManifest } from '../../services/translation_graph/adapters/remote/install';
import { CurrencyAsset } from '../../lib/datasources/currency';
import { FAKE_CRM_SECRET, fakeCrmBaseUrl, fakeCrmManifest } from './fake_crm_adapter';
import { userPrincipal } from '../../services/principal';

export const DEV_LOOP_EMAIL = 'dev-loop@listen-fire.local';
export const DEV_LOOP_USERNAME = 'dev-loop';
export const DEV_LOOP_TEAM_NAME = 'Dev Loop';

/**
 * The mock Slack credential every dev-loop provisioner writes to
 * (`dev:airtable`, `dev:whatsapp`, `dev:movement`, `dev:granola`,
 * `dev:telegram` all point their proof movement at the fake `dealflow`
 * channel). One copy, because three byte-identical ones drifted into a bug
 * nobody spotted:
 *
 * Slack is TWO apps (legacy / modern "listen-fire"), and a NULL `app_id`
 * reads as the legacy one (`isLegacyApp`). Movements run on the modern app, so
 * the authoring surface HIDES legacy Slack credentials
 * (`loadCredentialRows`) — and a raw insert that omitted `app_id` therefore
 * minted a credential the checker could not see, failing every dev-loop
 * movement with "Unknown credential 'Dev Loop Slack'". `defaultAppIdForType`
 * is what the real connect flow uses; going through it is the whole fix.
 */
/** The dev-loop mailbox, and the name every Gmail proof movement refers to. */
export const DEV_LOOP_GMAIL_CREDENTIAL_NAME = 'Dev Loop Gmail';

/**
 * The dev-loop team's connected mailbox, in the shape this profile's connect
 * method mints.
 *
 * DELEGATED is a row and nothing else: the address is the whole credential.
 *
 * OAUTH runs the REAL sign-in against the fake Google in fake-channels —
 * install URL, consent redirect, code exchange — so the stored row carries
 * tokens and granted scopes that came out of the actual OAuth client rather
 * than out of a fixture. The mailbox address is read straight off the fake's
 * profile endpoint: this is provisioning, and the connector's own profile call
 * is what the callback path exercises.
 *
 * `replace` re-seeds an existing row, which is how `dev:gmail setup --method`
 * switches a stack between the two shapes.
 */
export async function ensureDevLoopGmailCredential(input: {
  teamId: TeamId;
  method?: GmailConnectMethod;
  replace?: boolean;
}): Promise<{ created: boolean; method: GmailConnectMethod }> {
  const method = input.method ?? gmailConnectMethod();
  const existing = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', input.teamId)
    .where('type', '=', ExternalServiceType.GOOGLE_GMAIL)
    .where('name', '=', DEV_LOOP_GMAIL_CREDENTIAL_NAME)
    .select(['id', 'app_id'])
    .executeTakeFirst();

  if (existing && !input.replace && gmailCredentialShape(existing.app_id) === method) {
    return { created: false, method };
  }
  if (existing) {
    await getAutomationsQb(['external_service_credentials'])
      .deleteFrom('external_service_credentials')
      .where('id', '=', existing.id)
      .execute();
  }

  const payload =
    method === 'oauth' ? await devLoopGmailOAuthPayload() : { mailbox: DEV_LOOP_EMAIL };
  const appId =
    method === 'oauth' ? GMAIL_APP_ID.oauthMailbox : GMAIL_APP_ID.delegatedMailbox;

  const credId = randomUUID() as ExternalServiceCredentialsId;
  await getAutomationsQb(['external_service_credentials'])
    .insertInto('external_service_credentials')
    .values({
      id: credId,
      name: DEV_LOOP_GMAIL_CREDENTIAL_NAME,
      type: ExternalServiceType.GOOGLE_GMAIL,
      credentials: await encryptToken(JSON.stringify(payload), credId),
      app_id: appId,
      team_id: input.teamId,
    } as never)
    .execute();
  return { created: true, method };
}

function fakeChannelsUrl(): string {
  return (process.env.FAKE_CHANNELS_URL ?? 'http://localhost:5556').replace(/\/$/, '');
}

async function devLoopGmailOAuthPayload(): Promise<Record<string, unknown>> {
  const fakeBaseUrl = fakeChannelsUrl();
  const authClient = new GmailAuthClient({
    clientId: process.env.GOOGLE_INTEGRATIONS_CLIENT_ID || 'dev-loop-google-client',
    clientSecret: process.env.GOOGLE_INTEGRATIONS_CLIENT_SECRET || 'dev-loop-google-secret',
    redirectBaseUrl: process.env.OAUTH_REDIRECT_BASE_URL || 'http://localhost:3003',
    fakeBaseUrl,
  });

  const installUrl = await authClient.generateInstallUrl();
  const consent = await fetch(installUrl, { redirect: 'manual' });
  const location = consent.headers.get('location');
  if (!location) {
    throw new Error(
      `The fake Google consent at ${fakeBaseUrl} did not redirect back ` +
        `(${consent.status}). Is fake-channels running?`,
    );
  }
  const back = new URL(location);
  const tokens = await authClient.codeToToken({
    state: back.searchParams.get('state') ?? '',
    code: back.searchParams.get('code') ?? '',
  });

  const profileResponse = await fetch(`${fakeBaseUrl}/gmail/v1/users/me/profile`);
  const profile: unknown = await profileResponse.json();
  const mailbox =
    typeof profile === 'object' && profile !== null
      ? String(Reflect.get(profile, 'emailAddress') ?? DEV_LOOP_EMAIL)
      : DEV_LOOP_EMAIL;

  return { mailbox, ...tokens };
}

export async function ensureDevLoopSlackCredential(teamId: string): Promise<void> {
  const existing = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', teamId as TeamId)
    .where('type', '=', ExternalServiceType.SLACK)
    .where('name', '=', 'Dev Loop Slack')
    .select(['id', 'app_id'])
    .executeTakeFirst();

  if (existing) {
    // Heal a row minted before this was fixed — otherwise an existing dev-loop
    // team stays broken forever, since provisioning is idempotent and would
    // just return here.
    if (isLegacyApp(existing.app_id)) {
      await getAutomationsQb(['external_service_credentials'])
        .updateTable('external_service_credentials')
        .set({ app_id: defaultAppIdForType(ExternalServiceType.SLACK) })
        .where('id', '=', existing.id)
        .execute();
    }
    return;
  }

  const credId = randomUUID() as ExternalServiceCredentialsId;
  const encrypted = await encryptToken(
    JSON.stringify({ accessToken: 'dev-loop-slack-token' }),
    credId,
  );
  await getAutomationsQb(['external_service_credentials'])
    .insertInto('external_service_credentials')
    .values({
      id: credId,
      name: 'Dev Loop Slack',
      type: ExternalServiceType.SLACK,
      credentials: encrypted,
      team_id: teamId,
      app_id: defaultAppIdForType(ExternalServiceType.SLACK),
    } as never)
    .execute();
}
/**
 * The install probes the server's own `manifest` answer for its protocol
 * version, so the fixture has to be up first. A refused connection is named
 * here, with the command that starts it, instead of surfacing as the install's
 * bare `fetch failed`.
 */
async function requireFakeCrmRunning(baseUrl: string): Promise<void> {
  try {
    // Any HTTP answer (a 401 included) means something is listening.
    await fetch(baseUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  } catch (err) {
    throw new Error(
      `The fake CRM (acme_crm) is not running at ${baseUrl} (${err instanceof Error ? err.message : String(err)}). ` +
        'The dev loop starts it (`pnpm dev:loop:agent`); to start it on its own, run `cd apps/api && pnpm dev:fake-crm`, then re-run `pnpm dev:seed`.',
    );
  }
}

/**
 * The dev loop's one REMOTE adapter: install `acme_crm` pointing at the durable
 * fake-CRM fixture (`pnpm dev:fake-crm`, booted by `dev/loop.sh` on this
 * profile's `FAKE_REMOTE_ADAPTER_PORT`).
 *
 * Installing is an UPSERT on `(team_id, adapter_type)`, so re-seeding HEALS a
 * row whose `base_url` points somewhere dead rather than duplicating it — which
 * is the whole reason this belongs in seed. It used to be installed only by
 * `dev:remote-verify`, against an ephemeral port, so the row went stale the
 * instant that script exited and `acme_crm` was the one system nobody could
 * inspect (`fetch failed` in the graph explorer).
 */
export async function ensureDevLoopRemoteAdapter(options: {
  teamId: string;
  userId: string;
}): Promise<{ baseUrl: string }> {
  const baseUrl = fakeCrmBaseUrl();
  await requireFakeCrmRunning(baseUrl);
  await installRemoteAdapterFromManifest({
    teamId: options.teamId as TeamId,
    userId: options.userId as UserId,
    manifest: fakeCrmManifest(baseUrl),
    secret: FAKE_CRM_SECRET,
  });
  return { baseUrl };
}

export const DEV_LOOP_KNOWLEDGE_CREDENTIAL_NAME = 'Dev Loop Knowledge';

/**
 * The dev loop's `kg` connection. The knowledge graph is reached over HTTP with
 * a stored credential like any other system (D25), so a seeded team without one
 * has no graph at all — every `kg` movement fails at construction. Provisioning
 * it is the SAME act the user's connect flow performs: the shared intrinsic
 * provisioner mints the `knowledge`-scoped api-key, registers it as
 * Listen-Fire-owned (so the graph's own mutation webhook doesn't echo our writes back
 * into the run that made them), and the shared persist writes the row.
 *
 * The stored `baseUrl` is healed in place when the active stack moved: agents
 * run on the 3500-range, a local instance on the 3000-range, and a credential minted
 * against the other one points at a port nobody is listening on. The api-key
 * plaintext is unrecoverable once stored, so healing rewrites the address and
 * keeps the key.
 */
export async function ensureDevLoopKnowledgeCredential(options: {
  teamId: string;
  userId: string;
}): Promise<{ created: boolean; healed: boolean }> {
  const baseUrl = (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  const qb = getAutomationsQb(['external_service_credentials']);
  const existing = await qb
    .selectFrom('external_service_credentials')
    .where('team_id', '=', options.teamId as TeamId)
    .where('type', '=', ExternalServiceType.NATIVE_KNOWLEDGE)
    .where('name', '=', DEV_LOOP_KNOWLEDGE_CREDENTIAL_NAME)
    .select(['id', 'credentials'])
    .executeTakeFirst();

  if (existing) {
    const stored = JSON.parse(await decryptToken(existing.credentials as Buffer, existing.id)) as {
      baseUrl?: string;
    };
    if (stored.baseUrl === baseUrl) return { created: false, healed: false };
    await qb
      .updateTable('external_service_credentials')
      .set({
        credentials: await encryptToken(JSON.stringify({ ...stored, baseUrl }), existing.id),
      })
      .where('id', '=', existing.id)
      .execute();
    return { created: false, healed: true };
  }

  const provisioner = intrinsicProvisionerForType(ExternalServiceType.NATIVE_KNOWLEDGE);
  if (!provisioner) {
    throw new Error('No intrinsic provisioner for NATIVE_KNOWLEDGE — the dev loop has no graph.');
  }
  const { credentials } = await provisioner.provision({
    teamId: options.teamId as TeamId,
    userId: options.userId as UserId,
    credentialName: DEV_LOOP_KNOWLEDGE_CREDENTIAL_NAME,
    baseUrl,
  });
  await persistCredential({
    teamId: options.teamId as TeamId,
    userId: options.userId as UserId,
    name: DEV_LOOP_KNOWLEDGE_CREDENTIAL_NAME,
    type: ExternalServiceType.NATIVE_KNOWLEDGE,
    credentials,
  });
  return { created: true, healed: false };
}

export const WEB_BASE_URL = process.env.WEB_BASE_URL || 'http://localhost:3003';

/** The dev loop's public identity when the env has none. Same value as
 *  `apps/api/.env`, which is what the auth path actually reads. */
const DEV_PUBLIC_USER_ID = '40087837-1509-4eeb-935d-ce004ca4a5c7';

export interface SeedResult {
  teamId: string;
  userId: string;
  email: string;
  token: string;
  webBaseUrl: string;
  created: {
    team: boolean;
    user: boolean;
    ontology: boolean;
    pipelineConfig: boolean;
    attioCredentials: boolean;
    airtableCredentials: boolean;
    evertraceCredentials: boolean;
    dealroomCredentials: boolean;
    gmailCredentials: boolean;
    knowledgeCredential: boolean;
    remoteAdapter: boolean;
    currencies: boolean;
  };
}

/**
 * The PUBLIC_USER row the /api/public/* routes resolve every unauthenticated
 * request to. Core's first-boot step owns this now (`startup/core`) — the dev
 * loop calls the same code so the two can never drift.
 */
export async function ensurePublicUser(): Promise<void> {
  await ensurePublicIdentity(process.env.PUBLIC_USER_ID?.trim() || DEV_PUBLIC_USER_ID);
}

/**
 * Idempotently provision the dev-loop test team using the team id pinned in
 * TEST_HARNESS_TEAM_ID. Materialises the vc-dealflow ontology, creates a
 * pipeline configuration, and creates mock Attio credentials.
 *
 * The pinned id is what makes the fake-channels base-url injection trigger:
 * see lib/recording.ts isTestHarnessTeam.
 */
export async function ensureDevLoopTeam(): Promise<SeedResult> {
  const teamId = process.env.TEST_HARNESS_TEAM_ID;
  if (!teamId) {
    throw new Error(
      'TEST_HARNESS_TEAM_ID is not set. Add it to apps/api/.env or export it before running.',
    );
  }

  // Ensure the PUBLIC_USER row exists — /api/public/* routes require this
  await ensurePublicUser();

  const qb = getQb(['core.team', 'core.user', 'core.user_email', 'core.team_membership']);
  const created: SeedResult['created'] = {
    team: false,
    user: false,
    ontology: false,
    pipelineConfig: false,
    attioCredentials: false,
    airtableCredentials: false,
    evertraceCredentials: false,
    dealroomCredentials: false,
    gmailCredentials: false,
    knowledgeCredential: false,
    remoteAdapter: false,
    currencies: false,
  };

  // 1. Team
  const existingTeam = await qb
    .selectFrom('core.team as team')
    .where('id', '=', teamId as TeamId)
    .select('id')
    .executeTakeFirst();
  if (!existingTeam) {
    await qb
      .insertInto('core.team')
      .values({ id: teamId as TeamId, name: DEV_LOOP_TEAM_NAME })
      .execute();
    created.team = true;
  }
  // 2. User
  let userId: string;
  const existingUser = await qb
    .selectFrom('core.user as user')
    .where('default_team_id', '=', teamId as TeamId)
    .where('username', '=', DEV_LOOP_USERNAME)
    .select(['id'])
    .executeTakeFirst();
  if (existingUser) {
    userId = existingUser.id;
  } else {
    // A static-identity deployment sets LISTEN_FIRE_USER_ID at boot for attribution,
    // and that id has to be a user that EXISTS — so the seed accepts the same
    // pinned value rather than minting one nobody configured.
    userId = process.env.TEST_HARNESS_USER_ID ?? randomUUID();
    await qb
      .insertInto('core.user')
      .values({
        id: userId as UserId,
        default_team_id: teamId as TeamId,
        username: DEV_LOOP_USERNAME,
        granted_access_at: new Date(),
        is_platform_admin: true,
      } as any)
      .execute();
    created.user = true;
  }

  // 2a. User email + access grant — `unauthorisedGetUserByEmail` (the
  // cookie/bearer auth path) resolves a `user_email` row whose user has
  // `granted_access_at` set. Both must exist for the dev-loop account to
  // authenticate through the UI. Idempotent for users that pre-date this
  // step (the row used to be created only on first user insert, which
  // left older dev-loop users unable to log in).
  const existingEmail = await qb
    .selectFrom('core.user_email as user_email')
    .where('email', '=', DEV_LOOP_EMAIL)
    .select('id')
    .executeTakeFirst();
  if (!existingEmail) {
    await qb
      .insertInto('core.user_email')
      .values({
        id: randomUUID(),
        user_id: userId,
        email: DEV_LOOP_EMAIL,
        is_primary: true,
      } as any)
      .execute();
  }
  // Defensive: ensure the gate the auth lookup requires is set, even for
  // an older user row that was created without it.
  await qb
    .updateTable('core.user as user')
    .set({ granted_access_at: new Date() } as any)
    .where('id', '=', userId as UserId)
    .where('granted_access_at', 'is', null)
    .execute();

  // 2c. Team membership — flat access model. The dev-loop user is a platform
  // admin (authorises via is_platform_admin regardless), but a write
  // membership keeps the team-scoped path exercisable and mirrors what the
  // real onboarding flow produces. Idempotent on (user_id, team_id).
  const existingMembership = await qb
    .selectFrom('core.team_membership as team_membership')
    .where('user_id', '=', userId as UserId)
    .where('team_id', '=', teamId as TeamId)
    .select('id')
    .executeTakeFirst();
  if (!existingMembership) {
    await qb
      .insertInto('core.team_membership')
      .values({
        id: randomUUID(),
        user_id: userId,
        team_id: teamId,
        access: 'write',
      } as any)
      .execute();
  }

  // 3. Ontology — only materialise if no node types exist yet
  const existingNodeTypes = await getKnowledgeQb(['node_type'])
    .selectFrom('node_type')
    .where('team_id', '=', teamId as TeamId)
    .select('id')
    .limit(1)
    .execute();
  if (existingNodeTypes.length === 0) {
    const matQb = getKnowledgeQb([
      'node_type',
      'property_type',
      'edge_type',
      'extraction_graph',
      'extraction_graph_node',
      'extraction_graph_edge',
    ]);
    await (matQb as any).transaction().execute((trx: any) =>
      materializeTemplate(trx, teamId as TeamId, 'vc-dealflow'),
    );
    created.ontology = true;
  }

  // 4. Pipeline configuration
  const teamRow = await getCoreQb(['team'])
    .selectFrom('team')
    .where('id', '=', teamId as TeamId)
    .select('active_pipeline_configuration_id')
    .executeTakeFirst();
  if (!teamRow?.active_pipeline_configuration_id) {
    const configId = randomUUID() as PipelineConfigurationId;
    await getQb(['pipeline_configuration'])
      .insertInto('pipeline_configuration')
      .values({ id: configId, name: 'Dev Loop Configuration', team_id: teamId } as any)
      .execute();
    await getCoreQb(['team'])
      .updateTable('team')
      .set({ active_pipeline_configuration_id: configId })
      .where('id', '=', teamId as TeamId)
      .execute();
    created.pipelineConfig = true;
  }

  // 5. Mock Attio credentials — picks up fake-channels via injectFakeBaseUrl.
  // Check by NAME, not just type: the author-time connect-link flow can leave a
  // separate "Connect Link Attio" credential on the team, which would satisfy a
  // type-only check and leave the fixture's `dev_loop_attio` import unresolved
  // (it saves as a draft). Ensuring the specifically-named credential keeps the
  // built-in movement fixture provisionable regardless of other Attio creds.
  const existingCreds = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', teamId as TeamId)
    .where('type', '=', ExternalServiceType.ATTIO)
    .where('name', '=', 'Dev Loop Attio')
    .select('id')
    .executeTakeFirst();
  if (!existingCreds) {
    const credId = randomUUID() as ExternalServiceCredentialsId;
    const encrypted = await encryptToken(
      JSON.stringify({ accessToken: 'dev-loop-attio-token' }),
      credId,
    );
    await getAutomationsQb(['external_service_credentials'])
      .insertInto('external_service_credentials')
      .values({
        id: credId,
        name: 'Dev Loop Attio',
        type: ExternalServiceType.ATTIO,
        credentials: encrypted,
        team_id: teamId,
      } as any)
      .execute();
    created.attioCredentials = true;
  }

  // 6. Mock Airtable credentials — same pattern as Attio (fake-channels base
  // url is injected for the test-harness team via injectFakeBaseUrl). The
  // `dev_loop_airtable` movement import resolves to the row named
  // 'Dev Loop Airtable'. Far-future expiries so the client never tries to
  // refresh the stub token against the fake.
  const existingAirtableCreds = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', teamId as TeamId)
    .where('type', '=', ExternalServiceType.AIRTABLE)
    .where('name', '=', 'Dev Loop Airtable')
    .select('id')
    .executeTakeFirst();
  if (!existingAirtableCreds) {
    const credId = randomUUID() as ExternalServiceCredentialsId;
    const encrypted = await encryptToken(
      JSON.stringify({
        accessToken: 'dev-loop-airtable-token',
        refreshToken: 'dev-loop-airtable-refresh',
        accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
        refreshTokenExpiresAt: '2099-01-01T00:00:00.000Z',
      }),
      credId,
    );
    await getAutomationsQb(['external_service_credentials'])
      .insertInto('external_service_credentials')
      .values({
        id: credId,
        name: 'Dev Loop Airtable',
        type: ExternalServiceType.AIRTABLE,
        credentials: encrypted,
        team_id: teamId,
      } as any)
      .execute();
    created.airtableCredentials = true;
  }

  // 6b. Mock Evertrace credentials — same pasted-api-key pattern as Affinity
  // (fake-channels base url is injected for the test-harness team). The
  // `dev_loop_evertrace` movement import resolves to the row named
  // 'Dev Loop Evertrace'.
  const existingEvertraceCreds = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', teamId as TeamId)
    .where('type', '=', ExternalServiceType.EVERTRACE)
    .where('name', '=', 'Dev Loop Evertrace')
    .select('id')
    .executeTakeFirst();
  if (!existingEvertraceCreds) {
    const credId = randomUUID() as ExternalServiceCredentialsId;
    const encrypted = await encryptToken(JSON.stringify({ apiKey: 'dev-loop-evertrace-key' }), credId);
    await getAutomationsQb(['external_service_credentials'])
      .insertInto('external_service_credentials')
      .values({
        id: credId,
        name: 'Dev Loop Evertrace',
        type: ExternalServiceType.EVERTRACE,
        credentials: encrypted,
        team_id: teamId,
      } as any)
      .execute();
    created.evertraceCredentials = true;
  }

  // 6b-ii. Mock Dealroom credentials — same pasted-api-key pattern (the
  // fake-channels base url is injected for the test-harness team). The
  // `dev_loop_dealroom` movement import resolves to the row named
  // 'Dev Loop Dealroom'.
  const existingDealroomCreds = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', teamId as TeamId)
    .where('type', '=', ExternalServiceType.DEALROOM)
    .where('name', '=', 'Dev Loop Dealroom')
    .select('id')
    .executeTakeFirst();
  if (!existingDealroomCreds) {
    const credId = randomUUID() as ExternalServiceCredentialsId;
    const encrypted = await encryptToken(JSON.stringify({ apiKey: 'dev-loop-dealroom-key' }), credId);
    await getAutomationsQb(['external_service_credentials'])
      .insertInto('external_service_credentials')
      .values({
        id: credId,
        name: 'Dev Loop Dealroom',
        type: ExternalServiceType.DEALROOM,
        credentials: encrypted,
        team_id: teamId,
      } as any)
      .execute();
    created.dealroomCredentials = true;
  }

  // 6b-iii. The Gmail mailbox, in whichever shape this profile's connect method
  // mints (see ensureDevLoopGmailCredential).
  const gmail = await ensureDevLoopGmailCredential({ teamId: teamId as TeamId });
  created.gmailCredentials = gmail.created;

  // 6c. The knowledge-graph connection. Unconditional: the helper is
  // idempotent and re-seeding is how a credential left pointing at a dead
  // stack address gets healed.
  const knowledge = await ensureDevLoopKnowledgeCredential({ teamId, userId });
  created.knowledgeCredential = knowledge.created;

  // 7. The fake-CRM remote adapter, pointed at this profile's durable fixture.
  // Unconditional: it is an upsert, and re-running seed is how a row left
  // pointing at a dead URL gets healed.
  await ensureDevLoopRemoteAdapter({ teamId, userId });
  created.remoteAdapter = true;

  // 8. Currency reference data. CurrencyAsset rows are global (not
  // team-scoped), but a freshly provisioned DB has none, and any cash flow
  // through a real write path (a CASH consideration in addAcquisition,
  // distributions, sync-fx-rates) resolves through
  // CurrencyAsset.getByIsoCode/getOrCreate and throws `findFirstOrThrow`
  // without them. ensureAllCurrencies is the same helper the sync-fx-rates
  // job uses and is idempotent (getOrCreate creates only on a miss).
  await new CurrencyAsset(buildAgentContext(teamId, userId)).ensureAllCurrencies();
  created.currencies = true;

  const token = generateJWT(DEV_LOOP_EMAIL);

  return {
    teamId,
    userId,
    email: DEV_LOOP_EMAIL,
    token,
    webBaseUrl: WEB_BASE_URL,
    created,
  };
}

/**
 * Build a Context for direct agent invocation outside of HTTP. Mirrors the
 * setup the smoke tests use.
 */
export function buildAgentContext(teamId: string, userId: string): Context {
  const ctx = new Context();
  // The writable connection comes from the principal: a dev script has already
  // decided it may act, and `userPrincipal` defaults to write access.
  ctx.bindPrincipal(userPrincipal({ userId, teamId }));
  return ctx;
}

/** Idempotent mock credential of the given type (any secret works — the
 *  fake-channels base-url injection keys off credential TYPE + the
 *  test-harness team). Mirrors the whatsapp/granola setup helpers. */
export async function ensureCredential(input: {
  teamId: string;
  type: ExternalServiceType;
  name: string;
  secret: Record<string, string>;
}): Promise<void> {
  const existing = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', input.teamId as TeamId)
    .where('type', '=', input.type)
    .select('id')
    .executeTakeFirst();
  if (existing) return;
  const credId = randomUUID() as ExternalServiceCredentialsId;
  const encrypted = await encryptToken(JSON.stringify(input.secret), credId);
  await getAutomationsQb(['external_service_credentials'])
    .insertInto('external_service_credentials')
    .values({
      id: credId,
      name: input.name,
      type: input.type,
      credentials: encrypted,
      team_id: input.teamId,
      // Slack is two apps and a NULL app_id reads as the LEGACY one, which the
      // authoring surface hides — so omitting this mints a credential the
      // checker can't see. undefined for every other type.
      app_id: defaultAppIdForType(input.type),
    } as never)
    .execute();
}

/** `pnpm dev:telegram setup` provisions the same credential; a catalog capture
 *  needs it too, without the movements that command also saves. */
export async function ensureDevLoopTelegramCredential(teamId: string): Promise<void> {
  await ensureCredential({
    teamId,
    type: ExternalServiceType.TELEGRAM,
    name: 'Dev Loop Telegram',
    secret: { botToken: 'dev-loop-telegram-token' },
  });
}
