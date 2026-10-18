/**
 * Rehearse the mission's write through the real movement engine against a live
 * fake Affinity, and show what the rehearsal reports.
 *
 * The acceptance: adding a company to a list, with the list's own fields set,
 * and an `Owners` edge off the entry — all of it captured, none of it sent, and
 * the trace showing WHICH organization the entry was added to and which
 * entry the owner landed on.
 *
 * Three things to see:
 *   1. every field of the entry write appears in the capture;
 *   2. the entry capture names the organization it hangs off, and the edge;
 *   3. the `Owners` write off the entry is its own capture, naming the entry as
 *      its parent — and marked `rehearsed`, because that entry does not exist.
 *
 * Usage: FAKE_BASE=http://localhost:6291/affinity ts-node … verify_affinity_dry_run_entry.ts
 *
 * Needs DATABASE_URL: the production host's cross-run write locks are
 * Postgres advisory locks.
 */
import { checkProgram, fromCatalogSnapshot, parseProgram, type CatalogSnapshot } from 'movement-lang';

import type { CapturedWrite } from 'movement-engine/public/adapter';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

import { runMovement } from 'movement-engine/public/movement-engine';
import { AffinityAPIClient } from '@listen-fire/affinity/api_client';
import { AffinityAdapter } from '@listen-fire/affinity';
import { hostedModels } from '../../services/translation_graph/adapters/module_host';
import { platformModuleFiles } from '../../services/translation_graph/engine/files/module_files';
import { AFFINITY_MANIFEST } from '@listen-fire/affinity';
import { instanceSchemaFromDescriptors } from 'movement-engine/public/catalog';
import { everyCredential, probeEngineHost } from './lib/probe_host';
import { tenantOfTeam } from '../../services/translation_graph/movement/tenant';

const BASE = process.env.FAKE_BASE ?? 'http://localhost:6291/affinity';
const TEAM_ID = '00000000-0000-0000-0000-000000000010' as TeamId;

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
  const client = new AffinityAPIClient({ apiKey: 'fake', baseUrl: BASE });
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

const SOURCE = `import { affinity } from adapters
import { affinity_creds } from credentials

crm = connect affinity using affinity_creds

function sync(e: <crm-[:\`Organization\`]->>) {
  crm-[org:\`Organization\` WHERE org.\`Domain\` == "graphredesign.co"]-> {
    write org-[:\`List Entries\`]-> {
      listName: "Pipeline",
      \`Deal Stage\`: "Sourced",
      \`Deal Size\`: 5000000,
      \`Next Step\`: "Partner call"
    }
  }
  fresh = write crm-[:\`Organization\`]-> { Name: "Rehearsal Co", Domain: "rehearsal.example" }
  write fresh-[:\`List Entries\`]-> {
    listName: "Pipeline",
    \`Deal Stage\`: "Screening",
    \`Next Step\`: "Intro call"
  }
}`;

/** The mission's other half — an `Owners` edge off the entry — as the checker
 *  sees it. The edge lives on the LIST's own type, and a write handle's type is
 *  the membership collection: the checker narrows a discriminated write's BODY
 *  to the variant but not the handle it hands back. Printed rather than run, so
 *  the blocker is visible with its own words. */
const OWNERS_SOURCE = `import { affinity } from adapters
import { affinity_creds } from credentials

crm = connect affinity using affinity_creds

function sync(e: <crm-[:\`Organization\`]->>) {
  crm-[org:\`Organization\` WHERE org.\`Domain\` == "graphredesign.co"]-> {
    entry = write org-[:\`List Entries\`]-> { listName: "Pipeline", \`Deal Stage\`: "Sourced" }
    write entry-[:\`Owners\`]-> { \`First name\`: "Olivia", \`Last name\`: "Owner", Email: "o@example.com" }
  }
}`;

function show(write: CapturedWrite): string {
  const parents = (write.parents ?? [])
    .map((p) => `${p.recordType} ${p.externalId}${p.rehearsed ? ' (rehearsed)' : ''} via ${p.edgeName}`)
    .join(', ');
  const fields = Object.entries(write.fields ?? {})
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(', ');
  return [
    `   ${write.kind} ${write.recordType}`,
    parents ? `      on: ${parents}` : `      on: (nothing — a root write)`,
    `      fields: ${fields || '(none)'}`,
  ].join('\n');
}

async function main() {
  const adapter = adapterOnFake();
  const snap = await snapshot(adapter);

  const captured: CapturedWrite[] = [];
  const result = await runMovement({
    source: SOURCE,
    movementName: 'sync',
    event: {
      pipelineInputId: 'pi-verify',
      adapterType: 'affinity',
      triggerType: 'webhook',
      payload: {},
    },
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

  console.log('\n── what the rehearsal captured');
  for (const write of captured) console.log(show(write));

  console.log('\n── the `Owners` edge off the entry, at the checker');
  for (const d of checkProgram(parseProgram(OWNERS_SOURCE), fromCatalogSnapshot(snap)).filter(
    (d) => (d.severity ?? 'error') === 'error',
  )) {
    console.log(`   ${d.code}: ${d.message}`);
  }

  console.log('\n── what the run recorded');
  for (const write of result.writes) {
    console.log(
      `   ${write.recordType} committed=${write.committed} parents=${JSON.stringify(write.parents ?? [])}`,
    );
    console.log(`      values: ${JSON.stringify(write.writtenValues)}`);
  }
  process.exit(0);
}

void main();
