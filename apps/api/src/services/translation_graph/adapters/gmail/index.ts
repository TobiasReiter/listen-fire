// Gmail's legacy line: the module's adapter (@lf/gmail) over the credential
// path the platform used before modules (client.ts: the stored row read per
// call, its shape from `app_id`, the mailbox allowlist), and the platform's
// file reader. Its files are named as this install's, as a module line's
// are. Kept so the `BUILTIN_MODULES` line for Gmail can go back to `legacy`
// in one edit while the module line is new; remove it with the line once the
// module line has soaked.

import type { Adapter } from 'movement-engine/public/adapter';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { GmailClientSource } from '@lf/gmail';

import { GMAIL_ADAPTER_TYPE, GmailAdapter } from '@lf/gmail';
import { readHandedFile } from 'module-kit';
import { logger } from 'movement-engine/public/log';
import { ownedFilesAdapter } from 'movement-engine/public/modules';
import { platformModuleFiles } from '../../engine/files/module_files';
import { resolveGmailClient } from './client';

export {
  GMAIL_ADAPTER_TYPE,
  GMAIL_ATTACHMENT_TYPE_ID,
  GMAIL_MAILBOX_TYPE_ID,
  GMAIL_MANIFEST,
  GMAIL_MESSAGE_EVENT_TAG,
  GMAIL_MESSAGE_TYPE_ID,
  GmailAdapter,
} from '@lf/gmail';

/** The mailbox's client, resolved afresh per call as the legacy adapter
 *  always did: a row edited or a list narrowed between calls is read by the
 *  next one. */
export function legacyGmailClient(input: { teamId: TeamId; credentialsId?: string }): GmailClientSource {
  return async () => {
    const client = await resolveGmailClient(input);
    if (!client) {
      throw new Error(
        `GmailAdapter: no usable Gmail mailbox for team ${input.teamId} ` +
          `(credentialsId=${input.credentialsId ?? 'unset'}). Connect Gmail.`,
      );
    }
    return client;
  };
}

export function createGmailAdapter(input: { teamId: TeamId; credentialsId?: string }): Adapter {
  const host = { fetch, files: platformModuleFiles({ teamId: input.teamId, module: '@lf/gmail' }) };
  const adapter = new GmailAdapter({
    client: legacyGmailClient(input),
    readFile: (ref) => readHandedFile(host, ref),
    log: logger,
  });
  return ownedFilesAdapter(adapter, {
    adapterType: GMAIL_ADAPTER_TYPE,
    ...(input.credentialsId !== undefined ? { credentialsId: input.credentialsId } : {}),
  });
}
