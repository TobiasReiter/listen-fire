/**
 * tRPC surface for the `/adapters` page — the catalogue of system types
 * Listen-Fire can talk to, read straight off the static adapter manifests
 * (`listAdapterManifests()`).
 *
 * Each entry carries the manifest's honest `description`, plain-language
 * capability flags derived from the manifest (reads = implements a read
 * method; writes = implements a write method; listens = declares at least
 * one trigger), and what the team needs to do to use it (`connectType` —
 * the credential type the Connect flow should create, or null when the
 * adapter is built in). `connectedCount` layers the per-team credential
 * state on top so the page can say "already connected".
 *
 * The movement language's `adapters` namespace imports an adapter by its
 * slug (`import { attio } from adapters`), so `importName` is the slug —
 * surfaced only when it's a valid movement identifier (a couple of
 * intrinsic slugs carry dashes and aren't importable yet).
 */

import type { TeamId } from '../../../generated/kysely/core/Team';

import { currentContext } from '../../../services/context';
import { trpc } from '../trpc';
import { getAutomationsQb } from '../../../lib/kysely';
import { listAdapterManifests } from '../../../services/translation_graph/adapters/registry';
import { WRITE_METHODS } from 'movement-engine/services/translation_graph/adapter';
import { importIdentifier } from 'movement-engine/services/translation_graph/movement/schema_projection';
import { userProcedure as sharedUserProcedure } from '../procedures';


export type AdapterCatalogEntry = {
  /** Canonical adapter slug — the engine's routing identity. */
  slug: string;
  name: string;
  description: string;
  /** Movement import name (`import { <name> } from adapters`), or null when
   *  the slug isn't a valid movement identifier. */
  importName: string | null;
  /** Movements can read records out of this system. */
  reads: boolean;
  /** Movements can create/update/delete records in this system. */
  writes: boolean;
  /** Can start a movement when something happens in this system. */
  listensForEvents: boolean;
  /** Credential type the Connect flow creates, or null when none is needed. */
  connectType: string | null;
  /** How many credentials of `connectType` the team already holds. */
  connectedCount: number;
};

/** Methods that let a movement read data back out of the system. */
const READ_METHODS = ['readRecord', 'getFieldValue', 'getRelated'] as const;

const adaptersRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    list: userProcedure.query(async (): Promise<AdapterCatalogEntry[]> => {
      const ctx = currentContext();
      const teamId = ctx.user.teamId as TeamId;

      const credentialRows = await getAutomationsQb(['external_service_credentials'])
        .selectFrom('external_service_credentials')
        .where('team_id', '=', teamId)
        .select(['type'])
        .execute();
      const credentialCountByType = new Map<string, number>();
      for (const row of credentialRows) {
        credentialCountByType.set(row.type, (credentialCountByType.get(row.type) ?? 0) + 1);
      }

      return listAdapterManifests()
        .map((m): AdapterCatalogEntry => {
          const connectType = m.requiredCredentialType ?? null;
          return {
            slug: m.adapterType,
            name: m.displayName,
            description: m.description ?? '',
            importName:
              m.adapterType === importIdentifier(m.adapterType) ? m.adapterType : null,
            reads: m.methods.some((method) =>
              (READ_METHODS as readonly string[]).includes(method),
            ),
            writes: m.methods.some((method) =>
              (WRITE_METHODS as readonly string[]).includes(method),
            ),
            listensForEvents: m.supportedTriggers.length > 0,
            connectType,
            connectedCount: connectType
              ? (credentialCountByType.get(connectType) ?? 0)
              : 0,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    }),
  });
};

export { adaptersRouter };
