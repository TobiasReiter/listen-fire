// The single store behind the Google pickers (Sheets + Drive). Under the
// drive.file scope there is no list-all API; the Picker grants access one item
// at a time and each pick is recorded here against the Google credential, tagged
// with its real Drive mime_type so each adapter filters to what it cares about.
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

import { getAutomationsQb } from '../../lib/kysely';

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
