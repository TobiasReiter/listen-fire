/**
 * The per-run Affinity call ceiling, end to end against a live fake Affinity.
 *
 * Three things to see:
 *   1. a run held to a ceiling of 2 stops at its third call, and fails with a
 *      message that names the count, the setting, and why it stopped;
 *   2. the same run under the default (2000) finishes and reads normally —
 *      the safeguard costs an honest run nothing;
 *   3. the same calls made OUTSIDE a run (a script, a describe, a catalog
 *      refresh) are not counted at all and never fail.
 *
 * `AFFINITY_MAX_CALLS_PER_RUN` is read from the environment of whatever
 * process makes the call, and this script IS that process — the engine runs
 * in-process here, exactly as it does inside the API — so each leg sets the
 * variable itself rather than needing the stack booted with it.
 *
 * Usage:
 *   FAKE_CHANNELS_PORT=6293 pnpm --filter fake-channels start   # or the dev loop
 *   FAKE_BASE=http://localhost:6293/affinity npx tsx apps/api/src/scripts/dev/verify_affinity_call_ceiling.ts
 *
 * Needs DATABASE_URL: the production host's cross-run write locks are
 * Postgres advisory locks.
 */
import type { CatalogSnapshot } from 'movement-lang';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

import { runMovement } from 'movement-engine/public/movement-engine';
import { AffinityAPIClient } from '@listen-fire/affinity/api_client';
import { AffinityAdapter, AFFINITY_MANIFEST } from '@listen-fire/affinity';
import { hostedModels } from '../../services/translation_graph/adapters/module_host';
import { platformModuleFiles } from '../../services/translation_graph/engine/files/module_files';
import { instanceSchemaFromDescriptors } from 'movement-engine/public/catalog';
import { makeMetaPosition } from 'movement-engine/public/catalog';
import { everyCredential, probeEngineHost } from './lib/probe_host';
import { tenantOfTeam } from '../../services/translation_graph/movement/tenant';

const BASE = process.env.FAKE_BASE ?? 'http://localhost:6293/affinity';
const TEAM_ID = '00000000-0000-0000-0000-000000000011' as TeamId;
const ENV_VAR = 'AFFINITY_MAX_CALLS_PER_RUN';

const requests: string[] = [];

function adapterOnFake(): AffinityAdapter {
  const adapter = new AffinityAdapter({
    tenant: TEAM_ID,
    client: async () => {
      throw new Error('this script supplies its own client');
    },
    models: hostedModels,
    files: platformModuleFiles({ teamId: TEAM_ID, module: '@lf/affinity' }),
    fetch,
  });
  // A client of its own per adapter, so the counting chokepoint is the real
  // one but the fixture's calls stay separable from the run's.
  const client = new AffinityAPIClient({ apiKey: 'fake', baseUrl: BASE });
  const send = client.fetch.bind(client);
  Object.assign(client, {
    fetch: async (args: { route: string; method: string; query?: Record<string, string> }) => {
      const query = args.query ? `?${new URLSearchParams(args.query).toString()}` : '';
      requests.push(`${args.method} ${args.route}${query}`);
      return send(args as Parameters<typeof send>[0]);
    },
  });
  Object.assign(adapter, {
    getApiClient: async () => {
      Object.assign(adapter, { web: { getWebBaseUrl: async () => 'https://fake.affinity.co' } });
      return client;
    },
  });
  return adapter;
}

async function snapshot(adapter: AffinityAdapter): Promise<CatalogSnapshot> {
  const entries = await adapter.listEntryPoints();
  const descriptors = new Map(
    (
      await Promise.all(
        entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const),
      )
    ).flatMap(([typeId, d]) => (d ? [[typeId, d] as const] : [])),
  );
  const { schema } = instanceSchemaFromDescriptors({
    adapterType: 'affinity',
    entries,
    descriptors,
    supportsInPlaceUpdate: true,
  });
  return {
    adapters: {
      affinity: {
        constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
        canFire: true,
        triggerConfig: ['events'],
        triggerConfigOptions: { events: [...(AFFINITY_MANIFEST.subscribableEvents ?? [])] },
        schemas: { affinity_creds: schema },
      },
    },
    credentials: { affinity_creds: { adapters: ['affinity'] } },
    plugins: {},
  };
}

