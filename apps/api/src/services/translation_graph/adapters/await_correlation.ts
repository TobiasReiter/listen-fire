// The awaitable capability's adapter half. The GENERIC correlation map — one
// `adapter_await` row per in-flight `await <head>-[:E]->` park, mapping an
// adapter's native identity (`adapterType` + `correlationKey`: the ask id for
// `ask`, `channel:thread_ts` for `slack`) to the engine park — is the run
// host's (the core's correlation family, served by run_host_store.ts). Because
// it is one shared table, run death, race loss and an engine error each reap
// every adapter's correlations at once, with no per-adapter fan-out.
//
// Resolvability is NOT in the map: it is per-adapter. An adapter whose awaits
// are backed by records of its own serves it as an `AwaitKeeper`; one that is
// event-driven (Slack) wakes a thread's parks by `correlationKey` when an
// inbound reply arrives.

import type { AwaitKeeper as RunHostAwaitKeeper } from 'movement-engine/services/run_host/store';

/** The run host's keeper of an adapter's record-backed awaits, plus what the
 *  product shows of them. */
export interface AwaitKeeper extends RunHostAwaitKeeper {
  /** What each correlated await is waiting on, in plain language, by its
   *  correlation key; a key it cannot describe is left out. */
  describe?(correlationKeys: string[]): Promise<Map<string, string>>;
}
