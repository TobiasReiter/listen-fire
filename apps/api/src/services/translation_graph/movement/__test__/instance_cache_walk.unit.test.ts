// The meta-graph walk (plans/2026-07-10-adapter-entry-positions/3_edges_from.md).
//
// Introspection is a walk, not a dump: from the root, the types reachable
// independently; from a type node, its edges; recursively. `edgesFrom` is that
// primitive, and a POSITION IS A PATH — the adapter mints it, the cache echoes
// it back, so following an edge costs one call instead of re-deriving a route.
//
// The fixture is Airtable's shape, since it is the one that forced this: a
// workspace of bases (variable schema — two bases hold different tables, so
// they are two TYPES) whose tables live behind them, reachable only through
// their base. Pins:
//   - a container type is reached by its path, not by name;
//   - a type BEHIND a container is reached by the path its container's hop
//     taught, so it never re-walks the workspace;
//   - drill-down touches ONE base — the whole point, and why the fixture has
//     two;
//   - a name with no known path still answers, via `describe`;
//   - a wide hop is drained to its last page;
//   - an adapter with no `edgesFrom` is untouched.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { SourcePosition } from 'movement-engine/services/translation_graph/types';

const describeCalls: string[] = [];
const edgesFromCalls: { recordType: string | null; recordId?: string; cursor?: unknown }[] = [];
let rootHopFails = false;
/** Pages the root hop splits its bases across — 1 = no continuation. */
let rootHopPages = 1;
/** false = the root publishes ONLY the polymorphic `Base` edge; its members
 *  ride `targetPositions` with no reference row each (the Airtable shape after
 *  the named per-base edges were dropped). */
let namedRootEdges = true;

const BASES = [
  { id: 'appCRM', name: 'CRM', tables: [{ id: 'tblCo', name: 'Companies' }] },
  { id: 'appOps', name: 'Ops', tables: [{ id: 'tblVend', name: 'Vendors' }] },
];

const qualified = (baseName: string, tableName: string) => `${baseName} — ${tableName}`;

function stable(recordType: string, recordId: string, data?: unknown): SourcePosition {
  return { adapterType: 'airtable', recordType, identity: { kind: 'stable', recordId, ...(data ? { data } : {}) } };
}

/** The root's edges — one per base — split across `rootHopPages` pages.
 *  With `namedRootEdges` off, the same members ride under one polymorphic
 *  `Base` reference instead: paths without presentation rows. */
function rootHop(cursor: unknown) {
  const page = typeof cursor === 'number' ? cursor : 0;
  const perPage = Math.ceil(BASES.length / rootHopPages);
  const slice = BASES.slice(page * perPage, (page + 1) * perPage);
  const more = (page + 1) * perPage < BASES.length;
  return {
    descriptor: {
      typeId: 'meta',
      displayName: 'meta',
      fields: [],
      references: namedRootEdges
        ? slice.map((b) => ({
            fieldId: `edge-${b.id}`,
            name: b.name,
            targetTypeId: b.name,
            cardinality: 'many' as const,
          }))
        : [{ fieldId: 'Base', name: 'Base', targetTypeId: 'Base', cardinality: 'many' as const }],
    },
    targetPositions: Object.fromEntries(
      slice.map((b) => [
        namedRootEdges ? `edge-${b.id}` : b.id,
        stable('Base', b.id, { Name: b.name }),
      ]),
    ),
    ...(more ? { nextCursor: page + 1 } : {}),
  };
}

