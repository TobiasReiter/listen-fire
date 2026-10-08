// P22 — "the awaited edge is the park's public identity". Every run surface that
// shows a parked run answers "what is this waiting on?" the SAME way: in plain
// language, derived from the park + the awaitable adapter's correlation, never
// from engine internals. No jargon reaches a person here — no "adapter",
// "correlation", "park", "address", "edge id".
//
// Two park shapes carry an author-chosen wait:
//   • an AWAIT park (`await x-[:E]->`) — described from its `adapter_await` row:
//       a record-backed await → its keeper's line (an ask: the question it is
//         waiting to be answered)
//       slack → a reply it is waiting for in a thread
//   • a TIMER park — a recurring `until` condition ("checking on a schedule")
//       or a one-shot `sleep` ("waiting for a scheduled time").

import { getAutomationsQb } from '../../lib/kysely';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import { awaitKeeperFor } from '../translation_graph/adapters/packages';

/** One plain-language line describing something a run is waiting on. */
export type AwaitDescription = string;

/**
 * Everything a run is currently waiting on, in plain language — one line per
 * live parked leaf. Empty when the run has no author-chosen waits (running, or
 * parked only on an engine hold like a spending limit, which these surfaces
 * describe elsewhere).
 */
export async function describeRunAwaits(runId: TriggerRunId): Promise<AwaitDescription[]> {
  const parked = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', '=', runId)
    .where('status', '=', 'parked')
    .where('park_reason', 'in', ['await', 'timer'])
    .select(['address', 'park_reason', 'state'])
    .execute();
  if (parked.length === 0) return [];

  const awaitAddresses = parked.filter((p) => p.park_reason === 'await').map((p) => p.address);
  const correlations = awaitAddresses.length > 0 ? await loadCorrelations(runId, awaitAddresses) : new Map();

  // What each record-backed await is waiting on, from the adapter that keeps
  // it, one read per adapter.
  const described = await describeKept([...correlations.values()]);

  const out: AwaitDescription[] = [];
  for (const park of parked) {
    if (park.park_reason === 'timer') {
      out.push(describeTimer(park.state));
      continue;
    }
    const corr = correlations.get(park.address);
    if (!corr) {
      // A parked await with no correlation row is a transient inconsistency
      // (mid-drain); describe it honestly rather than inventing an edge.
      out.push('waiting on a response');
      continue;
    }
    out.push(described.get(keyOf(corr)) ?? describeAwait(corr));
  }
  return out;
}

interface Correlation {
  adapterType: string;
  correlationKey: string;
}

async function loadCorrelations(
  runId: TriggerRunId,
  addresses: string[],
): Promise<Map<string, Correlation>> {
  const rows = await getAutomationsQb(['adapter_await'])
    .selectFrom('adapter_await')
    .where('run_id', '=', runId)
    .where('address', 'in', addresses)
    .select(['address', 'adapter_type', 'correlation_key'])
    .execute();
  const map = new Map<string, Correlation>();
  for (const r of rows) {
    map.set(r.address, { adapterType: r.adapter_type, correlationKey: r.correlation_key });
  }
  return map;
}

function keyOf(corr: Correlation): string {
  return `${corr.adapterType}\u0000${corr.correlationKey}`;
}

async function describeKept(correlations: Correlation[]): Promise<Map<string, string>> {
  const byAdapter = new Map<string, string[]>();
  for (const { adapterType, correlationKey } of correlations) {
    byAdapter.set(adapterType, [...(byAdapter.get(adapterType) ?? []), correlationKey]);
  }
  const described = new Map<string, string>();
  for (const [adapterType, keys] of byAdapter) {
    const describe = awaitKeeperFor(adapterType)?.describe;
    if (describe === undefined) continue;
    for (const [correlationKey, line] of await describe(keys)) {
      described.set(keyOf({ adapterType, correlationKey }), line);
    }
  }
  return described;
}

function describeAwait(corr: Correlation): AwaitDescription {
  if (corr.adapterType === 'slack') {
    // The correlation key is "<channelId>:<threadTs>" — the channel id is not a
    // name a person recognises, so keep it plain.
    return 'waiting for a reply in a Slack thread';
  }
  return 'waiting for a response';
}

function describeTimer(state: unknown): AwaitDescription {
  const isUntil =
    state !== null &&
    typeof state === 'object' &&
    (state as Record<string, unknown>).until === true;
  return isUntil
    ? 'checking on a schedule for a condition to become true'
    : 'waiting until a scheduled time';
}
