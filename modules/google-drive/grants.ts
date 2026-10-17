// The Drive items granted to this install, kept in its kv. Under the
// `drive.file` scope a token sees only the files the user picked (or the app
// created), so the grants are the only roots there are. The host keeps them:
// on the platform, the grants table the picker writes; under serve-module,
// its state directory. Keys `granted/<itemId>` hold `{ mimeType, name }`;
// Drive reads every grant (Sheets keeps its spreadsheets in the same space,
// and a spreadsheet is a Drive file too).

import type { ModuleKv } from 'module-kit';

import { z } from 'zod';

export const GRANTED_PREFIX = 'granted/';

const grantValue = z.object({ mimeType: z.string(), name: z.string().nullable() });

export interface GrantedDriveItem {
  itemId: string;
  mimeType: string;
  name: string | null;
}

export interface DriveGrants {
  /** In grant order. */
  list(): Promise<GrantedDriveItem[]>;
}

export function driveGrants(kv: ModuleKv): DriveGrants {
  return {
    async list() {
      return (await kv.list(GRANTED_PREFIX)).map(({ key, value }) => {
        const parsed = grantValue.safeParse(value);
        if (!parsed.success) throw new Error(`Google Drive: the grant kept under "${key}" is not { mimeType, name }`);
        return { itemId: key.slice(GRANTED_PREFIX.length), ...parsed.data };
      });
    },
  };
}
