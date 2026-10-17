/**
 * Drive a MOVEMENT through the engine against a live fake-channels Affinity,
 * and print the requests the adapter made.
 *
 * The thing to see: the hop's WHERE names `host`, a value the movement bound a
 * line earlier. The engine closes the WHERE over that scope before the fetch,
 * so Affinity is asked for ONE `?term=veltha.ai` instead of paging a workspace
 * that is deliberately seeded past a page with the target LAST.
 *
 * The sibling `verify_affinity_pushdown.ts` drives the adapter directly, below
 * the engine, with the literal already in the predicate; this one proves the
 * author's own binding gets there.
 *
 * Usage (fake-channels running on a spare port):
 *   FAKE_CHANNELS_PORT=6199 pnpm --filter fake-channels start
 *   FAKE_BASE=http://localhost:6199 ts-node … verify_engine_pushdown.ts
 *
 * Needs DATABASE_URL: the production host's cross-run write locks are
 * Postgres advisory locks.
 */
import type { InstanceSchema } from 'movement-lang';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

import { AffinityAPIClient } from '../../adapters/affinity/apiClient';
import { runMovement } from 'movement-engine/services/movement_engine/run';
import { staticCatalogSnapshot } from '../../services/translation_graph/movement/catalog';
import { createManualAdapter } from '../../services/translation_graph/adapters/manual';
import { AffinityAdapter } from '../../services/translation_graph/adapters/affinity';
import { probeEngineHost } from './lib/probe_host';
import { tenantOfTeam } from '../../services/translation_graph/movement/tenant';

const HOST = process.env.FAKE_BASE ?? 'http://localhost:6199';
const TEAM_ID = '00000000-0000-0000-0000-000000000099' as TeamId;

/** Past the fake's 500-row page, with the target the very last row — so a
 *  workspace walk needs two pages and a pushed term needs none. */
const WORKSPACE_SIZE = 600;
const TARGET = { name: 'Veltha', domain: 'veltha.ai' };

const requests: string[] = [];
const realFetch = global.fetch;
global.fetch = (async (
  input: Parameters<typeof realFetch>[0],
  init?: Parameters<typeof realFetch>[1],
) => {
  requests.push(String(input));
  return realFetch(input, init);
}) as typeof fetch;

async function seedWorkspace(): Promise<void> {
  const existing = (await (await realFetch(`${HOST}/admin/affinity/organization/state`)).json()) as
    | Array<{ domain?: string }>
    | undefined;
  if (existing && existing.length >= WORKSPACE_SIZE) return;
  const entities = [
    ...Array.from({ length: WORKSPACE_SIZE - 1 }, (_, i) => ({
      entity_type: 'organization',
      data: { name: `Filler ${i}`, domain: `filler-${i}.example` },
    })),
    { entity_type: 'organization', data: TARGET },
  ];
  await realFetch(`${HOST}/admin/affinity/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entities }),
  });
}

/** A thin catalog schema for the constructed Affinity instance — enough for the
 *  checker; the adapter resolves the real names itself at fetch time. */
const affinitySchema: InstanceSchema = {
  positions: {
    Organization: { properties: { Name: 'text', Domain: 'text' }, edges: {} },
  },
  collections: { Organization: { target: 'Organization' } },
  writableRoots: {},
};

function affinityOnFake(): AffinityAdapter {
  const adapter = new AffinityAdapter({
    teamId: TEAM_ID,
    credentialsId: 'creds-verify' as ExternalServiceCredentialsId,
  });
  const client = new AffinityAPIClient({ apiKey: 'fake', baseUrl: `${HOST}/affinity` });
  Object.assign(adapter, { getApiClient: async () => client });
  return adapter;
}

function movementSource(body: string): string {
  return `import { manual, affinity } from adapters
import { affinity_cred } from credentials
runs = connect manual
crm = connect affinity using affinity_cred
function lookup(go: <runs-[:Invocation]->>) {
${body}
}
listen to runs {} fire lookup
`;
}

/** The hop names `host`, a value bound a line earlier — the shape production
 *  writes, and the one that used to reach the adapter unresolved. */
const BOUND_NAME = `  host = "${TARGET.domain}"
  found = first(crm-[o:Organization WHERE o.\`Domain\` == host ORDER BY o.\`Name\`]->)
  if (found == null) { fail("no organization matched") }`;

/** The control: nothing to narrow by, so the walk pages the workspace. */
const NO_WHERE = `  found = first(crm-[o:Organization ORDER BY o.\`Name\`]->)
  if (found == null) { fail("no organization matched") }`;

function manualEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:verify-pushdown',
    adapterType: 'manual',
    triggerType: 'webhook',
    payload: { firedAt: new Date().toISOString() },
    occurredAt: new Date().toISOString(),
  };
}

async function run(label: string, body: string): Promise<void> {
  const affinity = affinityOnFake();
  const manual = createManualAdapter({ teamId: TEAM_ID });
  requests.length = 0;
  await runMovement({
    source: movementSource(body),
    event: manualEvent(),
    teamId: tenantOfTeam(TEAM_ID),
    catalog: staticCatalogSnapshot({
      credentials: { affinity_cred: { adapters: ['affinity'] } },
      instanceSchemas: { affinity: affinitySchema },
    }),
    credentialIds: { affinity_cred: 'creds-verify' },
    host: probeEngineHost({
      teamId: TEAM_ID,
      resolve: ({ adapterType }) => (adapterType === 'affinity' ? affinity : manual),
    }),
    dryRun: true,
  });

  // The collection scan only — a `/organizations/{id}` record read is the
  // engine reading a field off the one it landed on, not part of the fetch.
  const scans = requests.filter((u) => /\/organizations\?/.test(u));
  console.log(`\n── ${label}`);
  console.log(`   collection scans: ${scans.length}`);
  for (const u of scans) console.log(`     ${u}`);
  console.log('   the run completed, so the walk found it (the miss path ERRORs)');
}

async function main() {
  await seedWorkspace();
  console.log(`workspace: ${WORKSPACE_SIZE} organizations, '${TARGET.name}' last`);
  await run('WHERE `Domain` == host — the bound name reaches the term search', BOUND_NAME);
  await run('no WHERE — the workspace walk, a page at a time', NO_WHERE);
  process.exit(0);
}

void main();
