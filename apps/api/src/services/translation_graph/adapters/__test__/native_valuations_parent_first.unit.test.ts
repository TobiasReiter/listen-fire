// Parent-first navigation (adapters/CLAUDE.md rule 7): deep Valuations
// records are reached THROUGH their parents — `legalEntity-[:Events]->`,
// `asset-[:Prices]->`, `investment-[:Transactions]->` — via the REST list's
// FK-scoped filters, and CREATED along the same edges (the write's parent
// links inject the child's FK columns; an N-parent create is the tuple-path
// write: an Investment converges an investee `Investments` path and an
// investor `Investments Made` path).

// logger → services/context → casl crashes at module load; stub it (mirrors
// the sibling tests).
jest.mock('../../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
// Credentials load hits the DB + decrypt; stub the two seams so requireCreds
// resolves to a fake connection without a database.
jest.mock('../../../../lib/kysely', () => {
  const qb = () => ({
    selectFrom: () => ({
      where: () => ({
        select: () => ({
          executeTakeFirstOrThrow: async () => ({ id: 'cred-1', credentials: Buffer.from('x') }),
        }),
      }),
    }),
  });
  return { getQb: qb, getCoreQb: qb, getAutomationsQb: qb };
});
jest.mock('../../../../lib/credentials', () => ({
  decryptToken: jest.fn(async () => JSON.stringify({ apiKey: 'k', baseUrl: 'http://vals.test/api/v1' })),
}));

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MutationContext } from '../../mutation_context';

import { decryptToken } from '../../../../lib/credentials';
import {
  NATIVE_VALUATIONS_ADAPTER_TYPE,
  createNativeValuationsAdapter,
} from '../native_valuations';
import { ADAPTER_META_TYPE_ID, META_RECORD_TYPE, makeStablePosition } from '../../types';
import { instanceSchemaFromDescriptors } from '../../movement/schema_projection';


const adapter = () =>
  createNativeValuationsAdapter({ teamId: 'team-1' as TeamId, credentialsId: 'cred-1' });

const position = (recordType: string, id: string, data: Record<string, unknown> = { id }) =>
  makeStablePosition({
    adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
    recordType,
    recordId: id,
    data,
  });

const mutationContext = {} as MutationContext;

