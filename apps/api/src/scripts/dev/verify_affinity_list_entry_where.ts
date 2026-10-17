/**
 * Drive the Affinity adapter against a live fake-channels server over real
 * HTTP, and show that a READ hop narrowed by the list's own name is checked
 * against THAT list's type — the read-side dual of the discriminated write.
 *
 * Four things to see:
 *   1. `o-[le:`List Entries` WHERE le.`listName` == "Pipeline"]->` narrows, so a
 *      made-up field in the SAME WHERE is an unknown-field error naming the
 *      list's own fields;
 *   2. it still narrows when the WHERE carries further conditions the members
 *      cannot decide (a runtime value, a field of the entry) — the production
 *      shape, and the one that used to validate clean;
 *   3. a bare field of the list (`Deal Stage`) is fine, and the old
 *      list-prefixed spelling is the same unknown-field error, with a
 *      did-you-mean pointing at the bare name;
 *   4. the alias binds to the list's type: `le.`Deal Stage`` types, and a
 *      made-up read off `le` errors. Without a literal list name, nothing
 *      narrows and nothing new is said.
 *
 * Usage: FAKE_BASE=http://localhost:6291/affinity ts-node … verify_affinity_list_entry_where.ts
 */
import {
  CURRENT_LANGUAGE_VERSION,
  checkProgram,
  fromCatalogSnapshot,
  parseProgram,
  scanInstanceChains,
  type CatalogSnapshot,
  type InstanceSchema,
} from 'movement-lang';

import type { SourcePosition } from 'movement-engine/services/translation_graph/types';
import type { EdgesFromResult } from 'movement-engine/services/translation_graph/adapter';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

import { AffinityAPIClient } from '@lf/affinity/api_client';
import { AffinityAdapter } from '@lf/affinity';
import { hostedModels } from '../../services/translation_graph/adapters/module_host';
import { platformModuleFiles } from '../../services/translation_graph/engine/files/module_files';
import { AFFINITY_MANIFEST } from '@lf/affinity';
import { instanceSchemaFromDescriptors } from 'movement-engine/services/translation_graph/movement/schema_projection';
import { refineInstanceSchema } from '../../services/translation_graph/movement/refinements';
import { makeMetaPosition, positionLabel } from 'movement-engine/services/translation_graph/types';

const BASE = process.env.FAKE_BASE ?? 'http://localhost:6291/affinity';

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
  Object.assign(adapter, {
    getApiClient: async () => {
      Object.assign(adapter, { web: { getWebBaseUrl: async () => 'https://fake.affinity.co' } });
      return client;
    },
  });
  return adapter;
}

/** The meta walk, as `instance_cache` does it — the members a narrowing
 *  predicate runs against are the ones the ROOT hop published. */
async function rootHop(adapter: AffinityAdapter): Promise<EdgesFromResult | null> {
  return adapter.edgesFrom(makeMetaPosition('affinity'));
}

async function refinableInstance(adapter: AffinityAdapter) {
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
  const hop = await rootHop(adapter);
  const targetNameByFieldId = new Map<string, string>(
    (hop?.descriptor.references ?? []).map((r) => [r.fieldId, r.targetTypeId] as const),
  );
  const positionsByName = new Map<string, SourcePosition>();
  const targetPositions: Record<string, SourcePosition> = hop?.targetPositions ?? {};
  for (const [fieldId, position] of Object.entries(targetPositions)) {
    const name = targetNameByFieldId.get(fieldId) ?? positionLabel(position) ?? fieldId;
    positionsByName.set(name, position);
  }
  return {
    adapterType: 'affinity',
    schema,
    entryPoints: entries.map((e) => ({
      typeId: e.typeId,
      displayName: e.displayName,
      writable: e.writable ?? false,
      readable: e.readable ?? false,
    })),
    // `instance_cache`'s `walkTo`: a type the meta walk handed a POSITION for is
    // described by walking to it, and only a name with no path falls back to
    // `describe`. The per-list types are only reachable the first way.
    describeType: async (typeName: string) => {
      const position = positionsByName.get(typeName);
      if (position) return (await adapter.edgesFrom(position))?.descriptor ?? null;
      return adapter.describe(typeName);
    },
    membersOf: async (recordType: string) =>
      [...positionsByName.entries()]
        .filter(([, p]) => p.recordType === recordType)
        .map(([name, p]) => ({ name, data: p.identity.data })),
  };
}

