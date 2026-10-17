// The PollSource seam — solicited, schedule-driven event production.
//
// Polling a source on a schedule for new/changed events is NOT a core adapter
// concern (the `Adapter` interface is about reading and writing records), so it
// lives here, on its own interface. A package MAY implement both `Adapter` and
// `PollSource` — Granola does — sharing the same underlying API client; the two
// are distinct seams, resolved through distinct registries.
//
// The platform half is `services/poll_source/worker.ts`: it scans trigger rows
// whose `kind` resolves to a registered PollSource, calls `getEvents` with the
// persisted opaque checkpoint, and injects each returned event into the SAME
// dispatch path a webhook uses (the one event pipeline). A remote adapter that
// needs to poll does so internally and delivers via its webhook — the framework
// never drives a remote PollSource over the wire.

import type { DiscriminableEvent } from 'movement-engine/public/adapter';
import type { TeamId } from '../../generated/kysely/core/Team';

export interface PollSource {
  /**
   * How often this source wants to be polled — its strong default. The worker
   * honours it, but a `listen` option (`every`) flows into the trigger's config
   * and overrides it (`config.pollIntervalSeconds ?? pollIntervalSeconds`).
   */
  readonly pollIntervalSeconds: number;

  /**
   * Solicited pull. `config` is the trigger's config (the `listen` options
   * block); `checkpoint` is the opaque token persisted from the prior call
   * (`undefined` on first sight). Returns the events to dispatch plus the next
   * checkpoint to persist. Incremental by design — bulk backfill is not this.
   */
  getEvents(input: {
    config: unknown;
    checkpoint?: unknown;
    /** The automation the polled listener belongs to. A source whose events
     *  can concern automations themselves (the platform's own) needs it to
     *  keep an automation from being told about itself; the rest ignore it. */
    movementId?: string;
  }): Promise<{ events: DiscriminableEvent[]; checkpoint?: unknown }>;
}

/** Factory signature — mirrors `AdapterFactory`: per-team + per-credential. */
export type PollSourceFactory = (input: {
  teamId: TeamId;
  credentialsId?: string;
}) => PollSource;
