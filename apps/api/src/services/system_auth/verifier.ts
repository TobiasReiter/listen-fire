// Who may call the system surface (`/api/v1/system/*`, the drain tick first).
//
// The answer is a list of verifiers rather than one built-in credential, so an
// embedder on its own infrastructure decides how its scheduler and its push
// subscription prove themselves: a `system` API key, a cloud's signed identity
// token, or something of its own. The contract a verifier implements is
// docs/contracts/system-caller.md; this file is its code.
//
// The registry mirrors the work-kind registry's shape (work/drain.ts): module
// level, filled at boot, read per request. Verifiers are asked in the order they
// were registered, and the first that accepts decides the caller.

import { logger } from 'movement-engine/services/logger';

/** What an accepted caller may do on the system surface. */
type SystemAction = 'drain';

const SYSTEM_ACTIONS: readonly SystemAction[] = ['drain'];

/** Host-specific: the API key this host's own authentication already verified
 *  for the request, when it carried one. The api_key verifier reads it; other
 *  verifiers ignore it. */
interface HostCredential {
  id?: string;
  scopes: readonly string[];
}

/** What a verifier sees of a request. Header names are lower case, and the
 *  headers are the raw ones: every credential the request carries is in them. */
interface SystemCallerRequest {
  method: string;
  path: string;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  hostCredential?: HostCredential;
}

interface SystemCallerPrincipal {
  id: string;
  display?: string;
}

type SystemCallerVerdict =
  | { ok: true; principal: SystemCallerPrincipal; actions: readonly SystemAction[] }
  | { ok: false; reason: string };

interface SystemCallerVerifier {
  /** Names the verifier in refusals and logs; unique in the registry. */
  readonly name: string;
  verify(request: SystemCallerRequest): Promise<SystemCallerVerdict>;
}

/** An accepted caller, as the routes read it. */
interface SystemCaller {
  verifier: string;
  principal: SystemCallerPrincipal;
  actions: readonly SystemAction[];
}

interface SystemCallerRefusal {
  verifier: string;
  reason: string;
}

type SystemCallerOutcome = { ok: true; caller: SystemCaller } | { ok: false; refusals: SystemCallerRefusal[] };

const verifiers: SystemCallerVerifier[] = [];

const REFUSAL_LOG_EVERY_MS = 60_000;
// A reason is a verifier's own text, so a verifier that quotes its input could
// carry a caller's; the log keeps a bounded prefix whatever it says.
const REFUSAL_LOG_REASON_MAX = 200;
// A refused caller names itself only by its address, which it chooses; the
// bound keeps a caller that sprays addresses from growing this without limit.
const REFUSAL_LOG_KEYS_MAX = 1_000;
const lastRefusalLoggedAt = new Map<string, number>();

/** Adds a verifier, asked after every one registered before it. */
function registerSystemCallerVerifier(verifier: SystemCallerVerifier): void {
  if (verifiers.some((registered) => registered.name === verifier.name)) {
    throw new Error(`a system caller verifier named "${verifier.name}" is already registered`);
  }
  verifiers.push(verifier);
}

function registeredSystemCallerVerifiers(): readonly SystemCallerVerifier[] {
  return verifiers;
}

/** Test-only: forget every registered verifier. */
function resetSystemCallerVerifiersForTests(): void {
  verifiers.length = 0;
  lastRefusalLoggedAt.clear();
}

function logRefusalOnce(caller: string, refusal: SystemCallerRefusal): void {
  const now = Date.now();
  // Keyed on who and which verifier, never the reason: varying the reason
  // (a fresh header per request) must not buy a fresh log line.
  const key = `${caller}\u0000${refusal.verifier}`;
  const last = lastRefusalLoggedAt.get(key);
  if (last !== undefined && now - last < REFUSAL_LOG_EVERY_MS) return;
  if (lastRefusalLoggedAt.size >= REFUSAL_LOG_KEYS_MAX) {
    for (const [stale, at] of lastRefusalLoggedAt) {
      if (now - at >= REFUSAL_LOG_EVERY_MS) lastRefusalLoggedAt.delete(stale);
    }
    if (lastRefusalLoggedAt.size >= REFUSAL_LOG_KEYS_MAX) lastRefusalLoggedAt.clear();
  }
  lastRefusalLoggedAt.set(key, now);
  logger.warn('[system-auth] a system caller verifier refused the request', {
    caller,
    verifier: refusal.verifier,
    reason: refusal.reason.slice(0, REFUSAL_LOG_REASON_MAX),
  });
}

/**
 * Asks each verifier in turn; the first acceptance decides. A verifier that
 * throws has refused; its error goes to the server log, never to the caller.
 * Refusals are logged only when nobody accepts (an accepted request is no
 * news), at most once a minute per caller address and verifier.
 */
async function identifySystemCaller(
  request: SystemCallerRequest,
  options: { verifiers: readonly SystemCallerVerifier[]; callerAddress: string },
): Promise<SystemCallerOutcome> {
  const refusals: SystemCallerRefusal[] = [];
  for (const verifier of options.verifiers) {
    let verdict: SystemCallerVerdict;
    try {
      verdict = await verifier.verify(request);
    } catch (error) {
      logger.warn('[system-auth] a system caller verifier threw', {
        verifier: verifier.name,
        error: (error instanceof Error ? error.message : String(error)).slice(0, REFUSAL_LOG_REASON_MAX),
      });
      verdict = { ok: false, reason: 'the verifier failed' };
    }
    if (verdict.ok) {
      return { ok: true, caller: { verifier: verifier.name, principal: verdict.principal, actions: verdict.actions } };
    }
    refusals.push({ verifier: verifier.name, reason: verdict.reason });
  }
  for (const refusal of refusals) logRefusalOnce(options.callerAddress, refusal);
  return { ok: false, refusals };
}

export {
  SYSTEM_ACTIONS,
  identifySystemCaller,
  registerSystemCallerVerifier,
  registeredSystemCallerVerifiers,
  resetSystemCallerVerifiersForTests,
  type HostCredential,
  type SystemAction,
  type SystemCaller,
  type SystemCallerOutcome,
  type SystemCallerPrincipal,
  type SystemCallerRefusal,
  type SystemCallerRequest,
  type SystemCallerVerdict,
  type SystemCallerVerifier,
};
