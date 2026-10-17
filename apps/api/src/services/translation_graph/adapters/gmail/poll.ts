// Gmail's legacy poll source: the module's poll (@lf/gmail) over the legacy
// credential path (index.ts). Kept beside the legacy adapter for the same
// one-edit rollback.

import type { PollSource } from '../../poll_source';
import type { TeamId } from '../../../../generated/kysely/core/Team';

import { GmailPollSource } from '@listen-fire/gmail';
import { legacyGmailClient } from './index';

export function createGmailPollSource(input: { teamId: TeamId; credentialsId?: string }): PollSource {
  const source = new GmailPollSource(legacyGmailClient(input));
  return { pollIntervalSeconds: source.pollIntervalSeconds, getEvents: (poll) => source.getEvents(poll) };
}
