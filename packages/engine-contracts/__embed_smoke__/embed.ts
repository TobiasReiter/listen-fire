// An embedder, as the compiler sees one: a package outside the run host that
// imports the contracts by name, and the engine, the test host and the
// adapter protocol's server kit by path (they are not packaged yet). It
// compiles only if none of them needs the run host's generated database code
// (`check.cjs` holds that, and holds the compile).

import {
  HOST_FAMILIES,
  PROTOCOL_VERSION,
  isCorePark,
  tenantIdOf,
  type FileRef,
  type ParkedScopeState,
  type RunInput,
  type TenantId,
} from 'engine-contracts';

import { runMovement, type MovementRunResult } from '../../../packages/movement-engine/services/movement_engine/run';
import { makeFakeParkSink, makeTestHost } from '../../../packages/movement-engine/services/movement_engine/test_host';
import { createAdapterProtocolHandler } from '../../../apps/api/src/services/translation_graph/protocol/server';
import type { Adapter } from '../../../packages/movement-engine/services/translation_graph/adapter';

const tenant: TenantId = tenantIdOf('an-embedders-own-tenant');

/** Run a movement on the test host, for the embedder's tenant. */
export function runForTenant(input: Omit<RunInput, 'teamId'>): Promise<MovementRunResult> {
  const { sink } = makeFakeParkSink();
  return runMovement({ ...input, teamId: tenant, host: makeTestHost({ park: { sink } }) });
}

/** Serve one in-process adapter over the adapter protocol. */
export function serve(adapter: Adapter) {
  return createAdapterProtocolHandler({ adapter });
}

/** What an embedder reads of a parked leaf without the engine. */
export function describePark(reason: string, state: ParkedScopeState): string {
  return `${isCorePark(reason) ? 'core' : 'unit'} park at ${state.address} (state v${state.version})`;
}

export const families: readonly string[] = Object.keys(HOST_FAMILIES);
export const protocol: string = PROTOCOL_VERSION;
export const nameOf = (file: FileRef): string | undefined => file.name;
