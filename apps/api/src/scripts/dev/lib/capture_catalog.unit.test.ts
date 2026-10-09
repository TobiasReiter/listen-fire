import type { InstanceSchema } from 'movement-lang';

import {
  describableAdapters,
  handbookCaptureSources,
  mergeInstanceSchemas,
  rewriteConnectionNames,
} from './capture_catalog';

const CONNECTIONS: Record<string, string> = {
  attio: 'Dev Loop Attio',
  slack: 'Dev Loop Slack',
};
const connectionForAdapter = (adapter: string) => CONNECTIONS[adapter];

describe('rewriteConnectionNames', () => {
  it('rewires an illustrative connection onto the workspace one, import and construction', () => {
    const { source, unresolved } = rewriteConnectionNames({
      source: [
        'import { attio } from adapters',
        'import { acme } from credentials',
        'crm = attio(credentials: acme)',
        'movement m(x: <crm-[:`Webhook Event`]->>) { }',
      ].join('\n'),
      connectionForAdapter,
    });
    expect(source).toContain('import { `Dev Loop Attio` } from credentials');
    expect(source).toContain('crm = attio(credentials: `Dev Loop Attio`)');
    expect(unresolved).toEqual([]);
  });

  it('rewires each adapter to its OWN connection', () => {
    const { source } = rewriteConnectionNames({
      source: [
        'import { attio, slack } from adapters',
        'import { main_crm, team_chat } from credentials',
        'crm = attio(credentials: main_crm)',
        'chat = slack(credentials: team_chat)',
      ].join('\n'),
      connectionForAdapter,
    });
    expect(source).toContain('import { `Dev Loop Attio`, `Dev Loop Slack` } from credentials');
    expect(source).toContain('attio(credentials: `Dev Loop Attio`)');
    expect(source).toContain('slack(credentials: `Dev Loop Slack`)');
  });

  it('leaves a name alone (and reports it) when the workspace has no such connection', () => {
    const source = [
      'import { `native-valuations` } from adapters',
      "import { `Toni's Valuations` } from credentials",
      "vals = `native-valuations`(credentials: `Toni's Valuations`)",
    ].join('\n');
    const rewritten = rewriteConnectionNames({ source, connectionForAdapter });
    expect(rewritten.source).toBe(source);
    expect(rewritten.unresolved).toEqual([
      { adapter: 'native-valuations', authored: "Toni's Valuations" },
    ]);
  });

  it('does not rewrite a name that merely shares a prefix', () => {
    const { source } = rewriteConnectionNames({
      source: [
        'import { attio } from adapters',
        'import { acme } from credentials',
        'acme_records = attio(credentials: acme)',
      ].join('\n'),
      connectionForAdapter,
    });
    expect(source).toContain('acme_records = attio(credentials: `Dev Loop Attio`)');
  });
});

describe('mergeInstanceSchemas', () => {
  const undescribed: InstanceSchema = {
    positions: { Companies: { properties: {}, edges: {}, undescribed: true } },
    collections: { Companies: { target: 'Companies' } },
    writableRoots: {},
  };
  const described: InstanceSchema = {
    positions: { Companies: { properties: { Name: 'text' }, edges: {} } },
    collections: { Companies: { target: 'Companies' } },
    writableRoots: { Companies: { fields: { Name: 'text' }, resultShape: {} } },
  };

  it('a described position beats an undescribed one, whichever side it came from', () => {
    expect(mergeInstanceSchemas(undescribed, described).positions.Companies).toEqual(
      described.positions.Companies,
    );
    expect(mergeInstanceSchemas(described, undescribed).positions.Companies).toEqual(
      described.positions.Companies,
    );
  });

  it('unions positions, collections, write shapes and program-derived grafts', () => {
    const merged = mergeInstanceSchemas(
      {
        positions: { Check: { properties: {}, edges: {} } },
        collections: { Check: { target: 'Check' } },
        writableRoots: { Check: { fields: {}, resultShape: {} } },
        genericLandings: { 'k1': 'Choose Response (Seed)' },
      },
      {
        positions: { Choose: { properties: {}, edges: {} } },
        collections: { Choose: { target: 'Choose' } },
        writableRoots: { Choose: { fields: {}, resultShape: {} } },
        genericLandings: { 'k2': 'Choose Response (Series A)' },
      },
    );
    expect(Object.keys(merged.positions).sort()).toEqual(['Check', 'Choose']);
    expect(merged.collections).toEqual({
      Check: { target: 'Check' },
      Choose: { target: 'Choose' },
    });
    expect(Object.keys(merged.writableRoots).sort()).toEqual(['Check', 'Choose']);
    expect(merged.genericLandings).toEqual({
      k1: 'Choose Response (Seed)',
      k2: 'Choose Response (Series A)',
    });
  });

  it('keeps scope-invariant facts rather than re-deciding them per source', () => {
    const merged = mergeInstanceSchemas(
      { ...described, eventPosition: 'Webhook Event', supportsInPlaceUpdate: true },
      { ...described, eventPosition: 'Webhook Event' },
    );
    expect(merged.eventPosition).toBe('Webhook Event');
    expect(merged.supportsInPlaceUpdate).toBe(true);
  });
});

describe('handbookCaptureSources', () => {
  it('yields every chapter probe, labelled by chapter and construct', () => {
    const sources = handbookCaptureSources();
    // The demand set is the handbook's own runnable examples; a floor so the
    // capture can never silently shrink to a handful of probes.
    expect(sources.length).toBeGreaterThanOrEqual(35);
    for (const entry of sources) {
      expect(entry.label).toMatch(/ — /);
      expect(entry.source.length).toBeGreaterThan(0);
    }
  });
});

describe('describableAdapters', () => {
  const requires: Record<string, boolean> = { email: false, telegram: true, kg: true };
  const select = (constructed: string[], connected: string[]) =>
    describableAdapters({
      constructed,
      requiresConnection: (adapter) => requires[adapter],
      hasConnection: (adapter) => connected.includes(adapter),
    });

  it('drops names that are not adapters (plugins)', () => {
    expect(select(['email', 'fetch_url'], [])).toEqual(['email']);
  });

  it('drops a credentialed adapter the workspace has no connection for', () => {
    expect(select(['kg', 'telegram'], ['telegram'])).toEqual(['telegram']);
  });

  it('keeps a connected adapter, so its missing schema stays a loud failure', () => {
    expect(select(['telegram', 'telegram'], ['telegram'])).toEqual(['telegram']);
  });
});
