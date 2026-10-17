// The Google grants as a module's kv: `granted/<itemId>` keys over the grants
// table (here a store in memory), listed in grant order, plus the read-only
// `team/emails` the platform answers.

import { grantedItemsKv, TEAM_EMAILS_KEY, type GrantedItem, type GrantedItemsStore } from '../granted_items';

function memoryStore(): GrantedItemsStore & { rows: Array<GrantedItem & { credentialsId: string }>; emailsAsked: string[] } {
  const rows: Array<GrantedItem & { credentialsId: string }> = [];
  const emailsAsked: string[] = [];
  return {
    rows,
    emailsAsked,
    list: async (credentialsId) => rows.filter((row) => row.credentialsId === credentialsId).map(({ itemId, mimeType, name }) => ({ itemId, mimeType, name })),
    grant: async (input) => {
      const existing = rows.find((row) => row.credentialsId === input.credentialsId && row.itemId === input.itemId);
      if (existing !== undefined) Object.assign(existing, { mimeType: input.mimeType, name: input.name });
      else rows.push({ ...input });
    },
    revoke: async (input) => {
      const at = rows.findIndex((row) => row.credentialsId === input.credentialsId && row.itemId === input.itemId);
      if (at >= 0) rows.splice(at, 1);
    },
    teamEmails: async (teamId) => {
      emailsAsked.push(teamId);
      return ['ana@x.test'];
    },
  };
}

const SHEET = 'application/vnd.google-apps.spreadsheet';

describe('grantedItemsKv', () => {
  it('keeps a grant under granted/<itemId>, one credential’s only', async () => {
    const store = memoryStore();
    const kv = grantedItemsKv('cred-1', { teamId: 'team-1', store });
    await kv.set('granted/s1', { mimeType: SHEET, name: 'Pipeline' });
    await grantedItemsKv('cred-2', { teamId: 'team-1', store }).set('granted/s2', { mimeType: SHEET, name: null });
    expect(await kv.get('granted/s1')).toEqual({ mimeType: SHEET, name: 'Pipeline' });
    expect(await kv.get('granted/s2')).toBeUndefined();
    expect(store.rows).toEqual([
      { credentialsId: 'cred-1', itemId: 's1', mimeType: SHEET, name: 'Pipeline' },
      { credentialsId: 'cred-2', itemId: 's2', mimeType: SHEET, name: null },
    ]);
  });

  it('lists by prefix in grant order; a grant set again is updated in place', async () => {
    const kv = grantedItemsKv('cred-1', { teamId: 'team-1', store: memoryStore() });
    await kv.set('granted/b', { mimeType: SHEET, name: 'B' });
    await kv.set('granted/a', { mimeType: 'application/vnd.google-apps.folder', name: 'A' });
    await kv.set('granted/b', { mimeType: SHEET, name: 'B renamed' });
    expect(await kv.list('granted/')).toEqual([
      { key: 'granted/b', value: { mimeType: SHEET, name: 'B renamed' } },
      { key: 'granted/a', value: { mimeType: 'application/vnd.google-apps.folder', name: 'A' } },
    ]);
    expect(await kv.list('granted/a')).toEqual([{ key: 'granted/a', value: { mimeType: 'application/vnd.google-apps.folder', name: 'A' } }]);
    expect((await kv.list('')).map((entry) => entry.key)).toEqual(['granted/b', 'granted/a']);
    await kv.delete('granted/b');
    expect((await kv.list('granted/')).map((entry) => entry.key)).toEqual(['granted/a']);
  });

  it('refuses a value that is not a grant', async () => {
    const kv = grantedItemsKv('cred-1', { teamId: 'team-1', store: memoryStore() });
    await expect(kv.set('granted/x', { name: 'no mime' })).rejects.toThrow('a grant is { mimeType: string, name: string | null }');
  });

  it('answers team/emails from the platform for the install’s team, read-only and unlisted', async () => {
    const store = memoryStore();
    const kv = grantedItemsKv('cred-1', { teamId: 'team-9', store });
    expect(await kv.get(TEAM_EMAILS_KEY)).toEqual(['ana@x.test']);
    expect(store.emailsAsked).toEqual(['team-9']);
    await expect(kv.set(TEAM_EMAILS_KEY, ['b@x.test'])).rejects.toThrow('is read-only');
    await expect(kv.delete(TEAM_EMAILS_KEY)).rejects.toThrow('is read-only');
    expect(await kv.list('')).toEqual([]);
  });

  it('keeps no other keys', async () => {
    const kv = grantedItemsKv('cred-1', { teamId: 'team-1', store: memoryStore() });
    expect(await kv.get('cursor')).toBeUndefined();
    await expect(kv.set('cursor', 1)).rejects.toThrow('keeps only "granted/<itemId>" keys');
    await expect(kv.set('granted/', { mimeType: SHEET, name: null })).rejects.toThrow('keeps only');
  });
});
