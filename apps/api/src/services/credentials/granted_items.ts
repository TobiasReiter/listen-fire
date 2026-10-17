// The single store behind the Google pickers (Sheets + Drive). Under the
// drive.file scope there is no list-all API; the Picker grants access one item
// at a time and each pick is recorded here against the Google credential, tagged
// with its real Drive mime_type so each adapter filters to what it cares about.
import type { ModuleKv } from 'module-kit';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';
import type { TeamId } from '../../generated/kysely/core/Team';

import { z } from 'zod';

import { getAutomationsQb, getCoreQb } from '../../lib/kysely';

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';

export interface GrantedItem {
  itemId: string;
  mimeType: string;
  name: string | null;
}

export async function listGrantedItems(
  credentialsId: string,
  opts?: { mimeTypes?: string[] },
): Promise<GrantedItem[]> {
  let q = getAutomationsQb(['google_granted_item'])
    .selectFrom('google_granted_item')
    .where('credentials_id', '=', credentialsId as ExternalServiceCredentialsId)
    .select(['item_id', 'mime_type', 'name'])
    .orderBy('created_at', 'asc');
  if (opts?.mimeTypes && opts.mimeTypes.length > 0) {
    q = q.where('mime_type', 'in', opts.mimeTypes);
  }
  const rows = await q.execute();
  return rows.map((r) => ({ itemId: r.item_id, mimeType: r.mime_type, name: r.name }));
}

export async function grantItem(input: {
  credentialsId: string;
  itemId: string;
  mimeType: string;
  name?: string | null;
}): Promise<void> {
  await getAutomationsQb(['google_granted_item'])
    .insertInto('google_granted_item')
    .values({
      credentials_id: input.credentialsId as ExternalServiceCredentialsId,
      item_id: input.itemId,
      mime_type: input.mimeType,
      name: input.name ?? null,
    })
    .onConflict((oc) =>
      oc.columns(['credentials_id', 'item_id']).doUpdateSet({
        name: input.name ?? null,
        mime_type: input.mimeType,
      }),
    )
    .execute();
}

export async function revokeItem(input: {
  credentialsId: string;
  itemId: string;
}): Promise<void> {
  await getAutomationsQb(['google_granted_item'])
    .deleteFrom('google_granted_item')
    .where('credentials_id', '=', input.credentialsId as ExternalServiceCredentialsId)
    .where('item_id', '=', input.itemId)
    .execute();
}

// ── The grants as a module's kv ─────────────────────────────────────────────
// A Google module (Sheets, Drive) keeps the items its user granted as per-
// install state, `ctx.kv`; on the platform that state is this table, so a
// grant made through the picker, the connect flow or a module is one row
// either way. Keys `granted/<itemId>` hold `{ mimeType, name }`. One more key
// is the platform's to answer and read-only: `team/emails`, the primary
// emails of the install's team (who a created file is shared with). It is
// answered by `get` and not listed, since nothing stored it.

const GRANTED_PREFIX = 'granted/';
export const TEAM_EMAILS_KEY = 'team/emails';

const grantedValue = z.object({ mimeType: z.string().min(1), name: z.string().nullable() });

/** What the kv reads and writes through: this table, or a test's own. */
export interface GrantedItemsStore {
  list(credentialsId: string): Promise<GrantedItem[]>;
  grant(input: { credentialsId: string; itemId: string; mimeType: string; name: string | null }): Promise<void>;
  revoke(input: { credentialsId: string; itemId: string }): Promise<void>;
  teamEmails(teamId: string): Promise<string[]>;
}

/** The primary email of every user whose default team is `teamId`. */
export async function teamPrimaryEmails(teamId: string): Promise<string[]> {
  const rows = await getCoreQb(['user', 'user_email'])
    .selectFrom('user as u')
    .innerJoin('user_email as ue', (j) => j.onRef('ue.user_id', '=', 'u.id').on('ue.is_primary', '=', true))
    .where('u.default_team_id', '=', teamId as TeamId)
    .select(['ue.email'])
    .execute();
  return rows.map((row) => String(row.email));
}

export const postgresGrantedItems: GrantedItemsStore = {
  list: (credentialsId) => listGrantedItems(credentialsId),
  grant: grantItem,
  revoke: revokeItem,
  teamEmails: teamPrimaryEmails,
};

/** The grants of one Google credential, as its module's kv. */
export function grantedItemsKv(credentialsId: string, options: { teamId: string; store?: GrantedItemsStore }): ModuleKv {
  const store = options.store ?? postgresGrantedItems;
  const itemOf = (key: string, method: string): string => {
    const itemId = key.startsWith(GRANTED_PREFIX) ? key.slice(GRANTED_PREFIX.length) : '';
    if (itemId === '') {
      throw new Error(
        `ctx.kv.${method}("${key}"): the platform keeps only "${GRANTED_PREFIX}<itemId>" keys for a Google credential` +
          (key === TEAM_EMAILS_KEY ? `; "${TEAM_EMAILS_KEY}" is the platform's to answer and is read-only` : ''),
      );
    }
    return itemId;
  };
  return {
    async get(key) {
      if (key === TEAM_EMAILS_KEY) return store.teamEmails(options.teamId);
      if (!key.startsWith(GRANTED_PREFIX)) return undefined;
      const item = (await store.list(credentialsId)).find((granted) => GRANTED_PREFIX + granted.itemId === key);
      return item === undefined ? undefined : { mimeType: item.mimeType, name: item.name };
    },
    async set(key, value) {
      const itemId = itemOf(key, 'set');
      const parsed = grantedValue.safeParse(value);
      if (!parsed.success) throw new Error(`ctx.kv.set("${key}"): a grant is { mimeType: string, name: string | null }`);
      await store.grant({ credentialsId, itemId, mimeType: parsed.data.mimeType, name: parsed.data.name });
    },
    async delete(key) {
      await store.revoke({ credentialsId, itemId: itemOf(key, 'delete') });
    },
    async list(prefix) {
      return (await store.list(credentialsId))
        .map((item) => ({ key: GRANTED_PREFIX + item.itemId, value: { mimeType: item.mimeType, name: item.name } }))
        .filter((entry) => entry.key.startsWith(prefix));
    },
  };
}
