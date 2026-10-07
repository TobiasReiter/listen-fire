import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { currentContext } from '../../../services/context';
import { trpc } from '../trpc';
import { RemoteAdapterManifestInput } from '../../../services/translation_graph/adapters/remote/manifest';
import {
  deleteRemoteAdapter,
  getRemoteAdapter,
  listRemoteAdapters,
  parseStoredManifest,
  type RemoteAdapterRow,
} from '../../../services/translation_graph/adapters/remote/store';
import { installRemoteAdapterFromManifest } from '../../../services/translation_graph/adapters/remote/install';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';

/**
 * tRPC router for managing remote Translation Graph adapter installs.
 *
 * Wraps the team-scoped `remote_adapter` store from Phase 5a. The team id
 * always comes from the authed context (`currentContext().user.teamId`) — it
 * is never taken as untrusted input, so an install can only ever touch the
 * caller's own team. The manifest IS both the install artifact and the
 * editable record, so `upsertFromManifest` validates against the existing
 * `RemoteAdapterManifestInput` zod schema rather than redefining the shape.
 *
 * The encrypted credential never travels through here — only the
 * `credentialsId` FK into `external_service_credentials`, which is safe to
 * project back to the UI.
 *
 * tRPC + UI
 */
/**
 * One list row. The display metadata + trigger/method capabilities live only in
 * the manifest jsonb, so the row is re-parsed; a manifest that no longer parses
 * becomes an `invalid` entry (still deletable) rather than failing the list.
 */
export function toListEntry(row: RemoteAdapterRow) {
  const id = row.id as unknown as string;
  const stored = parseStoredManifest(row);
  if (!stored.ok) {
    return { kind: 'invalid' as const, id, adapterType: row.adapter_type, reason: stored.reason };
  }
  const { manifest } = stored;
  return {
    kind: 'valid' as const,
    id,
    adapterType: row.adapter_type,
    displayName: manifest.displayName ?? null,
    description: manifest.description ?? null,
    supportedTriggers: manifest.supportedTriggers,
    methods: manifest.methods,
    baseUrl: row.base_url,
    authStrategy: row.auth_strategy,
    credentialsId: (row.credentials_id as unknown as string | null) ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const remoteAdapterRouter = (procedure: typeof trpc.procedure) => {
  return trpc.router({
    /**
     * List the remote adapters installed for the caller's team. Projects
     * each row to a UI-friendly summary — the scalar routing columns plus
     * the install timestamps. No encrypted secret is stored on the row;
     * `credentialsId` is just the FK, safe to surface.
     */
    list: procedure.query(async () => {
      const ctx = currentContext();
      const rows = await listRemoteAdapters({
        teamId: ctx.user.teamId as TeamId,
      });
      return rows.map(toListEntry);
    }),

    /**
     * Fetch a single installed adapter by slug, reconstructed back into its
     * full manifest shape (the editable record the UI form binds to).
     * Returns `null` when the team has no install under that slug.
     */
    get: procedure
      .input(z.object({ adapterType: z.string() }))
      .query(async ({ input }) => {
        const ctx = currentContext();
        const row = await getRemoteAdapter({
          teamId: ctx.user.teamId as TeamId,
          adapterType: input.adapterType,
        });
        if (!row) return null;
        const stored = parseStoredManifest(row);
        if (!stored.ok) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `The stored manifest for "${input.adapterType}" is no longer valid: ${stored.reason}`,
          });
        }
        return stored.manifest;
      }),

    /**
     * Install or update a remote adapter from a manifest file. Upserts on
     * `(team_id, adapter_type)` — re-importing the same slug edits the
     * existing install rather than creating a duplicate. The input is the
     * manifest (canonical `RemoteAdapterManifestInput` schema) plus an OPTIONAL
     * `secret`: when present, the adapter's auth secret is minted into an
     * encrypted `REMOTE` credential (bound to the slug) and linked in the same
     * step — install and connect are one felt action. The secret never enters
     * the stored manifest. Omit it to install now and connect the secret later
     * via the connect link. The protocol version is asked of the server with
     * the new secret, or the stored one on an edit; the form never claims it.
     */
    upsertFromManifest: procedure
      .input(RemoteAdapterManifestInput.extend({ secret: z.string().min(1).optional() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const { secret, ...manifest } = input;
        return installRemoteAdapterFromManifest({
          teamId: ctx.user.teamId as TeamId,
          userId: ctx.user.id as UserId,
          manifest,
          ...(secret !== undefined ? { secret } : {}),
        });
      }),

    /**
     * Uninstall a remote adapter for the caller's team. Idempotent — a
     * missing slug is a no-op (the team-scoped DELETE simply matches zero
     * rows).
     */
    delete: procedure
      .input(z.object({ adapterType: z.string() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await deleteRemoteAdapter({
          teamId: ctx.user.teamId as TeamId,
          adapterType: input.adapterType,
        });
        return { success: true };
      }),
  });
};

export { remoteAdapterRouter };
