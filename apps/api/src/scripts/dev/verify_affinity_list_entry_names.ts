/**
 * Drive the Affinity adapter against a live fake-channels server over real
 * HTTP, and show that a list's own type publishes its fields the way the list
 * shows them — through describe, through the checker, and through a write that
 * lands and reads back.
 *
 * Four things to see:
 *   1. Organization's custom fields are WRITABLE, the enrichment-sourced one
 *      included;
 *   2. `List Entry — Pipeline` names its fields bare (`Deal Stage`, not
 *      `[Pipeline] Deal Stage`);
 *   3. the acceptance write typechecks with those bare names, and a made-up
 *      field still does not;
 *   4. the write lands on the entry and reads back under the same bare names.
 *
 * Usage: FAKE_BASE=http://localhost:6291/affinity ts-node … verify_affinity_list_entry_names.ts
 */
import {
  checkProgram,
  fromCatalogSnapshot,
  parseProgram,
  type CatalogSnapshot,
} from 'movement-lang';
import { AffinityAPIClient } from '../../adapters/affinity/apiClient';
import { AffinityAdapter } from '../../services/translation_graph/adapters/affinity';
import { AFFINITY_MANIFEST } from '../../services/translation_graph/adapters/affinity';
import { instanceSchemaFromDescriptors } from '../../services/translation_graph/movement/schema_projection';
import { makeStablePosition } from '../../services/translation_graph/types';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

const BASE = process.env.FAKE_BASE ?? 'http://localhost:6291/affinity';

function adapterOnFake(): AffinityAdapter {
  const adapter = new AffinityAdapter({
    teamId: 'team-verify' as TeamId,
    credentialsId: 'creds-verify' as ExternalServiceCredentialsId,
  });
  const client = new AffinityAPIClient({ apiKey: 'fake', baseUrl: BASE });
  Object.assign(adapter, {
    getApiClient: async () => {
      // The real getApiClient also mints the web-URL resolver the write path
      // uses for a record's link; the override has to do the same.
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

const PRELUDE = `import { affinity } from adapters
import { affinity_creds } from credentials

crm = affinity(credentials: affinity_creds)
`;

async function check(snap: CatalogSnapshot, body: string): Promise<string[]> {
  const source = `${PRELUDE}
movement sync() {
  crm-[org:\`Organization\` WHERE \`Domain\` == "graphredesign.co"]-> {
${body}
  }
}`;
  return checkProgram(parseProgram(source), fromCatalogSnapshot(snap))
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => `${d.code}: ${d.message}`);
}

async function main() {
  const adapter = adapterOnFake();

  console.log('\n── 1. describe Organization — writable custom fields');
  const org = await adapter.describe('Organization');
  for (const f of org!.fields) {
    console.log(`   ${f.writable ? 'W' : '·'} ${f.displayName} (${f.fieldId})`);
  }

  console.log('\n── 2. describe `List Entry — Pipeline`');
  const entryType = await adapter.describe('List Entry — Pipeline');
  for (const f of entryType!.fields) {
    console.log(`   ${f.writable ? 'W' : '·'} field ${JSON.stringify(f.displayName)} (${f.fieldId})`);
  }
  for (const r of entryType!.references) {
    console.log(`   ${r.writable ? 'W' : '·'} edge  ${JSON.stringify(r.name)} → ${r.targetTypeId}`);
  }

  console.log('\n── 3. the checker, over the real projection');
  const snap = await snapshot(adapter);
  const accepted = await check(
    snap,
    '    write org-[:`List Entries`]-> { listName: "Pipeline", `Deal Stage`: "Sourced", `Deal Size`: 5000000, `Next Step`: "Partner call" }',
  );
  console.log(`   acceptance write → ${accepted.length === 0 ? 'CLEAN' : accepted.join(' | ')}`);
  const nonsense = await check(
    snap,
    '    write org-[:`List Entries`]-> { listName: "Pipeline", `Utter Nonsense`: "x" }',
  );
  console.log(`   made-up field    → ${nonsense.join(' | ') || 'CLEAN (WRONG)'}`);
  const prefixed = await check(
    snap,
    '    write org-[:`List Entries`]-> { listName: "Pipeline", `[Pipeline] Deal Stage`: "Sourced" }',
  );
  console.log(`   prefixed name    → ${prefixed.join(' | ') || 'CLEAN'}`);

  console.log('\n── 4. run the write, then read the entry back');
  const written = await adapter.createRecord({
    recordType: 'Organization List Entry',
    fields: {
      listName: 'Pipeline',
      'Deal Stage': 'Sourced',
      'Deal Size': 5000000,
      'Next Step': 'Partner call',
    },
    parentLinks: [{ recordType: 'Organization', externalId: '9601', edgeName: 'List Entries' }],
    mutationContext: {} as never,
  });
  console.log(`   entry ${written.externalId}`);
  const entry = makeStablePosition({
    adapterType: 'affinity',
    recordType: 'List Entry — Pipeline',
    recordId: written.externalId,
    data: {},
  });
  for (const name of ['Deal Stage', 'Deal Size', 'Next Step']) {
    console.log(
      `   ${JSON.stringify(name)} → ${JSON.stringify(await adapter.getFieldValue({ position: entry, fieldId: name }))}`,
    );
  }
  process.exit(0);
}

void main();