jest.mock('../../adapters/resolve', () => ({
  resolveAdapter: async () => ({
    // This fixture models AIRTABLE: bases holding tables. That containment is
    // why a full-surface describe is refused here — not the fact that it walks.
    walksContainers: true,
    // Bases are the entry points: one `listBases`, no per-base fan-out. With
    // the named edges dropped, the entry list is the polymorphic edge alone —
    // the entry list and the walk are the same node's edges.
    listEntryPoints: async () =>
      namedRootEdges
        ? BASES.map((b) => ({ typeId: b.name, displayName: b.name, writable: false, readable: true }))
        : [{ typeId: 'Base', displayName: 'Base', writable: false, readable: true }],

    // The slow route: a bare name leaves the adapter to re-derive the route,
    // which for Airtable means walking every base to map a display name back
    // to its {baseId, tableId}.
    describe: async (typeId: string) => {
      describeCalls.push(typeId);
      for (const b of BASES) {
        for (const t of b.tables) {
          if (qualified(b.name, t.name) === typeId) {
            return { typeId, displayName: typeId, fields: [], references: [] };
          }
        }
      }
      return null;
    },

    edgesFrom: async (position: SourcePosition, cursor?: unknown) => {
      const recordId = position.identity.kind === 'stable' ? position.identity.recordId : undefined;
      edgesFromCalls.push({ recordType: position.recordType, ...(recordId ? { recordId } : {}), ...(cursor !== undefined ? { cursor } : {}) });

      if (position.recordType === 'meta') {
        if (rootHopFails) throw new Error('root hop exploded');
        return rootHop(cursor);
      }
      // A base: its tables, each with the path on to it. The path carries the
      // baseId because a table is only reachable through its base.
      if (position.recordType === 'Base') {
        const b = BASES.find((x) => x.id === recordId);
        if (!b) return null;
        return {
          descriptor: {
            typeId: b.name,
            displayName: b.name,
            fields: [],
            references: b.tables.map((t) => ({
              fieldId: `edge-${t.id}`,
              name: t.name,
              targetTypeId: qualified(b.name, t.name),
              cardinality: 'many' as const,
            })),
          },
          targetPositions: Object.fromEntries(
            b.tables.map((t) => [`edge-${t.id}`, stable('Table', t.id, { baseId: b.id })]),
          ),
        };
      }
      // A table: its fields. Routed straight off the path — no name lookup.
      if (position.recordType === 'Table') {
        const found = BASES.flatMap((b) => b.tables.map((t) => ({ b, t }))).find(
          (x) => x.t.id === recordId,
        );
        if (!found) return null;
        return {
          descriptor: {
            typeId: qualified(found.b.name, found.t.name),
            displayName: qualified(found.b.name, found.t.name),
            fields: [
              { fieldId: 'fldName', displayName: 'Name', kind: 'string', writable: true, required: false },
            ],
            references: [],
          },
        };
      }
      return null;
    },
  }),
}));

jest.mock('../../adapters/registry', () => ({
  getAdapterManifest: () => ({ methods: ['createRecord'] }),
}));

import { cachedAdapterInstance, clearIntrospectionCache } from '../instance_cache';

const base = { adapterType: 'airtable', teamId: 'team-1' as TeamId };

beforeEach(() => {
  clearIntrospectionCache();
  describeCalls.length = 0;
  edgesFromCalls.length = 0;
  rootHopFails = false;
  rootHopPages = 1;
  namedRootEdges = true;
});

