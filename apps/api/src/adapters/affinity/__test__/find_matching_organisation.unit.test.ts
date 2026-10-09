// `findMatchingOrganisation` is the create path's identity search: it decides
// whether an incoming company is one Affinity already holds. It asks by
// DOMAIN first, through Affinity's `term` search — a substring match against
// the domain string Affinity stored.
//
// Affinity stores a bare host (`veltha.ai`). Searching by a URL origin
// (`https://veltha.ai`) is a substring match that can never hit, so every
// lookup for a URL-shaped domain fell through to the name search and, when the
// name had drifted at all, created a duplicate company.

jest.mock('../../../lib/anthropic', () => ({
  anthropicChat: jest.fn(async () => 'null'),
}));

import { anthropicChat } from '../../../lib/anthropic';
import { findMatchingOrganisation } from '../common';
import type { AffinityAPIClient } from '../apiClient';

const judge = jest.mocked(anthropicChat);

type Org = { id: number; name: string; domain: string; domains: string[]; global: boolean };

const VELTHA: Org = { id: 1, name: 'Veltha', domain: 'veltha.ai', domains: ['veltha.ai'], global: false };

function clientWith(orgs: Org[]) {
  const findManyOrganisations = jest.fn(async ({ search }: { search: string }) => {
    const term = search.toLowerCase();
    return orgs.filter(
      (o) => o.name.toLowerCase().includes(term) || o.domain.toLowerCase().includes(term),
    );
  });
  return { client: { findManyOrganisations } as unknown as AffinityAPIClient, findManyOrganisations };
}

describe('findMatchingOrganisation searches by the domain Affinity actually stores', () => {
  it.each([
    ['a bare domain', 'veltha.ai'],
    ['a full URL', 'https://www.veltha.ai/careers?ref=x'],
    ['a bare host with www', 'www.veltha.ai'],
    ['a domain with stray padding', '  Veltha.ai  '],
  ])('searches by the bare host for %s', async (_label, input) => {
    const { client, findManyOrganisations } = clientWith([VELTHA]);

    const match = await findMatchingOrganisation(client, { name: 'Veltha Labs', domain: input });

    expect(findManyOrganisations).toHaveBeenCalledWith({ search: 'veltha.ai', includeGlobal: true });
    expect(match).toEqual(VELTHA);
  });

  it('still matches when Affinity stored the domain URL-shaped', async () => {
    // The comparison normalizes both sides, so which side carries the scheme
    // stops mattering.
    const stored = { ...VELTHA, domain: 'https://veltha.ai', domains: ['https://veltha.ai'] };
    const { client } = clientWith([stored]);

    expect(
      await findMatchingOrganisation(client, { name: 'Veltha Labs', domain: 'veltha.ai' }),
    ).toEqual(stored);
  });

  it('falls back to the name search when the domain is not one Affinity holds', async () => {
    const { client, findManyOrganisations } = clientWith([VELTHA]);

    const match = await findMatchingOrganisation(client, { name: 'Veltha', domain: 'nowhere.example' });

    expect(match).toEqual(VELTHA);
    expect(findManyOrganisations).toHaveBeenCalledWith({ search: 'nowhere.example', includeGlobal: true });
    expect(findManyOrganisations).toHaveBeenCalledWith({ search: 'Veltha', includeGlobal: true });
  });
});

