// Identity and current values, the three things a `write … unique by (…)`
// against Valuations depends on:
//
//   - `resolveEntity` has to SEARCH. Valuations rows are addressed by
//     Listen-Fire's own UUIDs, so an author's `unique by (`Name`)` is the only
//     identity there is; with no search the resolve returned nothing and "find
//     the record or create it" quietly became "create it", once per message.
//   - `readRecord` has to answer in the currency it was asked in. The engine
//     asks for the SURFACE names it is about to write and compares them for
//     `?:` and no-op suppression; answering in REST column names reads as
//     "every field is empty", so set-if-empty overwrote what was already there.
//   - a create must not send a field with nothing in it. `Field ?: <absent>`
//     resolves to null, the entity create schemas take an absent optional field
//     and refuse an explicit null, and the whole write fails over a field the
//     source simply did not state.

// logger → services/context → casl crashes at module load; stub it (mirrors
// the sibling tests).
jest.mock('../../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
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
  decryptToken: jest.fn(async () => JSON.stringify({ apiKey: 'k', baseUrl: 'http://vals.test' })),
}));

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MutationContext } from '../../mutation_context';

import { createNativeValuationsAdapter } from '../native_valuations';

const adapter = () =>
  createNativeValuationsAdapter({ teamId: 'team-1' as TeamId, credentialsId: 'cred-1' });

const mutationContext = {} as MutationContext;

