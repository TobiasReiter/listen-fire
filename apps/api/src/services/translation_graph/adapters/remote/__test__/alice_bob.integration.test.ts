// Henry's acceptance for provider credentials per connection, on the
// platform: a HubSpot-like REMOTE module (served as its own process by
// serve-module, reached over protocol 2 like any separately run server), ONE
// install holding the module's server secret and the host's OAuth app, and
// two user credentials. A saved movement listens as Alice and writes as Bob.
// Nothing is mocked: the team catalog introspects the module over the wire,
// the dispatch path fires the movement on the engine, and every call reaches
// the module signed with the install's secret and carrying the connection's
// credential. Each user creates their credential as a member does, signing in
// at the provider through the install's OAuth app (the settings route's begin
// and callback). Alice's token has expired: the host refreshes it with its
// OAuth app and writes the rotated tokens back to Alice's row, and only hers.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

jest.mock('../../../../credentials/credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));

import { CURRENT_LANGUAGE_VERSION } from 'movement-lang';
import { postRpc } from 'movement-engine/services/translation_graph/protocol/client';
import { triggerEventOf } from 'movement-engine/services/translation_graph/triggers/trigger_event';

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../../../../generated/kysely/automations/Movement';
import type { PipelineConfigurationId } from '../../../../../generated/kysely/public/PipelineConfiguration';
import type { ExternalServiceCredentialsId } from '../../../../../generated/kysely/automations/ExternalServiceCredentials';

import { getAutomationsQb, getCoreQb, getQb } from '../../../../../lib/kysely';
import { decryptToken } from '../../../../../lib/credentials';
import { cleanupTeam } from '../../../../../test/harness/cleanup';
import { beginRemoteModuleSignIn, completeRemoteModuleSignIn } from '../../../../credentials/remote_module_connect';
import { installRemoteAdapterFromManifest } from '../install';
import { RemoteAdapterManifestInput } from '../manifest';
import { dispatchTriggerByIdEvent } from '../../../triggers/router';
import { mintMovementVersionIfChanged } from '../../../movement/version_store';
import { startFakeHubSpot, type FakeHubSpot } from '../../../../../../../cli/src/__test__/hubspot/fake_hubspot';

const MODULE = resolve(__dirname, '../../../../../../../cli/src/__test__/hubspot/module.ts');
const SERVE_MODULE = resolve(__dirname, '../../../../../../../../packages/module-kit/bin/serve-module.cjs');
const SERVER_SECRET = `install-${randomUUID()}`;
const CLIENT = { clientId: 'listen-fire-app', clientSecret: 'listen-fire-app-secret' };

const MIRROR = `import { hubspot } from adapters
import { alice_hubspot, bob_hubspot } from credentials

hs_alice = connect hubspot using alice_hubspot
hs_bob = connect hubspot using bob_hubspot

function mirror(deal: <hs_alice-[:Deal]->>) {
  write hs_bob-[:Deal]-> { Name: "Mirror of \${deal.Name}" }
}

listen to hs_alice { events: ["deal.created"] } fire mirror
`;

let fake: FakeHubSpot;
let server: ChildProcess;
let baseUrl: string;
let teamId: TeamId;
let alice: string;
let bob: string;

async function serveModule(): Promise<string> {
  server = spawn(process.execPath, [SERVE_MODULE, MODULE], {
    env: { PATH: process.env.PATH ?? '', PORT: '0', MODULE_TOKEN: SERVER_SECRET, MODULE_BASE_URL_OVERRIDE: fake.base, HUBSPOT_PROVIDER_URL: fake.base },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: server.stdout! });
  const port = await new Promise<number>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('serve-module did not listen within 20s')), 20_000);
    lines.on('line', (line) => {
      const match = /^listening (\d+)/.exec(line);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        done(Number(match[1]));
      }
    });
  });
  return `http://127.0.0.1:${port}/`;
}

/** A member's sign-in, as the settings route runs it: begin, the provider's
 *  consent sending its code back, and the callback completing it. */
async function signInAs(input: { user: string; name: string; expired?: boolean }): Promise<string> {
  const { url } = await beginRemoteModuleSignIn({
    teamId,
    userId: null,
    adapterType: 'hubspot',
    declaredCredential: 'oauth',
    name: input.name,
  });
  const state = new URL(url).searchParams.get('state') ?? '';
  const code = fake.authorize(input.user, { expired: input.expired === true });
  return (await completeRemoteModuleSignIn({ state, code })).credentialsId;
}

