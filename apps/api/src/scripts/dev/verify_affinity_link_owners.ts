/**
 * The mission's acceptance, end to end against a live fake Affinity: add a
 * company to a list with all of that list's fields set, then attach the people
 * who own it by walking a list of names and linking each one.
 *
 * Four things to see:
 *   1. the whole program CHECKS — `Owners` is reachable off the entry handle,
 *      because a write that named a list stands on that list's own type;
 *   2. rehearsed, both links are captured and neither is sent;
 *   3. run for real, both owners read back off the entry under the name the
 *      list publishes — one field value each, hung on the entry and addressed
 *      against the company;
 *   4. `unlink` takes one back off, and the other survives.
 *
 * The names go through Affinity's own person matcher, which asks a model to
 * strip affixes before it searches — so this leg needs a model key, exactly as
 * a real run of the same program does.
 *
 * Usage: FAKE_BASE=http://localhost:6291/affinity ts-node … verify_affinity_link_owners.ts
 *
 * Needs DATABASE_URL: the production host's cross-run write locks are
 * Postgres advisory locks.
 */
import { checkProgram, fromCatalogSnapshot, parseProgram, type CatalogSnapshot } from 'movement-lang';

import type { CapturedWrite } from 'movement-engine/services/translation_graph/engine/dry_run_adapter';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

import { runMovement } from 'movement-engine/services/movement_engine/run';
import { AffinityAPIClient } from '../../adapters/affinity/apiClient';
import { AffinityAdapter, AFFINITY_MANIFEST } from '../../services/translation_graph/adapters/affinity';
import { instanceSchemaFromDescriptors } from 'movement-engine/services/translation_graph/movement/schema_projection';
import { everyCredential, probeEngineHost } from './lib/probe_host';
import { tenantOfTeam } from '../../services/translation_graph/movement/tenant';

const BASE = process.env.FAKE_BASE ?? 'http://localhost:6291/affinity';
const TEAM_ID = '00000000-0000-0000-0000-000000000011' as TeamId;

const requests: string[] = [];