/** A read that costs several calls: the workspace's organizations, then each
 *  one's rows. Nothing is written. */
const SWEEP = `import { affinity } from adapters
import { affinity_creds } from credentials

crm = connect affinity using affinity_creds

function sweep(e: <crm-[:\`Organization\`]->>) {
  crm-[org:\`Organization\`]-> {
    org-[le:\`List Entries\`]-> { }
  }
}`;

const event = {
  pipelineInputId: 'pi-verify',
  adapterType: 'affinity',
  triggerType: 'webhook' as const,
  payload: {},
};

async function sweep(
  adapter: AffinityAdapter,
  catalog: CatalogSnapshot,
): Promise<{ calls: number; failure?: string }> {
  const mark = requests.length;
  try {
    await runMovement({
      source: SWEEP,
      movementName: 'sweep',
      event,
      teamId: tenantOfTeam(TEAM_ID),
      catalog,
      credentialIds: everyCredential(catalog, 'creds-verify'),
      host: probeEngineHost({
        teamId: TEAM_ID,
        resolve: () => adapter,
      }),
    });
    return { calls: requests.length - mark };
  } catch (err) {
    return {
      calls: requests.length - mark,
      failure: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Enough companies that a sweep of the workspace costs more than a couple of
 *  calls — a ceiling only means anything against a read that walks. */
async function seedCompanies(): Promise<number> {
  const auth = 'Basic ' + Buffer.from(':fake').toString('base64');
  const existing = (await (
    await fetch(`${BASE}/organizations?page_size=500`, { headers: { Authorization: auth } })
  ).json()) as { organizations: unknown[] };
  for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta']) {
    if (existing.organizations.length >= 5) break;
    await fetch(`${BASE}/organizations`, {
      method: 'POST',
      headers: { Authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `${name} Labs`, domain: `${name.toLowerCase()}labs.test` }),
    });
  }
  const after = (await (
    await fetch(`${BASE}/organizations?page_size=500`, { headers: { Authorization: auth } })
  ).json()) as { organizations: unknown[] };
  return after.organizations.length;
}

async function main() {
  console.log(`\n── the fake workspace holds ${await seedCompanies()} companies`);
  const adapter = adapterOnFake();
  const catalog = await snapshot(adapter);

  console.log('\n── the run, held to a ceiling of 2');
  process.env[ENV_VAR] = '2';
  const capped = await sweep(adapter, catalog);
  // One more than the ceiling: the last one is where it stopped, and that one
  // never reached Affinity.
  console.log(`   calls issued before it stopped: ${capped.calls}`);
  console.log(`   failure reason: ${capped.failure ?? '(none — it finished!)'}`);

  console.log('\n── the same run under the default ceiling');
  delete process.env[ENV_VAR];
  const normal = await sweep(adapter, catalog);
  console.log(`   calls: ${normal.calls}`);
  console.log(`   failure reason: ${normal.failure ?? '(none — it finished)'}`);

  console.log('\n── the same calls outside any run, still held to a ceiling of 2');
  process.env[ENV_VAR] = '2';
  const mark = requests.length;
  let outside = 'no failure';
  try {
    for (let i = 0; i < 4; i++) {
      await adapter.getRelated({
        position: makeMetaPosition('affinity'),
        fieldId: 'Organization',
        direction: 'outgoing',
      });
    }
  } catch (err) {
    outside = err instanceof Error ? err.message : String(err);
  }
  console.log(`   calls: ${requests.length - mark}`);
  console.log(`   result: ${outside}`);

  process.exit(0);
}

void main();
