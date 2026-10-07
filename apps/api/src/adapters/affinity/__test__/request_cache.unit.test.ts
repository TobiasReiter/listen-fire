// What the Affinity client refuses to ask twice, and what makes it ask again.
//
// Two caches with two different lifetimes, both on the client because the
// client is the one thing already keyed by the credential:
//
//   - the WORKSPACE SHAPE (fields, lists, whoami) for five minutes, because a
//     person changes it in the Affinity UI and a run never does;
//   - a RECORD, a record's field values, and a search, for the length of one
//     run segment, because inside a run the only thing that can have changed
//     them is the run itself — and the run knows what it wrote.
//
// The hazard both share is that a stale answer is indistinguishable from a
// fresh one until it decides something. So the tests below are mostly about
// what makes a cached answer go away: an explicit refresh for the shape, and
// the run's own writes for the records.

jest.mock('../../../services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../lib/slack', () => ({ sendSlackNotification: jest.fn() }));
jest.mock('../../../services/context', () => ({
  currentContext: () => ({ user: { id: 'u1' } }),
}));

import { AffinityAPIClient } from '../apiClient';
import type { TeamId } from '../../../generated/kysely/core/Team';
import { withSegment } from '../../../services/translation_graph/segment_scope';

/** One run segment's host scope, as the engine opens it for a run. */
const inARun = <T>(fn: () => Promise<T>) =>
  withSegment({ teamId: '00000000-0000-0000-0000-000000000081' as TeamId }, fn);

const BASE = 'https://affinity.test';

interface Workspace {
  fields: Record<string, unknown>[];
  lists: Record<string, unknown>[];
  persons: Record<string, Record<string, unknown>>;
  organizations: Record<string, Record<string, unknown>>;
}

