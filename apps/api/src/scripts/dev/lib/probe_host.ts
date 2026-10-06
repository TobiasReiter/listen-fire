// The host a dev probe runs the engine with: the production host — its locks,
// model clients and stores are what the probe exercises — with the probe's own
// adapters (a client pointed at a fake server) in place of the registry's.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { EngineHost } from '../../../services/movement_engine/host';
import { productionEngineHost } from '../../../services/translation_graph/movement/engine_host';

export function probeEngineHost(input: { teamId: TeamId; adapters: EngineHost['adapters'] }): EngineHost {
  const host = productionEngineHost({
    teamId: input.teamId,
    // A probe's movement imports no files: every import is not found.
    catalog: { resolveCredentialId: input.adapters.credentialId, resolveFile: () => undefined },
  });
  return { ...host, adapters: input.adapters };
}
