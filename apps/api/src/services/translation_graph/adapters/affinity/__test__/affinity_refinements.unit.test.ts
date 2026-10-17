// Affinity through the platform's own narrowing pass (the module's unit tests
// cover the adapter; this pass is the host's). The fake Affinity is the
// module's own test double.

import {
  checkProgram,
  fromCatalogSnapshot,
  parseProgram,
  scanInstanceChains,
  type CatalogSnapshot,
} from 'movement-lang';

import type { SourcePosition } from 'movement-engine/public/catalog';

import { AFFINITY_MANIFEST } from '@listen-fire/affinity/manifest';
import { makeAdapter } from '@listen-fire/affinity/__test__/fake_adapter';
import { instanceSchemaFromDescriptors, makeMetaPosition, positionLabel } from 'movement-engine/public/catalog';
import { refineInstanceSchema } from '../../../movement/refinements';

// The org's `List Entries` edge lands on the per-entity collection, whose
// members are the workspace's lists, so a WHERE naming the list narrows the hop
// to that list's own entry type — whether the path heads a block or sits inside
// `EXISTS(…)`. The second form was refused on Project A (`… has no field 'Deal
// Created' — it has: listName`): the host never saw the path inside EXISTS, so
// nothing narrowed. This runs the real adapter, the real meta walk's members,
// the real host narrowing pass and the real checker, as a save does.

describe('an org\'s list entries narrowed by list inside EXISTS reach the checker', () => {
  async function refinedSnapshot(source: string): Promise<CatalogSnapshot> {
    const { adapter } = makeAdapter();
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
    // The paths the meta walk files, by name — what `instance_cache` keeps.
    const root = await adapter.edgesFrom(makeMetaPosition('affinity'));
    const targetByFieldId = new Map(
      (root?.descriptor.references ?? []).map((r) => [r.fieldId, r.targetTypeId] as const),
    );
    const positionsByName = new Map<string, SourcePosition>();
    for (const [fieldId, position] of Object.entries(root?.targetPositions ?? {})) {
      positionsByName.set(targetByFieldId.get(fieldId) ?? positionLabel(position) ?? fieldId, position);
    }
    const refined = await refineInstanceSchema({
      instance: {
        adapterType: 'affinity',
        schema,
        entryPoints: entries.map((e) => ({
          typeId: e.typeId,
          displayName: e.displayName,
          writable: e.writable ?? false,
          readable: e.readable ?? false,
        })),
        describeType: async (name) => {
          const position = positionsByName.get(name);
          return position
            ? ((await adapter.edgesFrom(position))?.descriptor ?? null)
            : adapter.describe(name);
        },
        membersOf: async (recordType) =>
          [...positionsByName.entries()]
            .filter(([, position]) => position.recordType === recordType)
            .map(([name, position]) => ({ name, data: position.identity.data })),
      },
      chains: scanInstanceChains(source),
    });
    return {
      adapters: {
        affinity: {
          constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
          canFire: true,
          triggerConfig: ['events'],
          triggerConfigOptions: { events: [...(AFFINITY_MANIFEST.subscribableEvents ?? [])] },
          schemas: { affinity_creds: refined.schema },
        },
      },
      credentials: { affinity_creds: { adapters: ['affinity'] } },
      plugins: {},
    };
  }

  /** Project A's shape: a library function testing a match's entries. */
  async function errorsFor(line: string): Promise<Array<{ code: string; message: string }>> {
    const source = `import { affinity } from adapters
import { affinity_creds } from credentials

crm = connect affinity using affinity_creds

export node Deal {
  name: <text>
}

export function \`Probe Deal\`(d: <Deal>) {
  floor = 3
${line}
  return 1
}`;
    return checkProgram(parseProgram(source), fromCatalogSnapshot(await refinedSnapshot(source)))
      .filter((d) => (d.severity ?? 'error') === 'error')
      .map((d) => ({ code: d.code, message: d.message }));
  }

  const HOP =
    'crm-[o:`Organization` WHERE o.`Name` == d.name]->-[le:`List Entries` WHERE le.`listName` == "Hot Leads" AND le.`List Score` >= floor]->';

  it('a list\'s own field validates beside the list name, inside EXISTS', async () => {
    expect(await errorsFor(`  hit = exists(${HOP})`)).toEqual([]);
    expect(await errorsFor(`  if (exists(${HOP})) {\n    return 0\n  }`)).toEqual([]);
  });

  it('and inside COUNT, which already carried its hops', async () => {
    expect(await errorsFor(`  n = count(${HOP})`)).toEqual([]);
  });

  it('a field no list declares is refused against THAT list, not the collection', async () => {
    const [diagnostic, ...rest] = await errorsFor(
      '  hit = exists(crm-[o:`Organization` WHERE o.`Name` == d.name]->-[le:`List Entries` WHERE le.`listName` == "Hot Leads" AND le.`Made Up` >= floor]->)',
    );
    expect(rest).toEqual([]);
    expect(diagnostic.code).toBe('MOV_UNKNOWN_PROPERTY');
    expect(diagnostic.message).toContain('Organization List Entry "Hot Leads"');
    expect(diagnostic.message).toContain('List Score');
  });

  it('without the list name, a list\'s field is refused with the narrowing test to add', async () => {
    const [diagnostic, ...rest] = await errorsFor(
      '  hit = exists(crm-[o:`Organization` WHERE o.`Name` == d.name]->-[le:`List Entries` WHERE le.`List Score` >= floor]->)',
    );
    expect(rest).toEqual([]);
    expect(diagnostic.code).toBe('MOV_UNKNOWN_PROPERTY');
    expect(diagnostic.message).toBe(
      "crm.Organization List Entry has no field 'List Score' — it has: listName. If it is a field of one Organization List Entry only, narrow the hop that lands here to it: test `Name` == \"…\" (or `Id`, `listName`) in its WHERE",
    );
  });
});
