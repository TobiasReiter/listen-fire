// The host a dev probe runs the engine with: the production host — its locks,
// model clients, stores and segment scope are what the probe exercises — with
// the probe's own adapters (a client pointed at a fake server) in place of the
// registry's, each answering inside the segment it was resolved for.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { EngineHost } from '../../../services/movement_engine/host';
import { productionEngineHost } from '../../../services/translation_graph/movement/engine_host';
import { segmentBoundAdapter } from '../../../services/translation_graph/segment_scope';

export function probeEngineHost(input: { teamId: TeamId; adapters: EngineHost['adapters'] }): EngineHost {
  const host = productionEngineHost({
    teamId: input.teamId,
    // The probe's own adapters answer credential ids; these are never read.
    credentialIds: {},
  });
  return {
    ...host,
    adapters: {
      ...input.adapters,
      resolve: async (resolution) =>
        segmentBoundAdapter(await input.adapters.resolve(resolution), resolution.segmentId),
    },
  };
}
