/**
 * tRPC surface for the Google Sheets connect-affordance grant flow.
 *
 * Under Google's `drive.file` OAuth scope, granting access to a spreadsheet
 * happens one file at a time through the browser-side Drive Picker. This
 * router is the server half of that flow:
 *
 *   - `pickerToken` — a FRESH (refreshed-if-expired) Google access token for
 *     a credential, scoped to the team. The browser hands it to the Picker
 *     as the OAuth token. The credential already carries `drive.file` scope
 *     (see adapters/google/authClient.ts), so no extra consent is needed.
 *   - `grant` — record a picked spreadsheet against the credential. On PICKED
 *     the handler calls this; the granted set then feeds the google_sheets
 *     adapter's `listEntryPoints` so its tables surface in the catalog.
 *   - `listGrants` / `revoke` — manage the granted set from the credential UI.
 *
 * A credential is named two ways depending on the caller: the credential UI
 * passes the raw `credentialsId`; the movement editor / chat affordance pass
 * the adapter + credential IMPORT name (what they already hold). Both resolve
 * to one team-scoped credential row here.
 *
 */

import { z } from 'zod';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import { currentContext } from '../../../services/context';
import { trpc } from '../trpc';
import { getAutomationsQb } from '../../../lib/kysely';
import { decryptToken } from '../../../lib/credentials';
import { services } from '../../../adapters/registry';
import { googleCredsParser } from '../../../adapters/google/authClient';
import { GOOGLE_SHEETS_ADAPTER_TYPE } from '../../../services/translation_graph/adapters/google_sheets';
import {
  grantSpreadsheet,
  listGrantedSpreadsheets,
  revokeSpreadsheet,
  type GrantedSpreadsheet,
} from '../../../services/translation_graph/adapters/google_sheets/grants';
import { resolveCredentialIdByImportName } from '../../../services/translation_graph/movement/catalog';
import { userProcedure as sharedUserProcedure } from '../procedures';

/** Identify a credential either by raw id (credential UI) or by the movement
 *  import name the editor/chat hold (resolved against google_sheets). */
const credentialRef = z.union([
  z.object({ credentialsId: z.string() }),
  z.object({ credentialName: z.string() }),
]);
type CredentialRef = z.infer<typeof credentialRef>;

/** Resolve a credential ref to a credential id owned by the team. Throws a
 *  clear error when it can't — never leaks another team's credential. */
async function resolveCredentialId(ref: CredentialRef, teamId: TeamId): Promise<string> {
  if ('credentialsId' in ref) {
    const row = await getAutomationsQb(['external_service_credentials'])
      .selectFrom('external_service_credentials')
      .where('id', '=', ref.credentialsId as ExternalServiceCredentialsId)
      .where('team_id', '=', teamId)
      .select(['id'])
      .executeTakeFirst();
    if (!row) throw new Error('Google credential not found for this team.');
    return row.id;
  }
  const id = await resolveCredentialIdByImportName({
    teamId,
    adapter: GOOGLE_SHEETS_ADAPTER_TYPE,
    credentialName: ref.credentialName,
  });
  if (!id) {
    throw new Error(`No Google credential named '${ref.credentialName}' on this team.`);
  }
  return id;
}

const googleSheetsRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    /**
     * A fresh `drive.file`-scoped access token for the browser Drive Picker.
     * Sourced through the credential's OAuth2Client so an expired token is
     * refreshed (and the refresh persisted) before it's handed out.
     */
    pickerToken: userProcedure
      .input(credentialRef)
      .query(async ({ input }): Promise<string> => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;
        const credentialsId = await resolveCredentialId(input, teamId);

        if (!services.google) {
          throw new Error('Google integrations are not configured on this server.');
        }

        const row = await getAutomationsQb(['external_service_credentials'])
          .selectFrom('external_service_credentials')
          .where('id', '=', credentialsId as ExternalServiceCredentialsId)
          .where('team_id', '=', teamId)
          .select(['id', 'credentials'])
          .executeTakeFirstOrThrow();

        const decrypted = await decryptToken(row.credentials, row.id);
        const creds = googleCredsParser.parse(JSON.parse(decrypted));

        const client = services.google.authClient.getGoogleClient(row.id, creds);
        const { token } = await client.getAccessToken();
        if (!token) {
          throw new Error('Could not obtain a Google access token — try reconnecting the account.');
        }
        return token;
      }),

    /** Record a picked spreadsheet against the credential (idempotent). */
    grant: userProcedure
      .input(
        credentialRef.and(
          z.object({
            spreadsheetId: z.string(),
            name: z.string().optional(),
          }),
        ),
      )
      .mutation(async ({ input }): Promise<{ granted: true }> => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;
        const credentialsId = await resolveCredentialId(input, teamId);
        await grantSpreadsheet({
          credentialsId,
          spreadsheetId: input.spreadsheetId,
          ...(input.name !== undefined ? { name: input.name } : {}),
        });
        return { granted: true };
      }),

    /** The spreadsheets granted to a credential — for the credential UI. */
    listGrants: userProcedure
      .input(credentialRef)
      .query(async ({ input }): Promise<GrantedSpreadsheet[]> => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;
        const credentialsId = await resolveCredentialId(input, teamId);
        return listGrantedSpreadsheets(credentialsId);
      }),

    /** Remove a granted spreadsheet from a credential's set. */
    revoke: userProcedure
      .input(credentialRef.and(z.object({ spreadsheetId: z.string() })))
      .mutation(async ({ input }): Promise<{ revoked: true }> => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;
        const credentialsId = await resolveCredentialId(input, teamId);
        await revokeSpreadsheet({ credentialsId, spreadsheetId: input.spreadsheetId });
        return { revoked: true };
      }),
  });
};

export { googleSheetsRouter };
