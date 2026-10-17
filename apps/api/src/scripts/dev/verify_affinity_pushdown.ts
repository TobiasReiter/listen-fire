/**
 * Drive the Affinity adapter's ROOT READ against a live fake-channels server
 * over real HTTP, and print the requests it made.
 *
 * Two things to see: a narrowed read (`WHERE Domain == "veltha.ai"`) asks
 * Affinity for that domain with ONE `?term=` call, and an unnarrowed read
 * walks every page of the workspace.
 *
 * Usage: FAKE_BASE=http://localhost:6199/affinity ts-node … verify_affinity_pushdown.ts
 */
import type { TeamId } from '../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';
import type { Expression } from '#shared/expression/types';

import { AffinityAPIClient } from '@listen-fire/affinity/api_client';
import { AffinityAdapter } from '@listen-fire/affinity';
import { hostedModels } from '../../services/translation_graph/adapters/module_host';
import { platformModuleFiles } from '../../services/translation_graph/engine/files/module_files';
import { makeMetaPosition } from 'movement-engine/services/translation_graph/types';

const BASE = process.env.FAKE_BASE ?? 'http://localhost:6199/affinity';

const requests: string[] = [];
const realFetch = global.fetch;
global.fetch = (async (input: Parameters<typeof realFetch>[0], init?: Parameters<typeof realFetch>[1]) => {
  requests.push(String(input));
  return realFetch(input, init);
}) as typeof fetch;

function adapterOnFake(): AffinityAdapter {
  const adapter = new AffinityAdapter({
    tenant: 'team-verify' as TeamId,
    client: async () => {
      throw new Error('this script supplies its own client');
    },
    models: hostedModels,
    files: platformModuleFiles({ teamId: 'team-verify' as TeamId, module: '@lf/affinity' }),
    fetch,
  });
  const client = new AffinityAPIClient({ apiKey: 'fake', baseUrl: BASE });
  Object.assign(adapter, { getApiClient: async () => client });
  return adapter;
}

const domainIs = (value: string): Expression => ({
  type: 'compare',
  op: 'eq',
  left: { type: 'property', propertyTypeId: 'Domain' },
  right: { type: 'static', value },
});

async function run(label: string, where?: Expression) {
  const adapter = adapterOnFake();
  const meta = makeMetaPosition('affinity');
  requests.length = 0;
  const related = await adapter.getRelated({
    position: meta,
    fieldId: 'Organization',
    direction: 'outgoing',
    ...(where ? { where } : {}),
  });
  const orgReads = requests.filter((u) => u.includes('/organizations'));
  console.log(`\n── ${label}`);
  console.log(`   records: ${related.length}`);
  console.log(`   /organizations calls: ${orgReads.length}`);
  for (const u of orgReads) console.log(`     ${u}`);
  console.log(`   veltha present: ${related.some((r) => JSON.stringify(r.position).includes('veltha.ai'))}`);
}

async function main() {
  await run('WHERE `Domain` == "veltha.ai" — pushed to the term search', domainIs('veltha.ai'));
  await run('no WHERE — the workspace walk');
  process.exit(0);
}

void main();
