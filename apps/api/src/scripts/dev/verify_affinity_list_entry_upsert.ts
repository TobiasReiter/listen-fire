/**
 * Drive the Affinity adapter against a live fake-channels server over real
 * HTTP, and show that adding a company to a list is an UPSERT on (company,
 * list) rather than a create that quietly refuses to change anything.
 *
 * Five things to see:
 *   1. a company not yet on the list has no entry to find, so the write creates
 *      one and every authored field lands;
 *   2. the same company asked for a second time resolves to the entry it
 *      already has — which is what routes the engine to its update path;
 *   3. that update writes what it is handed and nothing else: handed no fields
 *      (everything suppressed upstream), it makes no field-value call at all;
 *   4. an `Owners` edge off the entry lands ON the entry, addressed against the
 *      company, and reads back under the name the list publishes;
 *   5. a field the workspace does not have fails the write, naming it.
 *
 * The `:` / `?:` / no-change decisions themselves are the ENGINE's, made
 * against the read-back this shows; they are covered by the movement-engine
 * suite ("a native constraint naming a parent edge routes the second write to
 * update"). What is proved here is the read-back and the routing they need.
 *
 * Usage: FAKE_BASE=http://localhost:6291/affinity ts-node … verify_affinity_list_entry_upsert.ts
 */
import type { TeamId } from '../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

import { AffinityAPIClient } from '@listen-fire/affinity/api_client';
import { AffinityAdapter } from '@listen-fire/affinity';
import { hostedModels } from '../../services/translation_graph/adapters/module_host';
import { platformModuleFiles } from '../../services/translation_graph/engine/files/module_files';

const BASE = process.env.FAKE_BASE ?? 'http://localhost:6291/affinity';

const requests: string[] = [];

function adapterOnFake(): AffinityAdapter {
  const adapter = new AffinityAdapter({
    tenant: 'team-upsert' as TeamId,
    client: async () => {
      throw new Error('this script supplies its own client');
    },
    models: hostedModels,
    files: platformModuleFiles({ teamId: 'team-upsert' as TeamId, module: '@lf/affinity' }),
    fetch,
  });
  const client = new AffinityAPIClient({ apiKey: 'fake', baseUrl: BASE });
  // Every call the adapter makes, in order — the evidence for "no field-value
  // call" claims, which are otherwise invisible.
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

function since(mark: number): string[] {
  return requests.slice(mark);
}

function fieldValueWrites(mark: number): string[] {
  return since(mark).filter((r) => r.startsWith('POST /field-values') || r.startsWith('PUT /field-values'));
}

async function main() {
  const adapter = adapterOnFake();
  const parentOf = (externalId: string) => [
    { recordType: 'Organization', externalId, edgeName: 'List Entries' },
  ];

  console.log('\n── 1. a company that is not on the list yet');
  const org = await adapter.createRecord({
    recordType: 'Organization',
    fields: { Name: `Upsert Test ${Date.now()}`, Domain: `upsert-${Date.now()}.co` },
    mutationContext: {} as never,
  });
  console.log(`   organization ${org.externalId}`);
  const identity = {
    recordType: 'Organization List Entry',
    record: { listName: 'Pipeline', 'List Entries': { id: org.externalId } },
    candidates: [],
    constraints: { any: [{ all: [{ field: 'List Entries' }, { field: 'listName' }] }] },
  };
  const before = await adapter.resolveEntity(identity);
  console.log(`   resolveEntity → ${JSON.stringify(before.candidates.map((c) => c.externalId))} (nothing to update)`);

  const created = await adapter.createRecord({
    recordType: 'Organization List Entry',
    fields: {
      listName: 'Pipeline',
      'Deal Stage': 'Sourced',
      'Deal Size': 5000000,
      'Next Step': 'Partner call',
    },
    parentLinks: parentOf(org.externalId),
    mutationContext: {} as never,
  });
  console.log(`   entry ${created.externalId}`);
  console.log(`   read back → ${JSON.stringify(
    await adapter.readRecord({ recordType: 'Organization List Entry', externalId: created.externalId }),
  )}`);

  console.log('\n── 2. the same company, asked again');
  const after = await adapter.resolveEntity(identity);
  console.log(`   resolveEntity → ${JSON.stringify(after.candidates.map((c) => c.externalId))} (the entry it already has)`);

  let mark = requests.length;
  await adapter.updateRecord({
    recordType: 'Organization List Entry',
    externalId: created.externalId,
    // What the engine hands an update after merging against the read-back: the
    // one field that actually changed. `listName` never survives — it is
    // unchanged — so the entry's list is found from the company's own rows.
    fields: { 'Deal Stage': 'Screening' },
    parentLinks: parentOf(org.externalId),
    mutationContext: {} as never,
  });
  console.log(`   update wrote → ${JSON.stringify(fieldValueWrites(mark))}`);
  console.log(`   read back → ${JSON.stringify(
    await adapter.readRecord({ recordType: 'Organization List Entry', externalId: created.externalId }),
  )}`);

  console.log('\n── 3. an update with nothing left to write');
  mark = requests.length;
  await adapter.updateRecord({
    recordType: 'Organization List Entry',
    externalId: created.externalId,
    fields: {},
    parentLinks: parentOf(org.externalId),
    mutationContext: {} as never,
  });
  console.log(`   field-value calls → ${fieldValueWrites(mark).length} (expected 0)`);

  console.log('\n── 4. an `Owners` edge off the entry');
  mark = requests.length;
  const owner = await adapter.createRecord({
    recordType: 'Person',
    fields: { 'First name': 'Olivia', 'Last name': 'Owner', Email: `olivia-${Date.now()}@example.com` },
    parentLinks: [
      { recordType: 'List Entry — Pipeline', externalId: created.externalId, edgeName: 'Owners' },
    ],
    mutationContext: {} as never,
  });
  console.log(`   person ${owner.externalId}`);
  console.log(`   requests → ${JSON.stringify(fieldValueWrites(mark))}`);
  const withOwner = await adapter.readRecord({
    recordType: 'List Entry — Pipeline',
    externalId: created.externalId,
  });
  console.log(`   read back → Owners: ${JSON.stringify(withOwner?.Owners)} (person ${owner.externalId})`);

  console.log('\n── 5. a field the workspace does not have');
  try {
    await adapter.createRecord({
      recordType: 'Organization List Entry',
      fields: { listName: 'Pipeline', 'Utter Nonsense': 'x' },
      parentLinks: parentOf(org.externalId),
      mutationContext: {} as never,
    });
    console.log('   NO ERROR (WRONG)');
  } catch (err) {
    console.log(`   ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`\n── request log (${requests.length} calls)`);
  for (const r of requests) console.log(`   ${r}`);
  process.exit(0);
}

void main();