describe('cachedAdapterInstance — walking the meta-graph', () => {
  it('reaches a container type by its path, never by name', async () => {
    const result = await cachedAdapterInstance({ ...base, types: ['CRM'] });

    // The root hop taught the path to `CRM`; the cache echoed it back.
    expect(edgesFromCalls).toEqual([
      { recordType: 'meta' },
      { recordType: 'Base', recordId: 'appCRM' },
    ]);
    expect(describeCalls).toEqual([]);
    expect(result.projection.schema.positions.CRM).toBeDefined();
  });

  it('reaches a type behind a container by the path its container taught', async () => {
    // The shape of the request the drill-down actually makes: a movement
    // naming `CRM — Companies` also demands `CRM`, because the checker
    // substring-matches display names against the source text.
    await cachedAdapterInstance({ ...base, types: ['CRM', 'CRM — Companies'] });

    expect(edgesFromCalls).toEqual([
      { recordType: 'meta' },
      { recordType: 'Base', recordId: 'appCRM' },
      // Routed off the path the base's hop handed back — {baseId, tableId} in
      // hand, so no workspace walk to resolve the name.
      { recordType: 'Table', recordId: 'tblCo' },
    ]);
    expect(describeCalls).toEqual([]);
  });

  it('drills into ONE base — it never walks the workspace', async () => {
    await cachedAdapterInstance({ ...base, types: ['CRM', 'CRM — Companies'] });

    // The timeout this whole model exists to kill: `Ops` is never touched.
    expect(edgesFromCalls.map((c) => c.recordId)).not.toContain('appOps');
    expect(describeCalls).toEqual([]);
  });

  it('falls back to describe for a name it has no path to', async () => {
    // Asking for a table WITHOUT its container: nothing taught its path, so
    // the adapter re-derives the route. Correct, just not cheap.
    const result = await cachedAdapterInstance({ ...base, types: ['Ops — Vendors'] });

    expect(describeCalls).toEqual(['Ops — Vendors']);
    expect(result.projection.schema.positions['Ops — Vendors']).toBeDefined();
  });

  it('drains a wide hop to its last page', async () => {
    rootHopPages = 2;
    await cachedAdapterInstance({ ...base, types: ['Ops'] });

    // Ops is on the SECOND page: a walk that stopped at the first would never
    // learn its path and would silently fall back to a name lookup.
    expect(edgesFromCalls).toEqual([
      { recordType: 'meta' },
      { recordType: 'meta', cursor: 1 },
      { recordType: 'Base', recordId: 'appOps' },
    ]);
    expect(describeCalls).toEqual([]);
  });

  it('walks the root once across scoped calls', async () => {
    await cachedAdapterInstance({ ...base, types: ['CRM'] });
    await cachedAdapterInstance({ ...base, types: ['Ops'] });

    expect(edgesFromCalls.filter((c) => c.recordType === 'meta')).toHaveLength(1);
  });

  it('an unscoped request walks NOTHING — the node list is the answer', async () => {
    const result = await cachedAdapterInstance(base);

    // "The full surface" of a container-shaped adapter means walking every
    // container — the 1+N that timed out at 55s and returned nothing. Asking
    // what's in the connection is answered by the node list; you follow a
    // base to see inside it.
    expect(result.entryPoints.map((e) => e.typeId)).toEqual(['CRM', 'Ops']);
    expect(edgesFromCalls.filter((c) => c.recordType === 'Base')).toEqual([]);
    expect(describeCalls).toEqual([]);
  });

  it('tells the projection the surface is walked, not published whole', async () => {
    // Gates the drift note: on a walked instance an edge to an un-walked type
    // is expected, so warning about it would fire on every un-traversed edge.
    const result = await cachedAdapterInstance({ ...base, types: ['CRM'] });
    expect(result.projection.notes).toEqual([]);
  });

  // A type addressed by the WALK that reaches it, rather than by a name that
  // encodes the walk. plans/2026-07-10-adapter-entry-positions/5_paths_as_addresses.md
  describe('addressing by path', () => {
    it('walks a named path and describes where it lands', async () => {
      const result = await cachedAdapterInstance({ ...base, types: ['-[:`CRM`]->-[:Companies]->'] });

      expect(edgesFromCalls).toEqual([
        { recordType: 'meta' },
        { recordType: 'Base', recordId: 'appCRM' },
        { recordType: 'Table', recordId: 'tblCo' },
      ]);
      // It lands on the type, under the type's own name — no separator, and
      // nothing had to know a naming convention to ask for it.
      expect(result.projection.schema.positions['CRM — Companies']).toBeDefined();
      expect(describeCalls).toEqual([]);
    });

    it('a narrowed polymorphic hop is the same walk as the named one', async () => {
      const named = await cachedAdapterInstance({ ...base, types: ['-[:`CRM`]->-[:Companies]->'] });
      const namedCalls = [...edgesFromCalls];

      clearIntrospectionCache();
      edgesFromCalls.length = 0;
      const narrowed = await cachedAdapterInstance({
        ...base,
        types: ['-[:Base WHERE `Name` == "CRM"]->-[:Companies]->'],
      });

      // Same landing, same hops, same cost — the rule (4_polymorphic_edges.md).
      expect(edgesFromCalls).toEqual(namedCalls);
      expect(Object.keys(narrowed.projection.schema.positions)).toEqual(
        Object.keys(named.projection.schema.positions),
      );
    });

    it('refuses a narrowed hop whose member is the wrong KIND', async () => {
      // `Table` is not what a base edge lands on, so this addresses nothing —
      // rather than silently walking to the base anyway.
      const result = await cachedAdapterInstance({
        ...base,
        types: ['-[:Table WHERE `Name` == "CRM"]->'],
      });
      expect(result.projection.schema.positions.CRM).toBeUndefined();
    });

    it('a path that addresses nothing is simply absent', async () => {
      const result = await cachedAdapterInstance({ ...base, types: ['-[:`Nope`]->-[:Companies]->'] });
      expect(result.projection.schema.positions.Companies).toBeUndefined();
      // The node list is unharmed — a bad address is not a broken instance.
      expect(result.entryPoints.map((e) => e.typeId)).toEqual(['CRM', 'Ops']);
    });
  });

  // The Airtable shape after the named per-base edges were dropped: the root
  // presents ONE polymorphic edge, and its members are paths without
  // presentation rows. Narrowing and by-name addressing must not depend on the
  // presentation — members are the walk's currency, labels are their names.
  describe('a polymorphic-only root — members with no reference row each', () => {
    beforeEach(() => {
      namedRootEdges = false;
    });

    it('a narrowed hop still resolves, at the same cost', async () => {
      const result = await cachedAdapterInstance({
        ...base,
        types: ['-[:Base WHERE `Name` == "CRM"]->-[:Companies]->'],
      });
      expect(edgesFromCalls).toEqual([
        { recordType: 'meta' },
        { recordType: 'Base', recordId: 'appCRM' },
        { recordType: 'Table', recordId: 'tblCo' },
      ]);
      expect(result.projection.schema.positions['CRM — Companies']).toBeDefined();
      expect(describeCalls).toEqual([]);
    });

    it('a member is still reachable BY NAME, through the label its position carries', async () => {
      const result = await cachedAdapterInstance({ ...base, types: ['CRM'] });
      expect(edgesFromCalls).toEqual([
        { recordType: 'meta' },
        { recordType: 'Base', recordId: 'appCRM' },
      ]);
      expect(describeCalls).toEqual([]);
      expect(result.projection.schema.positions.CRM).toBeDefined();
    });

    it('membersOf publishes the members under their labels', async () => {
      const instance = await cachedAdapterInstance(base);
      const members = await instance.membersOf('Base');
      expect(members.map((m) => m.name).sort()).toEqual(['CRM', 'Ops']);
      expect(members.map((m) => m.data)).toEqual(
        expect.arrayContaining([{ Name: 'CRM' }, { Name: 'Ops' }]),
      );
    });

    it('membersAt names members by label at the root hop', async () => {
      const instance = await cachedAdapterInstance(base);
      const members = await instance.membersAt({ steps: [], recordType: 'Base' });
      expect(members.map((m) => m.name).sort()).toEqual(['CRM', 'Ops']);
    });
  });

  it('still answers when the root hop fails', async () => {
    rootHopFails = true;
    const result = await cachedAdapterInstance({ ...base, types: ['CRM — Companies'] });

    // A failed root hop costs paths, not correctness.
    expect(describeCalls).toEqual(['CRM — Companies']);
    expect(result.projection.schema.positions['CRM — Companies']).toBeDefined();
  });
});
