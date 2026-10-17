// Google Drive's legacy line: the module's adapter (@lf/google-drive) over
// the credential path the platform used before modules (client.ts), the
// grants table, and the platform's file reader. Its files are named as this
// install's, as a module line's are. Kept so the `BUILTIN_MODULES` line for
// Google Drive can go back to `legacy` in one edit while the module line is
// new; remove it with the line once the module line has soaked.

import type { Adapter } from 'movement-engine/public/adapter';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { GoogleDriveClient } from '../../../../adapters/google/driveClient';

import { GOOGLE_DRIVE_ADAPTER_TYPE, GoogleDriveAdapter } from '@listen-fire/google-drive';
import { readHandedFile } from 'module-kit';
import { logger } from 'movement-engine/public/log';
import { ownedFilesAdapter } from 'movement-engine/public/modules';
import { grantedItemsKv } from '../../../credentials/granted_items';
import { platformModuleFiles } from '../../engine/files/module_files';
import { resolveGoogleDriveClient } from './client';

export { GOOGLE_DRIVE_ADAPTER_TYPE, GOOGLE_DRIVE_MANIFEST, GoogleDriveAdapter } from '@listen-fire/google-drive';

export function createGoogleDriveAdapter(input: { teamId: TeamId; credentialsId?: string }): Adapter {
  const { credentialsId } = input;
  if (!credentialsId) {
    throw new Error(
      'Google Drive adapter requires credentialsId — wire pipeline_output.credentials_id (out-flow) through getAdapter.',
    );
  }
  const host = { fetch, files: platformModuleFiles({ teamId: input.teamId, module: '@lf/google-drive' }) };
  // One client per adapter, built on first use and kept once built, as before.
  let client: GoogleDriveClient | undefined;
  const adapter = new GoogleDriveAdapter({
    client: async () => (client ??= await resolveGoogleDriveClient({ teamId: input.teamId, credentialsId })),
    kv: grantedItemsKv(credentialsId, { teamId: input.teamId }),
    readFile: (ref) => readHandedFile(host, ref),
    log: logger,
  });
  return ownedFilesAdapter(adapter, { adapterType: GOOGLE_DRIVE_ADAPTER_TYPE, credentialsId });
}
