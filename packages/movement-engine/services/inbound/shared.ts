// A shared door: one URL for a whole app or bot rather than one per
// subscription (the platform's Slack app, its Telegram bot). Admission is the
// same three questions as any door — is this a request answered before
// anything is looked up, is the key set, does the delivery verify — and it is
// declared here, as data, the way a module declares its inbound.
//
// What happens AFTER admission is the host's: a shared door fans a delivery
// out by who sent it (a team id, a sender identity), which is a lookup in the
// host's own directory and cannot live in a package.

import type { InboundAnswer, InboundIntercept } from './deliver';
import type { InboundAuth, InboundHeaders, InboundVerifier } from './verify';

import { answerIntercepts } from './deliver';
import { authenticateInbound } from './verify';

export interface SharedDoor {
  verifier: InboundVerifier;
  /** Requests answered before the signature is looked at. */
  intercepts: readonly InboundIntercept[];
}

export type SharedAdmission =
  | { kind: 'answered'; answer: InboundAnswer }
  | { kind: 'refused'; reason: Extract<InboundAuth, { authorized: false }>['reason'] }
  | { kind: 'admitted' };

export function admitShared(
  door: SharedDoor,
  delivery: {
    rawBody: Buffer;
    headers: InboundHeaders;
    /** The door's key; null when this host has none set. */
    secret: string | null;
    /** The host's rule for a door with no key; true lets the delivery in. */
    allowUnsigned: () => boolean;
  },
): SharedAdmission {
  const intercepted = answerIntercepts(door.intercepts, delivery.rawBody);
  if (intercepted) return { kind: 'answered', answer: intercepted };
  const auth = authenticateInbound({ verifier: door.verifier, ...delivery });
  return auth.authorized ? { kind: 'admitted' } : { kind: 'refused', reason: auth.reason };
}