function snapshotOf(schema: InstanceSchema): CatalogSnapshot {
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

crm = connect affinity using affinity_creds
`;

function sourceFor(body: string): string {
  return `${PRELUDE}
function sync() {
  cutoff = "2026-01-01"
  crm-[org:\`Organization\` WHERE org.\`Domain\` == "graphredesign.co"]-> {
${body}
  }
}`;
}

async function check(
  instance: Awaited<ReturnType<typeof refinableInstance>>,
  body: string,
): Promise<string[]> {
  const source = sourceFor(body);
  const program = parseProgram(source);
  // The refinement pre-pass — catalog assembly's job in production
  // (`movement/catalog.ts`), replayed here so the checker sees the same schema.
  const { schema } = await refineInstanceSchema({
    instance,
    // A probe written today, pinned to nothing saved: the release's version.
    chains: scanInstanceChains(source, { languageVersion: CURRENT_LANGUAGE_VERSION }),
  });
  return checkProgram(program, fromCatalogSnapshot(snapshotOf(schema)))
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => `${d.code}: ${d.message}`);
}

const CASES: Array<{ label: string; body: string }> = [
  {
    label: 'narrowed, made-up field in the same WHERE',
    body: '    org-[le:`List Entries` WHERE le.`listName` == "Pipeline" AND le.`Made Up Field` == "x"]-> { }',
  },
  {
    label: 'narrowed alongside an undecidable condition (the production shape)',
    body: '    org-[le:`List Entries` WHERE le.`listName` == "Pipeline" AND le.`Made Up Field` >= cutoff]-> { }',
  },
  {
    label: 'narrowed, a real bare field of the list',
    body: '    org-[le:`List Entries` WHERE le.`listName` == "Pipeline" AND le.`Deal Stage` == "Sourced"]-> { }',
  },
  {
    label: 'narrowed, the OLD list-prefixed spelling',
    body: '    org-[le:`List Entries` WHERE le.`listName` == "Pipeline" AND le.`[Pipeline] Deal Stage` == "Sourced"]-> { }',
  },
  {
    label: 'the alias reads the list’s own field',
    body:
      '    org-[le:`List Entries` WHERE le.`listName` == "Pipeline"]-> {\n' +
      '      stage = le.`Deal Stage`\n' +
      '    }',
  },
  {
    label: 'the alias reads a made-up field',
    body:
      '    org-[le:`List Entries` WHERE le.`listName` == "Pipeline"]-> {\n' +
      '      stage = le.`Made Up Field`\n' +
      '    }',
  },
  {
    label: 'NO literal list name — nothing narrows',
    body: '    org-[le:`List Entries` WHERE le.`listName` == cutoff AND le.`Made Up Field` == "x"]-> { }',
  },
];

async function main() {
  const adapter = adapterOnFake();
  const instance = await refinableInstance(adapter);

  console.log('\n── members of the Organization List Entry collection');
  for (const m of await instance.membersOf('Organization List Entry')) {
    console.log(`   ${m.name} ${JSON.stringify(m.data)}`);
  }

  console.log('\n── `List Entry — Pipeline` fields');
  const pipeline = await adapter.describe('List Entry — Pipeline');
  console.log(`   ${pipeline?.fields.map((f) => f.displayName).join(', ')}`);

  console.log('\n── the checker, over the real projection');
  for (const c of CASES) {
    const diags = await check(instance, c.body);
    console.log(`   ${c.label}\n      → ${diags.join('\n      → ') || 'CLEAN'}`);
  }
  process.exit(0);
}

void main();
