// Affinity's v1 collection endpoints answer ONE PAGE at a time: `page_size`
// caps the page (500 is both the default and the maximum) and
// `next_page_token` is present exactly while more remain. A read that takes
// the first page and stops answers "the first 500 records" to a question that
// asked for all of them — silently, and only on workspaces big enough to
// notice.
//
// These tests drive the client against a mocked `fetch` that serves two pages,
// so the walk is asserted on the REQUESTS made (the page token is carried
// forward) as well as on the concatenated result.

jest.mock('movement-engine/public/log', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { AffinityAPIClient } from '../api_client';

const BASE = 'https://affinity.test';

/** Serve `pages` in order for `route`, minting a `next_page_token` for every
 *  page but the last. Returns the URLs requested, so a test can assert the
 *  walk itself rather than only its result. */
function serve(route: string, pages: Record<string, unknown>[]): { urls: string[] } {
  const urls: string[] = [];
  global.fetch = jest.fn(async (url: URL | RequestInfo) => {
    const parsed = new URL(String(url));
    urls.push(String(url));
    if (parsed.pathname !== route) throw new Error(`unexpected route ${parsed.pathname}`);
    const token = parsed.searchParams.get('page_token');
    const index = token === null ? 0 : Number(token);
    const body = {
      ...pages[index],
      ...(index < pages.length - 1 ? { next_page_token: String(index + 1) } : {}),
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { urls };
}

function client() {
  return new AffinityAPIClient({ apiKey: 'k', baseUrl: BASE });
}

describe('AffinityAPIClient root enumerations walk every page', () => {
  it('concatenates both pages of organizations and carries the page token forward', async () => {
    const { urls } = serve('/organizations', [
      { organizations: [{ id: 1, name: 'One' }] },
      { organizations: [{ id: 2, name: 'Two' }] },
    ]);

    const orgs = await client().listOrganisations();

    expect(orgs.map((o) => o.id)).toEqual([1, 2]);
    expect(urls).toHaveLength(2);
    expect(new URL(urls[0]).searchParams.get('page_size')).toBe('500');
    expect(new URL(urls[0]).searchParams.get('page_token')).toBeNull();
    expect(new URL(urls[1]).searchParams.get('page_token')).toBe('1');
  });

  it('filters Affinity\'s global dataset AFTER the full walk, not per page', async () => {
    // A global record on page one and a private one on page two: filtering the
    // first page alone would answer with nothing at all.
    serve('/organizations', [
      { organizations: [{ id: 1, name: 'Global Co', global: true }] },
      { organizations: [{ id: 2, name: 'Mine', global: false }] },
    ]);

    const orgs = await client().listOrganisations();

    expect(orgs.map((o) => o.id)).toEqual([2]);
  });

  it('walks every page of persons', async () => {
    const { urls } = serve('/persons', [
      { persons: [{ id: 10, first_name: 'A', last_name: 'One' }] },
      { persons: [{ id: 11, first_name: 'B', last_name: 'Two' }] },
    ]);

    const persons = await client().listPersons();

    expect(persons.map((p) => p.id)).toEqual([10, 11]);
    expect(urls).toHaveLength(2);
  });

  it('walks every page of opportunities', async () => {
    const { urls } = serve('/opportunities', [
      { opportunities: [{ id: 20, name: 'One' }] },
      { opportunities: [{ id: 21, name: 'Two' }] },
    ]);

    const opportunities = await client().listOpportunities();

    expect(opportunities.map((o) => o.id)).toEqual([20, 21]);
    expect(urls).toHaveLength(2);
  });

  it('narrows the organization walk with a `term`, keeping the paging', async () => {
    const { urls } = serve('/organizations', [
      { organizations: [{ id: 1, name: 'Veltha', domain: 'veltha.ai' }] },
      { organizations: [{ id: 2, name: 'Velthaco', domain: 'velthaco.com' }] },
    ]);

    const orgs = await client().listOrganisations({ term: 'veltha.ai' });

    expect(orgs.map((o) => o.id)).toEqual([1, 2]);
    expect(urls).toHaveLength(2);
    expect(urls.every((u) => new URL(u).searchParams.get('term') === 'veltha.ai')).toBe(true);
  });

  it('narrows the person walk with a `term`', async () => {
    const { urls } = serve('/persons', [{ persons: [{ id: 10, first_name: 'Jane', last_name: 'Doe' }] }]);

    const persons = await client().listPersons({ term: 'jane@acme.com' });

    expect(persons.map((p) => p.id)).toEqual([10]);
    expect(new URL(urls[0]).searchParams.get('term')).toBe('jane@acme.com');
  });
});