function adapterOnFake(): AffinityAdapter {
  const adapter = new AffinityAdapter({
    teamId: TEAM_ID,
    credentialsId: 'creds-verify' as ExternalServiceCredentialsId,
  });
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

const HEAD = `import { affinity } from adapters
import { affinity_creds } from credentials

crm = affinity(credentials: affinity_creds)
`;

/** The acceptance: the library's write with every field, then the owners
 *  attached by walking the names — no name enumerated in the program. */
const ADD_AND_OWN = `${HEAD}
movement sync(e: <crm-[:\`Organization\`]->>) {
  d = node { owners: [node { name: "Grace Graph" }, node { name: "Ivan Internal" }] }
  crm-[org:\`Organization\` WHERE \`Domain\` == "graphredesign.co"]-> {
    entry = write org-[:\`List Entries\`]-> {
      listName: "Pipeline",
      \`Deal Stage\`: "Sourced",
      \`Deal Size\`: 5000000,
      \`Next Step\`: "Partner call"
    }
    d-[o:owners]-> {
      owner = match entry-[:\`Owners\`]-> { \`Full name\`: o.name }
      link entry -[:\`Owners\`]-> owner
    }
  }
}`;

/** Taking one back off: the handle `match` binds is what `unlink` severs. */
const DROP_ONE = `${HEAD}
movement sync(e: <crm-[:\`Organization\`]->>) {
  crm-[org:\`Organization\` WHERE \`Domain\` == "graphredesign.co"]-> {
    entry = write org-[:\`List Entries\`]-> { listName: "Pipeline", \`Next Step\`: "Partner call" }
    leaving = match entry-[:\`Owners\`]-> { \`Full name\`: "Ivan Internal" }
    unlink entry -[:\`Owners\`]-> leaving
  }
}`;

function show(write: CapturedWrite): string {
  const parents = (write.parents ?? [])
    .map((p) => `${p.recordType} ${p.externalId}${p.rehearsed ? ' (rehearsed)' : ''} via ${p.edgeName}`)
    .join(', ');
  const fields = Object.entries(write.fields ?? {})
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(', ');
  const link = write.link
    ? `      edge: ${write.recordType} ${write.externalId} -[:${write.link.edgeName}]-> ${write.link.toRecordType} ${write.link.toExternalId}`
    : undefined;
  return [
    `   ${write.kind} ${write.recordType}`,
    link ?? (parents ? `      on: ${parents}` : `      on: (nothing — a root write)`),
    ...(write.link ? [] : [`      fields: ${fields || '(none)'}`]),
  ].join('\n');
}

const event = {
  pipelineInputId: 'pi-verify',
  adapterType: 'affinity',
  triggerType: 'webhook' as const,
  payload: {},
};

async function main() {
  const adapter = adapterOnFake();
  const snap = await snapshot(adapter);
  const catalog = fromCatalogSnapshot(snap);

  console.log('\n── the acceptance program, at the checker');
  const errors = checkProgram(parseProgram(ADD_AND_OWN), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
  for (const d of errors) console.log(`   ${d.code}: ${d.message}`);
  if (errors.length === 0) console.log('   clean');

  console.log('\n── rehearsed');
  const captured: CapturedWrite[] = [];
  const mark = requests.length;
  await runMovement({
    source: ADD_AND_OWN,
    movementName: 'sync',
    event,
    teamId: tenantOfTeam(TEAM_ID),
    catalog: snap,
    credentialIds: everyCredential(snap, 'creds-verify'),
    host: probeEngineHost({
      teamId: TEAM_ID,
      resolve: () => adapter,
      writeSink: (w) => captured.push(w),
    }),
    dryRun: true,
  });
  for (const write of captured) console.log(show(write));
  const sent = requests
    .slice(mark)
    .filter((r) => r.startsWith('POST') || r.startsWith('PUT') || r.startsWith('DELETE'));
  console.log(`   wrote to Affinity: ${sent.length === 0 ? 'nothing' : sent.join(', ')}`);

  console.log('\n── for real');
  const live = await runMovement({
    source: ADD_AND_OWN,
    movementName: 'sync',
    event,
    teamId: tenantOfTeam(TEAM_ID),
    catalog: snap,
    credentialIds: everyCredential(snap, 'creds-verify'),
    host: probeEngineHost({
      teamId: TEAM_ID,
      resolve: () => adapter,
    }),
  });
  for (const write of live.writes) {
    console.log(
      `   ${write.kind ?? 'write'} ${write.recordType} ${write.externalId ?? ''} ${
        write.link ? `-[:${write.link.edgeName}]-> ${write.link.toRecordType} ${write.link.toExternalId}` : ''
      }`,
    );
  }
  const entryId = live.writes.find((w) => w.recordType.includes('List Entry'))?.externalId;
  console.log(`   entry ${entryId} reads back: ${JSON.stringify(
    await adapter.readRecord({ recordType: 'List Entry — Pipeline', externalId: String(entryId) }),
  )}`);

  console.log('\n── one owner leaves');
  const dropped = await runMovement({
    source: DROP_ONE,
    movementName: 'sync',
    event,
    teamId: tenantOfTeam(TEAM_ID),
    catalog: snap,
    credentialIds: everyCredential(snap, 'creds-verify'),
    host: probeEngineHost({
      teamId: TEAM_ID,
      resolve: () => adapter,
    }),
  });
  for (const write of dropped.writes) {
    console.log(
      `   ${write.kind ?? 'write'} ${write.recordType} ${write.externalId ?? ''} ${
        write.link ? `-[:${write.link.edgeName}]-> ${write.link.toExternalId}` : ''
      }`,
    );
  }
  console.log(`   entry ${entryId} reads back: ${JSON.stringify(
    await adapter.readRecord({ recordType: 'List Entry — Pipeline', externalId: String(entryId) }),
  )}`);
  process.exit(0);
}

void main();
