// The host a dev probe runs the engine with: the production host — its locks,
// model clients, stores and segment scope are what the probe exercises — with
// the probe's own adapters (a client pointed at a fake server) in place of the
// registry's, each call answering inside the segment it was resolved for.

import type { CatalogSnapshot } from 'movement-lang';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { EngineHost } from 'movement-engine/public/host';
import type { LiveAdapterResolver } from 'movement-engine/public/host';
import type { DryRunWriteSink } from 'movement-engine/public/adapter';

import { productionEngineHost } from '../../../services/translation_graph/movement/engine_host';

export function probeEngineHost(input: {
  teamId: TeamId;
  resolve: LiveAdapterResolver;
  writeSink?: DryRunWriteSink;
}): EngineHost {
  return productionEngineHost({
    teamId: input.teamId,
    resolveLive: input.resolve,
    // The probe's credential ids name no vault row: its adapters ignore them.
    credentials: { belongsTo: () => true },
    ...(input.writeSink !== undefined ? { writeSink: input.writeSink } : {}),
  });
}

/** Every credential the probe's catalog imports, answering to one id — the
 *  probe's adapters ignore which. */
export function everyCredential(catalog: CatalogSnapshot, credentialId: string): Record<string, string> {
  return Object.fromEntries(Object.keys(catalog.credentials).map((name) => [name, credentialId]));
}
