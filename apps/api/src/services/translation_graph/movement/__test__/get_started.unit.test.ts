// getStarted is the whole first read of a build, so its size is a budget, not
// an accident: the systems digest is capped per system and in total, and the
// lean answer — front page, team, systems — stays near 3k tokens for a team
// with the usual systems connected.

import type { TeamRef } from 'principal';
import type { WalkedEdge, WalkedNode, WalkedProperty } from '../walk';

const snapshotMock = jest.fn();
const describeMock = jest.fn();
const landingsMock = jest.fn();
jest.mock('../catalog', () => ({
  movementCatalogSnapshotForTeam: (...args: unknown[]) => snapshotMock(...args),
  describeMovementInstance: (...args: unknown[]) => describeMock(...args),
  describeMovementLandings: (...args: unknown[]) => landingsMock(...args),
}));

import type { TeamId } from '../../../../generated/kysely/core/Team';

import {
  CONNECTIONS_DIGEST_CHAR_CAP,
  SYSTEM_DIGEST_CHAR_CAP,
  compactType,
  renderConnectionsDigest,
  renderSystemDigest,
  type SystemDigestInput,
} from '../connection_digest';
import { renderGetStarted } from '../get_started';

const text = (extra: Partial<WalkedProperty> = {}): WalkedProperty => ({
  type: 'text',
  readable: true,
  writable: true,
  required: false,
  ...extra,
});

function edge(name: string, properties: Record<string, WalkedProperty>, extra: Partial<WalkedEdge> = {}): WalkedEdge {
  return {
    name,
    cardinality: 'many',
    readable: true,
    writable: true,
    position: `-[:\`${name}\`]->`,
    target: { name, properties },
    ...extra,
  };
}

const root = (edges: WalkedEdge[]): WalkedNode => ({ name: 'root', position: '', properties: {}, edges });

const credential = { name: 'credentials', kind: 'credential' as const, required: true };

const ATTIO: SystemDigestInput = {
  system: 'attio',
  spec: {
    constructionArgs: [credential],
    triggerConfig: ['events'],
    triggerConfigOptions: { events: ['record.created', 'record.updated', 'record.deleted'] },
  },
  connections: ['acme'],
  node: root([
    edge('Companies', {
      Description: text(),
      Name: text({ required: true }),
      Domains: text({ type: { kind: 'list', of: 'text' } }),
      Stage: text({ type: { kind: 'enum', options: ['Lead', 'Qualified', 'Won', 'Lost', 'Dormant'] } }),
      'Record ID': text({ writable: false }),
    }),
    edge('People', { Email: text(), Name: text() }),
    edge('Deals', {}, { target: { name: 'Deals', stub: true, hint: 'describe it' } }),
  ]),
  schema: {
    positions: {},
    collections: {},
    writableRoots: {
      Companies: { fields: {}, resultShape: {}, nativeUniqueness: [['Domains']] },
      People: { fields: {}, resultShape: {}, nativeUniqueness: [['Email']] },
    },
  },
};

const EMAIL: SystemDigestInput = {
  system: 'email',
  spec: { constructionArgs: [], triggerConfig: ['key'], triggerConfigRequired: ['key'] },
  connections: [],
  node: root([
    edge(
      'Email',
      { From: text({ writable: false }), Subject: text({ writable: false }), Body: text({ writable: false }) },
      { writable: false, fires: true },
    ),
  ]),
};

/** A system as wide as a big CRM: many record types, each with many fields. */
function wideSystem(system: string): SystemDigestInput {
  const fields = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`Field ${i}`, text()]));
  return {
    system,
    spec: { constructionArgs: [credential] },
    connections: [`${system}_main`],
    node: root(Array.from({ length: 30 }, (_, i) => edge(`Object Type ${i}`, fields))),
  };
}

