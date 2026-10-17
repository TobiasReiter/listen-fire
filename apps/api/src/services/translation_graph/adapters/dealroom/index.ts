// Dealroom's legacy line: the module's adapter and poll (@lf/dealroom), over
// the credential path the platform used before modules (client.ts). Kept so
// the `BUILTIN_MODULES` line for Dealroom can go back to `legacy` in one edit
// while the module line is new; remove it with the line once the module line
// has soaked.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { PollSource } from '../../poll_source';

import { DEALROOM_POLL_INTERVAL_SECONDS, DealroomAdapter, pollDealroom, type DealroomClientSource } from '@listen-fire/dealroom';
import { resolveDealroomClient } from './client';

export { DEALROOM_ADAPTER_TYPE, DEALROOM_MANIFEST } from '@listen-fire/dealroom';

function legacyClient(input: { teamId: TeamId; credentialsId?: string }): DealroomClientSource {
  return async () => {
    const client = await resolveDealroomClient(input);
    if (!client) {
      throw new Error(
        `DealroomAdapter: no usable Dealroom credential for team ${input.teamId} ` +
          `(credentialsId=${input.credentialsId ?? 'unset'}). Connect Dealroom.`,
      );
    }
    return client;
  };
}

export function createDealroomAdapter(input: { teamId: TeamId; credentialsId?: string }): DealroomAdapter {
  return new DealroomAdapter(legacyClient(input));
}

export function createDealroomPollSource(input: { teamId: TeamId; credentialsId?: string }): PollSource {
  const client = legacyClient(input);
  return {
    pollIntervalSeconds: DEALROOM_POLL_INTERVAL_SECONDS,
    getEvents: async (poll) => pollDealroom(await client(), poll),
  };
}
