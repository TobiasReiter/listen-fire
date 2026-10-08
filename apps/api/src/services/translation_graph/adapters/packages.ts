// What a package adds beyond its adapter, beside the registry of adapters.
//
// An adapter package may bring the run host more than an adapter: work kinds
// of its own (a sweep, a subscription refresh), the keeper of awaits its own
// records back, the landing types its writes synthesise. The run host reaches
// each through these lookups and names no package. Read at call time, never at
// load, so a package module mid-load in an import cycle is never captured
// half-built.

import { AIRTABLE_WORK_KINDS } from '../../airtable_webhook_refresh/worker';
import type { WorkKindRegistration } from '../../work/units';
import type { LandingSynthesizer } from '../movement/generic_landings';
import { ASK_ADAPTER_TYPE, askResponseDescriptorFor } from './ask';
import { askAwaitKeeper } from './ask/await_keeper';
import { ASK_WORK_KINDS } from './ask/closed_sweep';
import type { AwaitKeeper } from './await_correlation';

/** Every package's own work kinds, for the process that drains. */
export function adapterWorkKinds(): WorkKindRegistration[] {
  return [...ASK_WORK_KINDS, ...AIRTABLE_WORK_KINDS];
}

/** Every package's keeper of record-backed awaits. */
export function awaitKeepers(): readonly AwaitKeeper[] {
  return [askAwaitKeeper];
}

/** The keeper of an adapter type's record-backed awaits, if it has one. */
export function awaitKeeperFor(adapterType: string): AwaitKeeper | undefined {
  return awaitKeepers().find((keeper) => keeper.adapterType === adapterType);
}

/** What an adapter type's generic landings are, given the literals a write
 *  authored — for an adapter whose edges declare `genericOver`. */
export function landingSynthesizerFor(adapterType: string): LandingSynthesizer | undefined {
  if (adapterType !== ASK_ADAPTER_TYPE) return undefined;
  return ({ writtenType, values }) => askResponseDescriptorFor({ family: writtenType, values });
}