describe('the connections digest', () => {
  it('spells how to construct each system and what a listen on it says', () => {
    const block = renderSystemDigest(ATTIO);
    expect(block).toContain('### attio — `attio(credentials: acme)`');
    expect(block).toContain('- listen { events: record.created|record.updated|record.deleted }');
    expect(renderSystemDigest(EMAIL)).toContain('### email — `email()`\n- listen { key! }');
  });

  it('lists record types with fields, required and identifying ones first, marked', () => {
    const block = renderSystemDigest(ATTIO);
    expect(block).toContain(
      '- Companies [rw]: Name text!, Domains text[]*, Description text, Stage enum(Lead|Qualified|Won|Lost|…+1), `Record ID` text~',
    );
    expect(block).toContain('- People [rw]: Email text*, Name text');
    expect(block).toContain('- Deals [rw]: fields not loaded — describe it');
    expect(renderSystemDigest(EMAIL)).toContain('- Email [r fires]: From text, Subject text, Body text');
  });

  it('names a system it could not describe, and where to look', () => {
    const block = renderSystemDigest({ ...ATTIO, node: undefined, note: 'its records took too long to load' });
    expect(block).toContain('- its records took too long to load — describeConnection("attio") for more');
  });

  it('keeps every system under its cap, cutting fields before types', () => {
    const block = renderSystemDigest(wideSystem('crm'));
    expect(block.length).toBeLessThanOrEqual(SYSTEM_DIGEST_CHAR_CAP);
    expect(block).toContain('- `Object Type 29` [rw]: 40 fields');
    expect(block).toContain('fields cut for space — describeConnection({ system: "crm", position: ');
  });

  it('over budget, keeps the fields of the types you write to, and cuts the read-only ones first', () => {
    const fields = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Field ${i}`, text()]));
    const readOnly = Array.from({ length: 8 }, (_, i) => edge(`Lookup ${i}`, fields, { writable: false }));
    const writable = [edge('Companies', fields), edge('People', fields)];
    const block = renderSystemDigest({
      system: 'crm',
      spec: { constructionArgs: [credential] },
      connections: ['crm'],
      node: root([...readOnly, ...writable]),
    });
    expect(block.length).toBeLessThanOrEqual(SYSTEM_DIGEST_CHAR_CAP);
    expect(block).toContain('- Companies [rw]: `Field 0` text,');
    expect(block).toContain('- People [rw]: `Field 0` text,');
    expect(block).toContain('- `Lookup 7` [r]: 10 fields');
  });

  it('marks a name that needs backticks, and a field that is written but never read back', () => {
    const block = renderSystemDigest({
      ...ATTIO,
      node: root([edge('VC Deal Flow', { listName: text({ readable: false, required: true }), 'Team Size': text({ type: 'number' }) })]),
    });
    expect(block).toContain('- `VC Deal Flow` [rw]: listName text! (write-only), `Team Size` number');
  });

  it('keeps the whole digest under its cap however many systems are connected', () => {
    const systems = Array.from({ length: 20 }, (_, i) => wideSystem(`system_${i}`));
    const digest = renderConnectionsDigest({ systems, notConnected: ['airtable', 'google_sheets'] });
    expect(digest.length).toBeLessThanOrEqual(CONNECTIONS_DIGEST_CHAR_CAP);
    expect(digest).toContain('### system_0 — ');
    expect(digest).toContain('Not connected yet (connectSystem first): airtable, google_sheets.');
  });

  it('spells types compactly', () => {
    expect(compactType({ kind: 'maybeAbsent', of: { kind: 'list', of: 'number' } })).toBe('number[]?');
    expect(compactType({ kind: 'enum', options: ['a'], open: {} })).toBe('enum(a|…)');
    expect(compactType({ kind: 'enum', options: ['a', 'b', 'c', 'd', 'e', 'f'] })).toBe('enum(a|b|c|d|…+2)');
    expect(compactType('datetime')).toBe('datetime');
  });
});

const TEAM: TeamRef = { teamId: 'team-1', name: 'Acme Ventures', access: 'write', isPersonal: false };

function stubTeamCatalog() {
  snapshotMock.mockResolvedValue({
    snapshot: {
      adapters: {
        attio: ATTIO.spec,
        slack: { constructionArgs: [credential], triggerConfig: ['events', 'channels'] },
        airtable: { constructionArgs: [credential], connect: 'oauth' },
        email: EMAIL.spec,
        ask: { constructionArgs: [] },
        manual: { constructionArgs: [] },
      },
      credentials: { acme: { adapters: ['attio'] }, team_chat: { adapters: ['slack'] } },
    },
    notes: [],
    remoteConnections: {},
  });
  describeMock.mockImplementation(async ({ adapter }: { adapter: string }) => {
    switch (adapter) {
      case 'attio':
        return { node: ATTIO.node, schema: ATTIO.schema, notes: [] };
      case 'email':
        return { node: EMAIL.node, schema: null, notes: [] };
      case 'slack':
        return {
          node: root([
            edge('Messages', { Text: text({ required: true }), Channel: text({ required: true }) }, { fires: true }),
          ]),
          schema: null,
          notes: [],
        };
      default:
        return { node: root([]), schema: null, notes: [] };
    }
  });
}

describe('getStarted', () => {
  beforeEach(() => {
    snapshotMock.mockReset();
    describeMock.mockReset();
    landingsMock.mockReset();
    landingsMock.mockResolvedValue({});
  });

  it("describes the record types a root stubbed, so Attio's main types arrive with their fields", async () => {
    stubTeamCatalog();
    const stub = (name: string): WalkedEdge =>
      edge(name, {}, { target: { name, stub: true, hint: `describe this connection at "-[:${name}]->"` } });
    describeMock.mockImplementation(async ({ adapter }: { adapter: string }) =>
      adapter === 'attio'
        ? {
            node: root([
              stub('Companies'),
              stub('People'),
              { ...stub('VC Deal Flow'), writable: false },
              edge('Webhook Event', { action: text({ writable: false }) }, { writable: false, readable: false, fires: true }),
            ]),
            schema: null,
            notes: [],
          }
        : { node: root([]), schema: null, notes: [] },
    );
    landingsMock.mockResolvedValue({
      Companies: {
        name: 'Companies',
        properties: { Name: text({ required: true }), Domains: text({ type: { kind: 'list', of: 'text' } }) },
        unique: [['Domains']],
      },
      People: { name: 'People', properties: { Name: text({ required: true }), Email: text() }, unique: [['Email']] },
    });

    const page = await renderGetStarted({ teams: [TEAM], teamId: 'team-1' as TeamId });

    expect(landingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: 'attio', credentialName: 'acme', types: ['Companies', 'People', 'VC Deal Flow'] }),
    );
    expect(page).toContain('- Companies [rw]: Name text!, Domains text[]*');
    expect(page).toContain('- People [rw]: Name text!, Email text*');
    // Not described (the source had nothing for it): still named, one hop away.
    expect(page).toContain('- `VC Deal Flow` [r]: fields not loaded — describe it');
    expect(page).toContain('- `Webhook Event` [fires]: action text');
  });

  it('keeps the stubs, named, when describing them fails', async () => {
    stubTeamCatalog();
    describeMock.mockImplementation(async () => ({
      node: root([edge('Deals', {}, { target: { name: 'Deals', stub: true, hint: 'describe it' } })]),
      schema: null,
      notes: [],
    }));
    landingsMock.mockRejectedValue(new Error('rate limited'));
    const page = await renderGetStarted({ teams: [TEAM], teamId: 'team-1' as TeamId });
    expect(page).toContain('- Deals [rw]: fields not loaded — describe it');
  });

  it('answers with the team, its systems — connected ones first — and the front page', async () => {
    stubTeamCatalog();
    const page = await renderGetStarted({ teams: [TEAM], teamId: 'team-1' as TeamId });

    expect(page.startsWith('## Team: Acme Ventures — `team-1`')).toBe(true);
    expect(page.indexOf('### attio')).toBeLessThan(page.indexOf('### email'));
    expect(page).toContain('### slack — `slack(credentials: team_chat)`');
    expect(page).toContain('Not connected yet (connectSystem first): airtable.');
    expect(page).toContain('## Writing automations: it is TypeScript, except…');
    expect(describeMock).toHaveBeenCalledWith(expect.objectContaining({ adapter: 'attio', credentialName: 'acme' }));
  });

  it('stays near 3k tokens for a team with the usual systems', async () => {
    stubTeamCatalog();
    const page = await renderGetStarted({ teams: [TEAM], teamId: 'team-1' as TeamId });
    expect(Math.ceil(page.length / 4)).toBeLessThanOrEqual(3_200);
  });

  it('lists every team with its id, and no systems, when several span the connection and none is named', async () => {
    const page = await renderGetStarted({
      teams: [TEAM, { teamId: 'team-2', name: 'Me', access: 'write', isPersonal: true }],
      teamId: null,
    });
    expect(page).toContain('- Acme Ventures — `team-1`\n- Me — `team-2` (personal)');
    expect(page).not.toContain('## Systems');
    expect(snapshotMock).not.toHaveBeenCalled();
  });
});