// The miss behind this (Project A, 15 Sept): a deal "Fyvie" with no website.
// The name search saw only the workspace, so Affinity's own global "Fyvie AI"
// never reached the judge and a second, empty "Fyvie" was created. The name
// path now sees global records too — but only through the judge, and the
// workspace wins whenever it has a plausible answer.
describe('findMatchingOrganisation weighs global records only through the judge', () => {
  const FYVIE_GLOBAL: Org = { id: 10, name: 'Fyvie AI', domain: 'fyvie.ai', domains: ['fyvie.ai'], global: true };
  const FYVIE_PRIVATE: Org = { id: 11, name: 'Fyvie', domain: '', domains: [], global: false };
  const FYVIE_EXACT_GLOBAL: Org = { id: 12, name: 'Fyvie', domain: 'fyvie.com', domains: ['fyvie.com'], global: true };

  beforeEach(() => {
    judge.mockReset();
    judge.mockResolvedValue('null');
  });

  function judgeInput() {
    expect(judge).toHaveBeenCalledTimes(1);
    const [call] = judge.mock.calls[0];
    if (typeof call.userMessage !== 'string') throw new Error('judge input is not text');
    return { system: call.system ?? '', query: JSON.parse(call.userMessage) };
  }

  it('a domain match beats every name candidate, without asking the judge', async () => {
    const { client } = clientWith([FYVIE_PRIVATE, FYVIE_GLOBAL]);

    const match = await findMatchingOrganisation(client, { name: 'Fyvie', domain: 'https://fyvie.ai' });

    expect(match).toEqual(FYVIE_GLOBAL);
    expect(judge).not.toHaveBeenCalled();
  });

  it('an exact workspace name beats a global record with the same exact name', async () => {
    const { client } = clientWith([FYVIE_EXACT_GLOBAL, FYVIE_PRIVATE]);

    const match = await findMatchingOrganisation(client, { name: 'Fyvie' });

    expect(match).toEqual(FYVIE_PRIVATE);
    expect(judge).not.toHaveBeenCalled();
  });

  it('never adopts a global record on an exact name alone', async () => {
    const { client } = clientWith([FYVIE_EXACT_GLOBAL]);

    const match = await findMatchingOrganisation(client, { name: 'Fyvie' });

    expect(match).toBeNull();
    expect(judgeInput().query.organizations).toEqual([
      { id: 12, name: 'Fyvie', domain: 'fyvie.com', domains: ['fyvie.com'], global: true },
    ]);
  });

  it('shows the judge workspace and global candidates, the context, and the preference for the workspace', async () => {
    const VELTHA_LIKE: Org = { id: 13, name: 'Fyvie Labs', domain: 'fyvielabs.com', domains: [], global: false };
    const { client, findManyOrganisations } = clientWith([VELTHA_LIKE, FYVIE_GLOBAL]);

    await findMatchingOrganisation(client, {
      name: 'Fyvie',
      context: 'Description: AI copilot for fertility clinics',
    });

    expect(findManyOrganisations).toHaveBeenCalledTimes(1);
    expect(findManyOrganisations).toHaveBeenCalledWith({ search: 'Fyvie', includeGlobal: true });
    const { system, query } = judgeInput();
    expect(query.query).toEqual({
      name: 'Fyvie',
      domain: null,
      context: 'Description: AI copilot for fertility clinics',
    });
    expect(query.organizations.map((o: { id: number; global: boolean }) => [o.id, o.global])).toEqual([
      [13, false],
      [10, true],
    ]);
    expect(system).toContain('Prefer a workspace candidate (global: false) over a global candidate');
  });

  // Project A's deal write carries only a name and a domain, so the case being
  // fixed reaches the judge with no context at all.
  it('adopts the global "Fyvie AI" for "Fyvie" with no context, under the near-exact rule', async () => {
    judge.mockResolvedValue('10');
    const { client } = clientWith([FYVIE_GLOBAL]);

    const match = await findMatchingOrganisation(client, { name: 'Fyvie' });

    expect(match).toEqual(FYVIE_GLOBAL);
    const { system, query } = judgeInput();
    expect(query.query).toEqual({ name: 'Fyvie', domain: null, context: null });
    expect(system).toContain('Accept a global candidate when the name is distinctive and near-exact');
    expect(system).toContain('a brand-like token plus a generic suffix such as "AI", "Labs", "Technologies"');
    expect(system).toContain('when query.context or query.domain is supplied, it does not contradict the candidate');
  });

  it('tells the judge a generic name like "Atlas" never adopts a global record without a corroborating domain', async () => {
    const ATLAS_GLOBAL: Org = { id: 20, name: 'Atlas AI', domain: 'atlas.ai', domains: ['atlas.ai'], global: true };
    const { client } = clientWith([ATLAS_GLOBAL]);

    const match = await findMatchingOrganisation(client, { name: 'Atlas' });

    expect(match).toBeNull();
    const { system, query } = judgeInput();
    expect(query.organizations).toEqual([
      { id: 20, name: 'Atlas AI', domain: 'atlas.ai', domains: ['atlas.ai'], global: true },
    ]);
    expect(system).toContain(
      'Never adopt a global candidate for a generic or common name (e.g. "Acme", "Nova", "Atlas") without a corroborating domain',
    );
  });

  it('adopts a global record when the judge picks it', async () => {
    judge.mockResolvedValue('10');
    const { client } = clientWith([FYVIE_GLOBAL]);

    const match = await findMatchingOrganisation(client, {
      name: 'Fyvie',
      context: 'Description: AI copilot for fertility clinics',
    });

    expect(match).toEqual(FYVIE_GLOBAL);
  });

  it('ignores a judge answer that names no candidate', async () => {
    judge.mockResolvedValue('999');
    const { client } = clientWith([FYVIE_GLOBAL]);

    expect(await findMatchingOrganisation(client, { name: 'Fyvie' })).toBeNull();
  });

  it('returns null without asking the judge when nothing comes back', async () => {
    const { client } = clientWith([]);

    expect(await findMatchingOrganisation(client, { name: 'Fyvie' })).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });
});