function serve(workspace: Workspace): { calls: string[] } {
  const calls: string[] = [];
  global.fetch = (async (input: URL | string, init?: { method?: string; body?: string }) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}${url.search ? `?${url.searchParams.toString()}` : ''}`);

    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    if (url.pathname === '/fields') {
      const entityType = url.searchParams.get('entity_type');
      return json(
        workspace.fields.filter(
          (f) => entityType === null || String(f.entity_type) === entityType,
        ),
      );
    }
    if (url.pathname === '/lists') return json(workspace.lists);
    if (url.pathname === '/auth/whoami') {
      return json({
        tenant: { id: 1, name: 'W', subdomain: 'w' },
        user: { id: 1, firstName: 'A', lastName: 'B', email: 'a@b.co' },
        grant: { type: 't', scope: 's', createdAt: '' },
      });
    }
    if (url.pathname === '/persons' && method === 'GET') {
      const term = url.searchParams.get('term') ?? '';
      const persons = Object.values(workspace.persons).filter((p) =>
        JSON.stringify(p).includes(term),
      );
      return json({ persons });
    }
    if (url.pathname === '/organizations' && method === 'GET') {
      const term = url.searchParams.get('term') ?? '';
      const organizations = Object.values(workspace.organizations).filter((o) =>
        JSON.stringify(o).includes(term),
      );
      return json({ organizations });
    }
    if (url.pathname === '/organizations' && method === 'POST') {
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      const org = { id: 99, ...body };
      workspace.organizations['99'] = org;
      return json(org);
    }
    const person = url.pathname.match(/^\/persons\/(\d+)$/);
    if (person) {
      if (method === 'PUT') {
        const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
        workspace.persons[person[1]] = { ...workspace.persons[person[1]], ...body };
      }
      return json(workspace.persons[person[1]]);
    }
    const org = url.pathname.match(/^\/organizations\/(\d+)$/);
    if (org) return json(workspace.organizations[org[1]]);

    if (url.pathname === '/field-values' && method === 'GET') return json([]);
    if (url.pathname === '/field-values' && method === 'POST') return json({ id: 7 });

    return json({});
  }) as unknown as typeof fetch;
  return { calls };
}

const field = (id: number, name: string, entityType = 1, listId: number | null = null) => ({
  id,
  name,
  entity_type: entityType,
  value_type: 6,
  list_id: listId,
  enrichment_source: 'none',
  allows_multiple: false,
  track_changes: false,
  dropdown_options: null,
});

function workspace(): Workspace {
  return {
    fields: [field(1, 'Industry'), field(2, 'Stage', 1, 10)],
    lists: [{ id: 10, name: 'Pipeline', type: 1 }],
    persons: { '5': { id: 5, first_name: 'Ada', last_name: 'L', emails: ['ada@x.test'], organization_ids: [] } },
    organizations: { '3': { id: 3, name: 'Acme', domain: 'acme.test' } },
  };
}

const countOf = (calls: string[], prefix: string) =>
  calls.filter((c) => c.startsWith(prefix)).length;

describe('the workspace shape is asked for once per credential', () => {
  it('serves the field catalog, the lists and whoami from one request each', async () => {
    const { calls } = serve(workspace());
    const client = new AffinityAPIClient({ apiKey: 'k', baseUrl: BASE });

    await client.getFields({ type: 'ORGANIZATION' });
    await client.getFields({ type: 'ORGANIZATION' });
    await client.getAllLists();
    await client.getAllLists();
    await client.getWhoami();
    await client.getWhoami();

    expect(countOf(calls, 'GET /fields')).toBe(1);
    expect(countOf(calls, 'GET /lists')).toBe(1);
    expect(countOf(calls, 'GET /auth/whoami')).toBe(1);
  });

  it('derives a list-scoped view in memory, with no request of its own', async () => {
    const { calls } = serve(workspace());
    const client = new AffinityAPIClient({ apiKey: 'k', baseUrl: BASE });

    await client.getFields({ type: 'ORGANIZATION' });
    const scoped = await client.getFields({ type: 'ORGANIZATION', limitToListId: 10 });
    const byName = await client.getFields({ type: 'ORGANIZATION', limitToListId: 'Pipeline' });

    // The list's own field plus every unscoped one — and the list lookup that
    // turns "Pipeline" into 10 comes off the cached lists, not a request.
    expect(scoped.map((f) => f.name).sort()).toEqual(['Industry', 'Stage']);
    expect(byName.map((f) => f.name).sort()).toEqual(['Industry', 'Stage']);
    expect(countOf(calls, 'GET /fields')).toBe(1);
    expect(countOf(calls, 'GET /lists')).toBe(1);
  });

  it('two credentials do not read each other’s workspace', async () => {
    const { calls } = serve(workspace());
    const first = new AffinityAPIClient({ apiKey: 'one', baseUrl: BASE });
    const second = new AffinityAPIClient({ apiKey: 'two', baseUrl: BASE });

    await first.getFields({ type: 'ORGANIZATION' });
    await second.getFields({ type: 'ORGANIZATION' });

    expect(countOf(calls, 'GET /fields')).toBe(2);
  });

  // THE hazard of caching a schema: somebody adds a field in Affinity and the
  // author cannot see it. The TTL is the floor; the refresh is the way out.
  it('a field added after the cache filled appears once the shape is dropped', async () => {
    const live = workspace();
    const { calls } = serve(live);
    const client = new AffinityAPIClient({ apiKey: 'k', baseUrl: BASE });

    expect((await client.getFields({ type: 'ORGANIZATION' })).map((f) => f.name)).toEqual([
      'Industry',
      'Stage',
    ]);

    live.fields.push(field(3, 'Deal Source'));
    expect((await client.getFields({ type: 'ORGANIZATION' })).map((f) => f.name)).toEqual([
      'Industry',
      'Stage',
    ]);

    client.invalidateSchemaCache();
    expect((await client.getFields({ type: 'ORGANIZATION' })).map((f) => f.name)).toEqual([
      'Industry',
      'Stage',
      'Deal Source',
    ]);
    expect(countOf(calls, 'GET /fields')).toBe(2);
  });
});

describe('within one run, a record is read once', () => {
  it('serves a repeated record read from the run, and asks again in the next run', async () => {
    const { calls } = serve(workspace());
    const client = new AffinityAPIClient({ apiKey: 'k', baseUrl: BASE });

    await inARun(async () => {
      await client.getPersonById(5);
      await client.getPersonById(5);
      await client.getOrganisationById(3);
      await client.getOrganisationById(3);
    });
    expect(countOf(calls, 'GET /persons/5')).toBe(1);
    expect(countOf(calls, 'GET /organizations/3')).toBe(1);

    await inARun(async () => {
      await client.getPersonById(5);
    });
    expect(countOf(calls, 'GET /persons/5')).toBe(2);
  });

  it('is not a cache at all outside a run', async () => {
    const { calls } = serve(workspace());
    const client = new AffinityAPIClient({ apiKey: 'k', baseUrl: BASE });

    await client.getPersonById(5);
    await client.getPersonById(5);

    expect(countOf(calls, 'GET /persons/5')).toBe(2);
  });

  it('a record this run wrote reads back as it now stands, without a request', async () => {
    const { calls } = serve(workspace());
    const client = new AffinityAPIClient({ apiKey: 'k', baseUrl: BASE });

    await inARun(async () => {
      await client.getPersonById(5);
      await client.updatePerson(5, { emails: ['ada@x.test', 'ada@y.test'] });
      const after = await client.getPersonById(5);
      expect(after.emails).toEqual(['ada@x.test', 'ada@y.test']);
    });

    // The read, the write — and no third call to be told what the write said.
    expect(countOf(calls, 'GET /persons/5')).toBe(1);
    expect(countOf(calls, 'PUT /persons/5')).toBe(1);
  });

  // The property the Affinity adapter used to hold with a per-instance map:
  // reading three custom fields off one record is ONE `/field-values` request.
  // It lives here now, because the memo is what makes it true — including for
  // reads that start at the same moment, since the PROMISE is what is shared.
  it('reads three custom fields off one record with one field-values request', async () => {
    const { calls } = serve(workspace());
    const client = new AffinityAPIClient({ apiKey: 'k', baseUrl: BASE });

    await inARun(async () => {
      await Promise.all([
        client.getFieldValues({ organization_id: 3 }),
        client.getFieldValues({ organization_id: 3 }),
        client.getFieldValues({ organization_id: 3 }),
      ]);
    });

    expect(countOf(calls, 'GET /field-values')).toBe(1);
  });

  it('re-reads a record’s field values after this run writes one', async () => {
    const { calls } = serve(workspace());
    const client = new AffinityAPIClient({ apiKey: 'k', baseUrl: BASE });

    await inARun(async () => {
      await client.getFieldValues({ organization_id: 3 });
      await client.getFieldValues({ organization_id: 3 });
      expect(countOf(calls, 'GET /field-values')).toBe(1);

      await client.createFieldValue({ field_id: 1, entity_id: 3, value: 'Climate' });
      await client.getFieldValues({ organization_id: 3 });
    });

    expect(countOf(calls, 'GET /field-values')).toBe(2);
  });

  it('finds what this run created, rather than repeating its own not-found', async () => {
    const { calls } = serve(workspace());
    const client = new AffinityAPIClient({ apiKey: 'k', baseUrl: BASE });

    await inARun(async () => {
      const before = await client.findManyOrganisations({
        search: 'late-arrival.test',
        includeGlobal: false,
      });
      expect(before).toEqual([]);

      await client.createOrganisation({ name: 'Late Arrival', domain: 'late-arrival.test' });

      const after = await client.findManyOrganisations({
        search: 'late-arrival.test',
        includeGlobal: false,
      });
      expect(after.map((o) => o.id)).toEqual([99]);
    });

    // Two searches, because the create between them made the first one wrong.
    expect(countOf(calls, 'GET /organizations?term=late-arrival.test')).toBe(2);
  });
});
