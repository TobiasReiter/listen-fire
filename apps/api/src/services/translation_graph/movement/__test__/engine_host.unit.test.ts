// Where the production host stores file text: the team's `raw_text` table for
// a firing, and nowhere durable for a test run.

const resolverStores: unknown[] = [];
jest.mock('../file_text', () => ({
  makeFileTextResolver: (store: unknown) => {
    resolverStores.push(store);
    return async () => ({ unreadable: 'no_text' });
  },
}));

const postgresStore = { getOrCreateId: jest.fn(async () => 'pg-id') };
const postgresRawTextStore = jest.fn((_teamId: string) => postgresStore);
jest.mock('../raw_text_store', () => ({
  ...jest.requireActual('../raw_text_store'),
  postgresRawTextStore: (teamId: string) => postgresRawTextStore(teamId),
}));

import type { TeamId } from '../../../../generated/kysely/core/Team';
import { productionEngineHost } from '../engine_host';
import { inMemoryRawTextStore } from '../raw_text_store';

const TEAM_ID = 'team-1' as TeamId;
const catalog = { resolveCredentialId: () => undefined, resolveFile: () => undefined };

beforeEach(() => {
  resolverStores.length = 0;
  postgresRawTextStore.mockClear();
});

describe('productionEngineHost — file text storage', () => {
  it("a firing's host stores file text in the team's raw_text table", () => {
    productionEngineHost({ teamId: TEAM_ID, catalog });
    expect(postgresRawTextStore).toHaveBeenCalledWith(TEAM_ID);
    expect(resolverStores).toEqual([postgresStore]);
  });

  it('a host given an in-memory store never builds the Postgres one', () => {
    const rawText = inMemoryRawTextStore();
    productionEngineHost({ teamId: TEAM_ID, catalog, rawText });
    expect(postgresRawTextStore).not.toHaveBeenCalled();
    expect(resolverStores).toEqual([rawText]);
  });
});

describe('inMemoryRawTextStore', () => {
  it('gives the same id to the same text and a new one to different text', async () => {
    const store = inMemoryRawTextStore();
    const a = await store.getOrCreateId('  deck text ');
    expect(await store.getOrCreateId('deck text')).toBe(a);
    expect(await store.getOrCreateId('other text')).not.toBe(a);
  });
});
