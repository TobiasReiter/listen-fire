// The spreadsheets granted to this install, kept in its kv. Under the
// `drive.file` scope a token sees only the files the user picked (or the app
// created), so the grants are the only list of spreadsheets there is. The
// host keeps them: on the platform, the grants table the picker writes; under
// serve-module, its state directory. Keys `granted/<itemId>` hold
// `{ mimeType, name }`; Drive keeps its folders in the same space, so Sheets
// reads only the spreadsheet ones. `team/emails` is the host's answer for who
// a created spreadsheet is shared with.

import type { ModuleKv } from 'module-kit';

import { z } from 'zod';

import { SPREADSHEET_MIME } from './types';

export const GRANTED_PREFIX = 'granted/';
export const TEAM_EMAILS_KEY = 'team/emails';

const grantValue = z.object({ mimeType: z.string(), name: z.string().nullable() });

export interface GrantedSpreadsheet {
  spreadsheetId: string;
  name: string | null;
}

export interface SpreadsheetGrants {
  /** In grant order. */
  list(): Promise<GrantedSpreadsheet[]>;
  grant(input: { spreadsheetId: string; name: string | null }): Promise<void>;
  /** The team's emails, as the host answers them; empty when it answers none. */
  teamEmails(): Promise<string[]>;
}

export function spreadsheetGrants(kv: ModuleKv): SpreadsheetGrants {
  return {
    async list() {
      const granted: GrantedSpreadsheet[] = [];
      for (const { key, value } of await kv.list(GRANTED_PREFIX)) {
        const parsed = grantValue.safeParse(value);
        if (!parsed.success) throw new Error(`Google Sheets: the grant kept under "${key}" is not { mimeType, name }`);
        if (parsed.data.mimeType === SPREADSHEET_MIME) granted.push({ spreadsheetId: key.slice(GRANTED_PREFIX.length), name: parsed.data.name });
      }
      return granted;
    },
    async grant({ spreadsheetId, name }) {
      await kv.set(`${GRANTED_PREFIX}${spreadsheetId}`, { mimeType: SPREADSHEET_MIME, name });
    },
    async teamEmails() {
      const emails = z.array(z.string()).safeParse((await kv.get(TEAM_EMAILS_KEY)) ?? []);
      if (!emails.success) throw new Error(`Google Sheets: "${TEAM_EMAILS_KEY}" is not a list of emails`);
      return emails.data;
    },
  };
}