async function credentialFields(id: string): Promise<Record<string, string>> {
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', id as ExternalServiceCredentialsId)
    .select(['id', 'credentials'])
    .executeTakeFirstOrThrow();
  return JSON.parse(await decryptToken(row.credentials, row.id)) as Record<string, string>;
}

async function seedMirror(): Promise<{ triggerId: TriggerId; movementId: MovementId }> {
  const pipelineConfigurationId = randomUUID() as PipelineConfigurationId;
  await getQb(['pipeline_configuration'])
    .insertInto('pipeline_configuration')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: pipelineConfigurationId, team_id: teamId, name: `cfg-${pipelineConfigurationId.slice(0, 8)}` } as any)
    .execute();
  const movementId = randomUUID() as MovementId;
  await getAutomationsQb(['movement'])
    .insertInto('movement')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: movementId, team_id: teamId, name: 'Mirror deals', source: MIRROR, language_version: CURRENT_LANGUAGE_VERSION } as any)
    .execute();
  await mintMovementVersionIfChanged({ teamId, movementId, source: MIRROR, languageVersion: CURRENT_LANGUAGE_VERSION });
  const triggerId = randomUUID() as TriggerId;
  await getAutomationsQb(['trigger'])
    .insertInto('trigger')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({
      id: triggerId,
      team_id: teamId,
      pipeline_configuration_id: pipelineConfigurationId,
      name: 'Alice’s new deals',
      kind: 'hubspot',
      config: JSON.stringify({ events: ['deal.created'] }),
      movement_id: movementId,
      fired_movement_name: 'mirror',
    } as any)
    .execute();
  return { triggerId, movementId };
}

beforeAll(async () => {
  fake = await startFakeHubSpot(CLIENT);
  baseUrl = await serveModule();
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `alice-bob-${teamId.slice(0, 8)}` } as any)
    .execute();

  // One install: the module's own manifest answer, its server secret and the
  // host's OAuth app for its declared `oauth` credential.
  const answer = await postRpc({
    baseUrl,
    auth: { authorization: `Bearer ${SERVER_SECRET}` },
    teamId,
    method: 'manifest',
    cacheScopeId: '<none>',
    params: {},
  });
  const manifest = RemoteAdapterManifestInput.parse({ ...(answer as object), baseUrl, authStrategy: { kind: 'bearer' } });
  await installRemoteAdapterFromManifest({ teamId, manifest, secret: SERVER_SECRET, oauthClients: { oauth: CLIENT } });

  // Two users' credentials for it, each signed in at the provider.
  alice = await signInAs({ user: 'alice', name: 'alice_hubspot', expired: true });
  bob = await signInAs({ user: 'bob', name: 'bob_hubspot' });
}, 60_000);

afterAll(async () => {
  await cleanupTeam(teamId);
  server.kill();
  await fake.close();
});

it('reads as Alice and writes as Bob through one install; Alice’s rotated token is written back to her row', async () => {
  const bobBefore = await credentialFields(bob);
  const aliceBefore = await credentialFields(alice);
  fake.deals.push({ id: 'deal-1', Name: 'Acme expansion', owner: 'alice' });
  const { triggerId } = await seedMirror();

  const { triggerEvent } = triggerEventOf({
    pipelineInputId: `trigger:${triggerId}`,
    adapterType: 'hubspot',
    triggerType: 'webhook',
    event: { payload: { id: 'deal-1', Name: 'Acme expansion' }, externalId: 'deal-1', tag: 'deal.created', eventType: 'deal.created', changeType: 'create', recordType: 'Deal' },
    eventTypes: [{ tag: 'deal.created', positionType: 'Deal' }],
    now: new Date(),
  });
  const result = await dispatchTriggerByIdEvent({ triggerId, teamId, event: triggerEvent });

  expect(result.movementFirings).toEqual([{ movementName: 'mirror', writes: 1, dryRun: false }]);
  expect(fake.calls.filter((c) => c.as !== undefined).map((c) => `${c.method} ${c.path} as ${c.as}`)).toEqual([
    'GET /deals/deal-1 as alice',
    'POST /deals as bob',
  ]);
  expect(fake.deals.map((d) => `${d.Name} (${d.owner})`)).toEqual(['Acme expansion (alice)', 'Mirror of Acme expansion (bob)']);
  // The host refreshed Alice's expired token once, with its OAuth app.
  expect(fake.refreshes).toEqual(['alice']);

  const aliceAfter = await credentialFields(alice);
  expect(aliceAfter.refresh_token).toBe(fake.refreshTokenOf('alice'));
  expect(aliceAfter.access_token).not.toBe(aliceBefore.access_token);
  expect(await credentialFields(bob)).toEqual(bobBefore);
}, 120_000);