const listResponse = (rows: Array<Record<string, unknown>>) =>
  new Response(JSON.stringify({ data: rows, meta: { count: rows.length, offset: 0, limit: 100 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const recordResponse = (row: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify({ data: row }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the root surface — only genuine workspace-wide enumerations (rule 0)', () => {
  it('entries: Legal Entity + Asset are the roots; deep records publish no root promises', async () => {
    const entries = await adapter().listEntryPoints();
    const promises = new Map(entries.map((e) => [e.typeId, { r: e.readable, w: e.writable }]));

    expect(promises.get('Legal Entity')).toEqual({ r: true, w: true });
    expect(promises.get('Asset')).toEqual({ r: true, w: true });
    for (const retired of ['Investment', 'Transaction', 'Asset Transfer', 'Price', 'Event']) {
      // Published (the name resolver / describe / event discrimination still
      // know the type; the position derives from edge reachability) — but no
      // root collection and no root write.
      expect(promises.get(retired)).toEqual({ r: false, w: false });
    }
    expect(promises.get('Valuation')).toEqual({ r: false, w: false });
  });

  it('the walk and the entry list publish the same root edges (meta descriptor ≡ entries)', async () => {
    const a = adapter();
    const entries = await a.listEntryPoints();
    const meta = await a.describe(ADAPTER_META_TYPE_ID);
    const rootEdges = meta!.references.map((r) => r.fieldId).sort();
    const promisedRoots = entries
      .filter((e) => e.readable || e.writable)
      .map((e) => e.typeId)
      .sort();
    expect(rootEdges).toEqual(promisedRoots);
    expect(rootEdges).toEqual(['Asset', 'Legal Entity']);
  });

  it('a root read of a retired type fails LOUD and points at the parent path', async () => {
    const metaPosition = makeStablePosition({
      adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
      recordType: META_RECORD_TYPE,
      recordId: 'meta',
      data: {},
    });
    await expect(
      adapter().getRelated({ position: metaPosition, fieldId: 'Investment', direction: 'outgoing' }),
    ).rejects.toThrow(/Investments live under their legal entities/);
    await expect(
      adapter().getRelated({ position: metaPosition, fieldId: 'Event', direction: 'outgoing' }),
    ).rejects.toThrow(/Events live under their legal entity/);
    await expect(
      adapter().getRelated({ position: metaPosition, fieldId: 'Valuation', direction: 'outgoing' }),
    ).rejects.toThrow(/computed per record/);
  });

  it('a snapshot of a retired type fails LOUD with the same redirect', async () => {
    // `snapshot` rides the concrete adapter class, not the `Adapter`
    // interface — reach it structurally.
    const withSnapshot = adapter() as unknown as {
      snapshot(input: { pipelineInputId: string; recordType: string }): AsyncIterable<unknown>;
    };
    const events = withSnapshot.snapshot({ pipelineInputId: '', recordType: 'Price' });
    await expect(events[Symbol.asyncIterator]().next()).rejects.toThrow(
      /Prices live under their asset/,
    );
  });

  it('the surviving roots still enumerate (Legal Entity via the meta hop)', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(listResponse([{ id: 'le-1', name: 'NewCo' }]));
    const metaPosition = makeStablePosition({
      adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
      recordType: META_RECORD_TYPE,
      recordId: 'meta',
      data: {},
    });
    const results = await adapter().getRelated({
      position: metaPosition,
      fieldId: 'Legal Entity',
      direction: 'outgoing',
    });
    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/legal-entities');
    expect(results).toHaveLength(1);
    expect(results[0].position.recordType).toBe('Legal Entity');
  });
});

describe('down-edge descriptors', () => {
  it('Legal Entity publishes the parent-first edges, writable, with no parent backing fields', async () => {
    const descriptor = await adapter().describe('Legal Entity');
    const byName = new Map(descriptor!.references.map((r) => [r.name ?? r.fieldId, r]));
    for (const edge of ['Events', 'Investments', 'Investments Made', 'Assets', 'Transfers Out', 'Transfers In']) {
      const ref = byName.get(edge);
      expect(ref).toBeDefined();
      expect(ref?.cardinality).toBe('many');
      expect(ref?.writable).toBe(true);
      // No column on the PARENT backs a down-edge — the FK lives on the child.
      expect(ref?.backingFields).toEqual([]);
    }
    expect(byName.get('Events')?.targetTypeId).toBe('Event');
    expect(byName.get('Investments')?.targetTypeId).toBe('Investment');
  });

  it('the children declare their REQUIRED up-edges (the REST create contract)', async () => {
    const investment = await adapter().describe('Investment');
    const required = investment!.references.filter((r) => r.required === true).map((r) => r.name);
    expect(required.sort()).toEqual(['Investee', 'Investor']);

    const event = await adapter().describe('Event');
    expect(event!.references.find((r) => r.name === 'Legal Entity')?.required).toBe(true);

    const price = await adapter().describe('Price');
    expect(price!.references.find((r) => r.name === 'Asset')?.required).toBe(true);

    const transfer = await adapter().describe('Asset Transfer');
    const transferRequired = transfer!.references.filter((r) => r.required === true).map((r) => r.name);
    expect(transferRequired.sort()).toEqual(['Asset', 'From', 'To', 'Transaction']);
  });
});

describe('the write promise reaches the CHECKER, not just describe()', () => {
  /** The projection the checker actually types against: `listEntryPoints()` +
   *  `describe()` through `instanceSchemaFromDescriptors` (the ontology
   *  projection is KG-only, so this is the single path for this adapter). */
  const project = async () => {
    const a = adapter();
    const entries = await a.listEntryPoints();
    const descriptors = new Map(
      (
        await Promise.all(
          entries.map(async (e) => [e.typeId, await a.describe(e.typeId)] as const),
        )
      ).flatMap(([typeId, d]) => (d ? [[typeId, d] as const] : [])),
    );
    return instanceSchemaFromDescriptors({
      adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
      entries,
      descriptors,
      supportsInPlaceUpdate: true,
    });
  };

  it('the down-edges arrive at the checker writable', async () => {
    const { positions } = (await project()).schema;
    const le = positions['Legal Entity']!.edges;
    expect(le.Events).toMatchObject({ target: 'Event', writable: true });
    expect(le.Investments).toMatchObject({ target: 'Investment', writable: true });
    expect(le['Investments Made']).toMatchObject({ target: 'Investment', writable: true });
    expect(le.Assets).toMatchObject({ target: 'Asset', writable: true });
    // Both role-split sides really write — each injects a DIFFERENT child FK.
    expect(le['Transfers Out']).toMatchObject({ target: 'Asset Transfer', writable: true });
    expect(le['Transfers In']).toMatchObject({ target: 'Asset Transfer', writable: true });
    expect(positions.Asset!.edges.Prices!.writable).toBe(true);
    expect(positions.Asset!.edges.Transfers!.writable).toBe(true);
    expect(positions.Investment!.edges.Transactions!.writable).toBe(true);
    expect(positions.Event!.edges.Transactions!.writable).toBe(true);
    expect(positions.Transaction!.edges['Asset Transfers']!.writable).toBe(true);
  });

  it('everything else is read-only — the promise is the down-edge set, exactly', async () => {
    const { positions } = (await project()).schema;
    // Derived / projected cross-references: no code path sets them.
    for (const edge of ['Investing Entity', 'Underlying Company', 'Acquired By']) {
      expect(positions['Legal Entity']!.edges[edge]!.writable).toBeUndefined();
    }
    // The CHILD-side view of a writable relationship. `Investor` is
    // `Investments Made` seen from the investment — the write currency is the
    // parent side (`injectParentLink` only matches down-edges), so promising it
    // twice would be a promise nothing honours.
    expect(positions.Investment!.edges.Investor!.writable).toBeUndefined();
    expect(positions.Investment!.edges.Investee!.writable).toBeUndefined();
    expect(positions.Event!.edges['Legal Entity']!.writable).toBeUndefined();
    expect(positions.Price!.edges.Asset!.writable).toBeUndefined();
    // A valuation is COMPUTED (POST /valuations/compute) — never written.
    expect(positions['Legal Entity']!.edges.Valuations!.writable).toBeUndefined();
    expect(positions.Investment!.edges.Valuations!.writable).toBeUndefined();

    const writable = Object.values(positions).flatMap((p) =>
      Object.values(p.edges).filter((e) => e.writable === true),
    );
    expect(writable).toHaveLength(25);
  });

  it('every REST-creatable type still has a write shape (under-promise, not a hole)', async () => {
    const { schema } = await project();
    // Roots create at the top level; the parent-first types create along their
    // writable down-edge — together, the five parent-first CRUD types, plus
    // the AddMarkdown, AddInvestment, AddPrice, AddRound, AddWindDown,
    // AddShareSplit, AddDividends, AddFundDistribution, and AddFundDrawdown
    // actions (reached the same way, off Legal Entity / Asset — not CRUD
    // entities, but their writable input shapes file under createShapes too).
    expect(Object.keys(schema.writableRoots).sort()).toEqual(['Asset', 'Legal Entity']);
    expect(Object.keys(schema.createShapes ?? {}).sort()).toEqual([
      'AddDividends', 'AddFundDistribution', 'AddFundDrawdown', 'AddInvestment', 'AddMarkdown', 'AddPrice', 'AddRound', 'AddShareSplit', 'AddWindDown', 'Asset Transfer', 'Event', 'Investment', 'Price', 'Transaction',
    ]);
  });
});

describe('down-edge reads — the child list scoped by the parent id', () => {
  it('`legalEntity-[:Events]->` lists /valuations/events?legal_entity_id=<id>', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(listResponse([{ id: 'ev-1', type: 'INVESTMENT_ROUND', legal_entity_id: 'le-1' }]));

    const results = await adapter().getRelated({
      position: position('Legal Entity', 'le-1'),
      fieldId: 'Events',
      direction: 'outgoing',
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/events');
    expect(url.searchParams.get('legal_entity_id')).toBe('le-1');
    expect(results).toHaveLength(1);
    expect(results[0].position.recordType).toBe('Event');
  });

  it('`asset-[:Prices]->` and both investment directions scope by their own FK params', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => listResponse([]));

    await adapter().getRelated({
      position: position('Asset', 'as-1'),
      fieldId: 'Prices',
      direction: 'outgoing',
    });
    await adapter().getRelated({
      position: position('Legal Entity', 'le-1'),
      fieldId: 'Investments',
      direction: 'outgoing',
    });
    await adapter().getRelated({
      position: position('Legal Entity', 'le-1'),
      fieldId: 'Investments Made',
      direction: 'outgoing',
    });

    const urls = fetchSpy.mock.calls.map((c) => new URL(String(c[0])));
    expect(urls[0].pathname).toBe('/api/v1/valuations/prices');
    expect(urls[0].searchParams.get('asset_id')).toBe('as-1');
    expect(urls[1].pathname).toBe('/api/v1/valuations/investments');
    expect(urls[1].searchParams.get('investment_profile_id')).toBe('le-1');
    expect(urls[2].pathname).toBe('/api/v1/valuations/investments');
    expect(urls[2].searchParams.get('investor_profile_id')).toBe('le-1');
  });

  it('pages the scoped list to completion (full page → next offset)', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: `ev-${i}` }));
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(listResponse(fullPage))
      .mockResolvedValueOnce(listResponse([{ id: 'ev-last' }]));

    const results = await adapter().getRelated({
      position: position('Legal Entity', 'le-1'),
      fieldId: 'Events',
      direction: 'outgoing',
    });

    expect(results).toHaveLength(101);
    const second = new URL(String(fetchSpy.mock.calls[1][0]));
    expect(second.searchParams.get('offset')).toBe('100');
  });

  it('reads the parent id from a webhook envelope position too', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(listResponse([]));
    await adapter().getRelated({
      position: position('Legal Entity', 'le-9', {
        event: 'valuations:legal_entity:update',
        timestamp: 't',
        actor: { type: 'user', id: 'u' },
        data: { id: 'le-9', before: null, after: { id: 'le-9', name: 'NewCo' } },
      }),
      fieldId: 'Events',
      direction: 'outgoing',
    });
    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.searchParams.get('legal_entity_id')).toBe('le-9');
  });
});

