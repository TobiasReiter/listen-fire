// The composed deployment's end of knowledge's outbox.
//
// A graph mutation now reaches a movement listener exactly one way: knowledge
// commits an outbox row, its drainer picks the row up, and delivery happens.
// In the composed Listen-Fire container that delivery is this function call rather
// than a socket round trip to ourselves — but it is the SAME delivery, after
// the same durable hop, which is why chained graph movements behave the same
// here as in a split deployment (M-38). Nothing subscribes to graph writes
// in-process any more.
//
// The direction matters as much as the mechanism: knowledge knows nothing about
// movements. This module reaches into knowledge's registration hook, not the
// other way round, so a standalone knowledge deployment simply has no local
// subscriber and its consumers register webhooks.

import { registerLocalMutationSubscriber } from '../../knowledge/mutation_outbox/worker';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { NodeId } from '../../../generated/kysely/knowledge/Node';
import { recordMutationEventSchema, type RecordMutationEvent } from './record_mutation_event';
import { dispatchMutationEvent } from './mutation_dispatch';
import { logger } from '../../logger';

export function subscribeEngineToKnowledgeOutbox(): void {
  registerLocalMutationSubscriber(async ({ teamId, envelope }) => {
    const parsed = recordMutationEventSchema.safeParse(envelope.data);
    if (!parsed.success) {
      // A payload we cannot read is a listener that silently never fires, so it
      // is loud here rather than dropped. The most likely cause is a mutation
      // context that did not survive the write — the one field `suppress_self`
      // is computed from (K-29).
      logger.error('[knowledge outbox] undeliverable mutation payload', {
        teamId,
        event: envelope.event,
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      throw new Error('Knowledge mutation payload did not match the event contract');
    }

    const event: RecordMutationEvent = {
      ...parsed.data,
      recordId: parsed.data.recordId as NodeId,
    };
    await dispatchMutationEvent({ event, teamId: teamId as TeamId });
  });
}