const listResponse = (rows: Array<Record<string, unknown>>) =>
  new Response(JSON.stringify({ data: rows, meta: { count: rows.length, offset: 0, limit: 100 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const recordResponse = (row: Record<string, unknown>) =>
  new Response(JSON.stringify({ data: row }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => jest.restoreAllMocks());

describe('NativeValuationsAdapter.resolveEntity — an author-declared identity is a search', () => {
  it('searches the collection by name and answers with the row that matches exactly', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        listResponse([
          { id: 'le-1', name: 'Acme Widgets Holdings', type: 'COMPANY' },
          { id: 'le-2', name: 'Acme Widgets', type: 'PORTFOLIO_COMPANY' },
        ]),
      );

    const result = await adapter().resolveEntity({
      record: { Name: 'Acme Widgets', Type: 'COMPANY' },
      recordType: 'Legal Entity',
      candidates: [],
      constraints: { any: [{ all: [{ field: 'Name' }] }] },
    });

    const url = String((fetchSpy.mock.calls[0] ?? [])[0]);
    expect(url).toContain('/api/v1/valuations/legal-entities');
    expect(url).toContain('search=Acme+Widgets');
    // The list filter is a case-insensitive CONTAINS, so it also returns the
    // holdings company; the equality that decides identity is applied here.
    expect(result.candidates).toEqual([
      { adapterType: 'native-valuations', externalId: 'le-2', data: { Name: 'Acme Widgets' } },
    ]);
  });

  it('answers with nothing when no row carries the asserted value', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(listResponse([{ id: 'le-1', name: 'Other Co' }]));

    const result = await adapter().resolveEntity({
      record: { Name: 'Beta Labs' },
      recordType: 'Legal Entity',
      candidates: [],
      constraints: { any: [{ all: [{ field: 'Name' }] }] },
    });

    expect(result.candidates).toEqual([]);
  });

  it('does not search when the write declares no identity', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    const result = await adapter().resolveEntity({
      record: { Name: 'Beta Labs' },
      recordType: 'Legal Entity',
      candidates: [],
      constraints: { any: [] },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
  });
});

describe('NativeValuationsAdapter.resolveEntity — a FUZZY name is a similarity shortlist', () => {
  it('searches by the fuzzy name and keeps the rows the route returned, unfiltered', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      listResponse([
        { id: 'le-1', name: 'Acme Limited', also_known_as: 'Acme, ACME Ltd', other_names: null },
        { id: 'le-2', name: 'Acme Widgets', legal_name: 'Acme Widgets Ltd' },
      ]),
    );

    const result = await adapter().resolveEntity({
      record: { Name: 'Acme Ltd' },
      recordType: 'Legal Entity',
      candidates: [],
      constraints: { any: [{ all: [{ field: 'Name', fuzzy: true }] }] },
    });

    expect(String((fetchSpy.mock.calls[0] ?? [])[0])).toContain('search=Acme+Ltd');
    // Neither row equals "Acme Ltd"; both reach arbitration, carrying the names
    // that put them on the shortlist so the judge can see the alias.
    expect(result.candidates).toEqual([
      {
        adapterType: 'native-valuations',
        externalId: 'le-1',
        data: { Name: 'Acme Limited', 'Also Known As': 'Acme, ACME Ltd' },
      },
      {
        adapterType: 'native-valuations',
        externalId: 'le-2',
        data: { Name: 'Acme Widgets', 'Legal Name': 'Acme Widgets Ltd' },
      },
    ]);
  });

  it('still filters an exact component in the same group', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      listResponse([
        { id: 'le-1', name: 'Acme Limited', city: 'Leeds' },
        { id: 'le-2', name: 'Acme Widgets', city: 'York' },
      ]),
    );

    const result = await adapter().resolveEntity({
      record: { Name: 'Acme Ltd', City: 'york' },
      recordType: 'Legal Entity',
      candidates: [],
      constraints: { any: [{ all: [{ field: 'Name', fuzzy: true }, { field: 'City' }] }] },
    });

    expect(result.candidates.map((c) => c.externalId)).toEqual(['le-2']);
  });

  it('searches by a fuzzy Also Known As', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(listResponse([{ id: 'le-1', name: 'Acme Limited', also_known_as: 'Acme, ACME Ltd' }]));

    const result = await adapter().resolveEntity({
      record: { 'Also Known As': 'ACME' },
      recordType: 'Legal Entity',
      candidates: [],
      constraints: { any: [{ all: [{ field: 'Also Known As', fuzzy: true }] }] },
    });

    expect(String((fetchSpy.mock.calls[0] ?? [])[0])).toContain('search=ACME');
    expect(result.candidates.map((c) => c.externalId)).toEqual(['le-1']);
  });
  it('refuses FUZZY on a field the record type does not declare fuzzy, before searching', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    await expect(
      adapter().resolveEntity({
        record: { Name: 'Acme Ltd', City: 'York' },
        recordType: 'Legal Entity',
        candidates: [],
        constraints: { any: [{ all: [{ field: 'Name', fuzzy: true }, { field: 'City', fuzzy: true }] }] },
      }),
    ).rejects.toThrow('FUZZY on `City` is not supported by Legal Entity');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('NativeValuationsAdapter.resolveEntity — a website is one identity however it is written', () => {
  it('matches https://www.acme.com/ against acme.com', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      listResponse([
        { id: 'le-1', name: 'Acme Limited', personal_website: 'acme.com' },
        { id: 'le-2', name: 'Acme Widgets', personal_website: 'acmewidgets.com' },
      ]),
    );

    const result = await adapter().resolveEntity({
      record: { Website: 'https://www.acme.com/' },
      recordType: 'Legal Entity',
      candidates: [],
      constraints: { any: [{ all: [{ field: 'Website' }] }] },
    });

    expect(result.candidates.map((c) => c.externalId)).toEqual(['le-1']);
  });
});

describe("NativeValuationsAdapter.readRecord — current values in the write's currency", () => {
  it('keys the answer by the surface names it was asked for', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        recordResponse({ id: 'le-1', name: 'Acme Widgets', type: 'PORTFOLIO_COMPANY' }),
      );

    const current = await adapter().readRecord!({
      recordType: 'Legal Entity',
      externalId: 'le-1',
      fieldIds: ['Name', 'Type'],
    });

    expect(current).toEqual({ Name: 'Acme Widgets', Type: 'PORTFOLIO_COMPANY' });
  });
});

describe('NativeValuationsAdapter.createRecord — a create sends only what the source had', () => {
  it('omits a field with nothing in it rather than posting an explicit null', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ id: 'le-9' }));

    await adapter().createRecord({
      recordType: 'Legal Entity',
      fields: { Name: 'Gamma Tools', City: 'Leeds', Description: null },
      mutationContext,
    });

    const body = JSON.parse(String(((fetchSpy.mock.calls[0] ?? [])[1] as RequestInit).body));
    expect(body.name).toBe('Gamma Tools');
    expect(body.city).toBe('Leeds');
    expect(body).not.toHaveProperty('description');
  });
});