describe('up-edge natural names', () => {
  it("an Investment's `Investor` hop resolves investor_profile_id and fetches the Legal Entity", async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ id: 'le-7', name: 'Fund I' }));

    const results = await adapter().getRelated({
      position: position('Investment', 'inv-1', { id: 'inv-1', investor_profile_id: 'le-7' }),
      fieldId: 'Investor',
      direction: 'outgoing',
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/legal-entities/le-7');
    expect(results[0].position.recordType).toBe('Legal Entity');
  });
});

describe('edge-anchored creates — parent links inject the child FKs', () => {
  it('`write le-[:Events]->` injects legal_entity_id on the POST body', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ id: 'ev-new' }, 201));

    await adapter().createRecord({
      recordType: 'Event',
      fields: { Date: '2026-07-01', Type: 'INVESTMENT_ROUND', Name: 'Seed' },
      mutationContext,
      parentLinks: [
        { recordType: 'Legal Entity', externalId: 'le-1', edgeName: 'Events' },
      ],
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/events');
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      legal_entity_id: 'le-1',
      date: '2026-07-01',
      type: 'INVESTMENT_ROUND',
      name: 'Seed',
    });
  });

  it('a tuple-path Investment create carries BOTH profiles (investee + investor)', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ id: 'inv-new' }, 201));

    await adapter().createRecord({
      recordType: 'Investment',
      fields: { 'Invested At': '2026-06-01T00:00:00.000Z' },
      mutationContext,
      parentLinks: [
        { recordType: 'Legal Entity', externalId: 'le-co', edgeName: 'Investments' },
        { recordType: 'Legal Entity', externalId: 'le-fund', edgeName: 'Investments Made' },
      ],
    });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      investment_profile_id: 'le-co',
      investor_profile_id: 'le-fund',
      invested_at: '2026-06-01T00:00:00.000Z',
    });
  });

  it('a parent link naming an unknown edge fails loudly (no silent orphan create)', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(
      adapter().createRecord({
        recordType: 'Event',
        fields: { Date: '2026-07-01', Type: 'INVESTMENT_ROUND' },
        mutationContext,
        parentLinks: [{ recordType: 'Legal Entity', externalId: 'le-1', edgeName: 'Nonsense' }],
      }),
    ).rejects.toThrow(/has no create edge 'Nonsense'/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a parent link whose edge creates a DIFFERENT type fails loudly', async () => {
    await expect(
      adapter().createRecord({
        recordType: 'Event',
        fields: { Date: '2026-07-01', Type: 'INVESTMENT_ROUND' },
        mutationContext,
        parentLinks: [{ recordType: 'Legal Entity', externalId: 'le-1', edgeName: 'Assets' }],
      }),
    ).rejects.toThrow(/creates a Asset, not a Event/);
  });
});

describe('legacy stored baseUrl (pre path-prefix-move credentials)', () => {
  // Credentials minted before /api/v1 moved onto every request path stored it
  // IN baseUrl. loadValuationsCredentials strips a trailing /api/v1 (after the
  // trailing slash) so those old rows keep resolving correctly instead of
  // doubling the prefix. A fresh credentialsId dodges the module-level creds
  // cache the other tests in this file already warmed.
  it('a trailing-slash `.../api/v1/` stored baseUrl is stripped, not doubled', async () => {
    jest.mocked(decryptToken).mockResolvedValueOnce(
      JSON.stringify({ apiKey: 'k', baseUrl: 'http://legacy.test/api/v1/' }),
    );
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(listResponse([{ id: 'le-1', name: 'NewCo' }]));

    await createNativeValuationsAdapter({
      teamId: 'team-1' as TeamId,
      credentialsId: 'cred-legacy-1',
    }).getRelated({
      position: makeStablePosition({
        adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
        recordType: META_RECORD_TYPE,
        recordId: 'meta',
        data: {},
      }),
      fieldId: 'Legal Entity',
      direction: 'outgoing',
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.origin).toBe('http://legacy.test');
    expect(url.pathname).toBe('/api/v1/valuations/legal-entities');
  });
});
