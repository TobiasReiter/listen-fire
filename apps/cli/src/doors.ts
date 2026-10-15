// The two push doors an external calls when it owns its own inbound side,
// served by `lf serve` exactly as the hosted product serves them:
//
//   POST /api/public/adapter/<external>/emit  { events }  new data: each event
//        is queued, and the drain routes it to the listens it matches, as a
//        webhook delivery's are;
//   POST /api/public/adapter/<external>/wake  { keys }    resume whatever is
//        parked on these correlation keys (queued as a wake per key).
//
// The caller presents the credential its install holds, carried the way the
// host authenticates to it (the external's manifest `auth`), and the install
// whose secret matches is the caller. 202 `{ accepted }` once queued, counting
// the rows queued (as hosted's receipts); 401 for any mismatch, saying nothing about who is installed; 409
// when the credential matches several installs; 400 for a malformed body.

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { AdapterEmitBody, AdapterWakeBody } from 'engine-contracts';
import { authHeader } from 'movement-engine/services/translation_graph/protocol/client';
import { neverAsAny } from 'movement-engine/lib/utils/types';
import { queueAwaitWake } from 'movement-engine/services/run_host/rules';
import { LOCAL_TENANT } from './host';
import type { Session } from './runs';
import type { Credential } from './secrets';

export type AdapterDoorAuth =
  | { kind: 'authenticated'; credential: Credential }
  | { kind: 'unauthorized' }
  | { kind: 'ambiguous' };

/** Compared as digests, so the comparison takes the same time whatever the
 *  lengths and wherever they differ. */
function sameSecret(presented: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

/** Which install of `external` presented its credential. Every install is
 *  compared, with no early exit. */
export function authenticateAdapterDoor(
  session: Session,
  input: { external: string; headers: Record<string, string | undefined> },
): AdapterDoorAuth {
  const auth = session.running.get(input.external)?.external.manifest.auth;
  if (auth === undefined) return { kind: 'unauthorized' };
  const matches: Credential[] = [];
  for (const credential of session.credentials.values()) {
    if (credential.external !== input.external) continue;
    const secret = credential.fields[auth.field];
    if (secret === undefined) continue;
    let matched = false;
    for (const [name, expected] of Object.entries(authHeader({ kind: auth.kind }, secret))) {
      const presented = input.headers[name.toLowerCase()];
      if (presented !== undefined && sameSecret(presented, expected)) matched = true;
    }
    if (matched) matches.push(credential);
  }
  const [credential, ...others] = matches;
  if (credential === undefined) return { kind: 'unauthorized' };
  if (others.length > 0) return { kind: 'ambiguous' };
  return { kind: 'authenticated', credential };
}

export interface DoorAnswer {
  status: number;
  body: unknown;
}

/** One push to a door: authenticated before its body is judged, so a caller
 *  without a credential learns nothing about the shape the door wants. */
export async function receiveAdapterPush(
  session: Session,
  input: { external: string; door: 'emit' | 'wake'; headers: Record<string, string | undefined>; body: unknown },
  options: { onQueued?: () => void } = {},
): Promise<DoorAnswer> {
  const auth = authenticateAdapterDoor(session, input);
  switch (auth.kind) {
    case 'authenticated':
      break;
    case 'unauthorized':
      return { status: 401, body: { error: 'unauthorized' } };
    case 'ambiguous':
      return { status: 409, body: { error: 'ambiguous_credential', message: 'this credential belongs to more than one install of the external' } };
    default:
      return neverAsAny(auth);
  }
  switch (input.door) {
    case 'emit': {
      const body = AdapterEmitBody.safeParse(input.body);
      if (!body.success) return badRequest(body.error);
      for (const event of body.data.events) {
        await session.runHost.store.work.enqueue({
          kind: 'fire_event',
          key: `fire_event:${randomUUID()}`,
          teamId: LOCAL_TENANT,
          payload: { external: input.external, event },
        });
      }
      options.onQueued?.();
      return { status: 202, body: { accepted: body.data.events.length } };
    }
    case 'wake': {
      const body = AdapterWakeBody.safeParse(input.body);
      if (!body.success) return badRequest(body.error);
      for (const correlationKey of body.data.keys) {
        await queueAwaitWake(session.runHost.store, { adapterType: input.external, teamId: LOCAL_TENANT, correlationKey });
      }
      options.onQueued?.();
      return { status: 202, body: { accepted: body.data.keys.length } };
    }
    default:
      return neverAsAny(input.door);
  }
}

function badRequest(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }): DoorAnswer {
  return {
    status: 400,
    body: { error: 'bad_request', issues: error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })) },
  };
}
