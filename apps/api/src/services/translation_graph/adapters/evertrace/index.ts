// Evertrace's legacy line: the module's adapter and poll (@lf/evertrace), over
// the credential path the platform used before modules (client.ts). Kept so
// the `BUILTIN_MODULES` line for Evertrace can go back to `legacy` in one edit
// while the module line is new; remove it with the line once the module line
// has soaked.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { PollSource } from '../../poll_source';

import { EVERTRACE_POLL_INTERVAL_SECONDS, EvertraceAdapter, pollEvertrace, type EvertraceClientSource } from '@lf/evertrace';
import { logger } from 'movement-engine/public/log';
import { resolveEvertraceClient } from './client';

function legacyClient(input: { teamId: TeamId; credentialsId?: string }): EvertraceClientSource {
  return async () => {
    const client = await resolveEvertraceClient(input);
    if (!client) {
      throw new Error(
        `EvertraceAdapter: no usable Evertrace credential for team ${input.teamId} ` +
          `(credentialsId=${input.credentialsId ?? 'unset'}). Connect Evertrace.`,
      );
    }
    return client;
  };
}

export function createEvertraceAdapter(input: { teamId: TeamId; credentialsId?: string }): EvertraceAdapter {
  return new EvertraceAdapter(legacyClient(input));
}

export function createEvertracePollSource(input: { teamId: TeamId; credentialsId?: string }): PollSource {
  const client = legacyClient(input);
  return {
    pollIntervalSeconds: EVERTRACE_POLL_INTERVAL_SECONDS,
    getEvents: async (poll) => pollEvertrace(await client(), poll, { log: logger }),
  };
}
