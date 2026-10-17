// The installable manifest file for a remote Translation Graph adapter.
//
// A remote adapter is installed by importing a single manifest file that
// fully declares it. The manifest is BOTH the install artifact and the
// editable record — import writes the row, the UI form edits it, export reads
// it back. There is no live RPC required to install; the `manifest` protocol
// method stays an optional "refresh from server" action.
//
// `authStrategy` here mirrors `AuthStrategy` in `../../protocol/client` so the
// stored strategy feeds directly into `authHeader` at resolution time.
//
// Registration

import { z } from 'zod';
import { WireListenDeclarations, WireManifestProtocolVersion, WireModuleDeclarations } from 'engine-contracts';

import type { AdapterManifest } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerType } from 'movement-engine/services/translation_graph/triggers/types';

export const RemoteAdapterManifestFile = z.object({
  /** The adapter protocol version the server speaks. Required: a manifest
   *  without it predates protocol v2, whose wire currency differs. */
  protocolVersion: WireManifestProtocolVersion,
  /** Slug the engine routes on. One install per slug per team. */
  adapterType: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, 'adapterType must be ASCII lower case: a letter, then letters, digits or underscores'),
  /** Human-friendly name for the picker. Falls back to `adapterType`. */
  displayName: z.string().optional(),
  /** Human-friendly description for the picker. Optional. */
  description: z.string().optional(),
  /** Conceptual authoring documentation for this system — assembled into the
   *  automation handbook as a chapter, exactly like a built-in's. Optional;
   *  the same tier a built-in declares via `AdapterManifest.handbookSection`. */
  handbookSection: z
    .object({
      title: z.string().min(1),
      content: z.string().min(1),
      engineClaims: z
        .array(
          z.union([
            z.object({
              construct: z.string(),
              status: z.literal('runs'),
              probe: z.string(),
            }),
            z.object({
              construct: z.string(),
              status: z.literal('pending'),
              probe: z.string(),
              flag: z.string(),
            }),
          ]),
        )
        .optional(),
    })
    .optional(),
  /** Display vocabulary — icon + event phrasing — exactly like a built-in's
   *  `AdapterManifest.vocabulary`. Optional; omitted ⇒ the renderer core's
   *  generic composed fallback. */
  vocabulary: z
    .object({
      icon: z
        .object({
          d: z.string().min(1),
          fill: z.boolean().optional(),
          viewBox: z.string().optional(),
        })
        .optional(),
      eventPhrase: z
        .record(z.string(), z.array(z.object({ template: z.string().min(1) })))
        .optional(),
    })
    .optional(),
  baseUrl: z.string().url(),
  authStrategy: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('bearer') }),
    z.object({ kind: z.literal('shared_secret'), header: z.string().optional() }),
  ]),
  /** Listen-Fire-held credential → auth to the server. Never stored inline; only the
   *  FK. OPTIONAL: the shareable manifest artifact carries no secret and no
   *  pre-minted credential — the server fills this when the secret is supplied
   *  (one-step install, or a connect-link submit). A row with a null FK resolves
   *  to "needs connecting"; `resolveAdapter` errors until it is set. */
  credentialsId: z.string().uuid().optional(),
  supportedTriggers: z.array(z.string()),
  /** What a listen on it may say (`events: [...]` and further keys) — the same
   *  declarations a built-in's manifest makes, so the checker refuses a listen
   *  config this adapter would never route. */
  ...WireListenDeclarations.shape,
  /** What a module declares beyond its methods — the credential it needs,
   *  how its provider signs webhooks, its poll, its periodic tasks, the
   *  plugins it serves — exactly as its `manifest` answers them. All
   *  optional, so every manifest stored before they existed still parses.
   *  Not paired with `methods` here, as the protocol pairs them: a stored
   *  file could list `poll` without its declaration (the file used to drop
   *  it), and a stored row must never stop parsing. */
  ...WireModuleDeclarations.shape,
  /** Whole-adapter capability (mirrors `Adapter.runtimeCapabilities()`):
   *  incoming-edge traversal, edge properties, resources. Per-edge / per-field
   *  capability rides `describe()`, not here. */
  runtimeCapabilities: z.object({
    traversal: z.object({
      incoming: z.boolean(),
      edgeProperties: z.boolean(),
    }),
    resources: z.boolean(),
  }),
  /** Protocol methods the server implements. */
  methods: z.array(z.string()),
  /** Static config for the engine's generic `resolvePositionTypeId` — the
   *  adapter's webhook/synthetic event type. Pure config; carried in the
   *  manifest so a remote adapter resolves position types with no RPC. */
  webhookEventTypeId: z.string().optional(),
});

export type RemoteAdapterManifestFile = z.infer<typeof RemoteAdapterManifestFile>;

/** What an install is handed. The version a file claims is not trusted: install
 *  asks the server, and only a server answering version 2 is stored. The claim
 *  stays the only evidence for an install with no credential to ask with. */
export const RemoteAdapterManifestInput = RemoteAdapterManifestFile.extend({
  protocolVersion: WireManifestProtocolVersion.optional(),
});

export type RemoteAdapterManifestInput = z.infer<typeof RemoteAdapterManifestInput>;

/**
 * Decrypted payload of the remote adapter's credential row. The
 * `external_service_credentials` row stores `{ "secret": "<token>" }`
 * (JSON, encrypted at rest); resolution decrypts it, parses with this
 * schema, and feeds `secret` into `authHeader` to authenticate to the
 * remote server. Keeping the payload an object (rather than a bare string)
 * leaves room to carry auth metadata alongside the secret later without a
 * format migration.
 */
export const RemoteAdapterCredentialPayload = z.object({
  secret: z.string().min(1),
  /** The host's OAuth app at the provider, per declared `oauth2` credential:
   *  the host refreshes a connection's token with it, and it never leaves the
   *  host. Absent on every install stored before it existed. */
  oauthClients: z
    .record(z.string(), z.object({ clientId: z.string().min(1), clientSecret: z.string().optional() }))
    .optional(),
});

export type RemoteAdapterCredentialPayload = z.infer<typeof RemoteAdapterCredentialPayload>;

/**
 * Project an installed remote manifest into the SAME `AdapterManifest` shape
 * the static registry serves, so the per-team catalog machinery — capability
 * truth (`methods[]`), the agent catalog view, schemaShape, connect
 * advertising — sees remote installs exactly like built-ins:
 *
 *   - no `requiredCredentialType`: the install carries its own server secret
 *     (the credential FK), so a module that declares no credential constructs
 *     credential-free (`connect my_adapter`) — installed IS connected;
 *   - `declaredCredentials` when the module declares credentials: then each
 *     connection names the provider credential it acts as
 *     (`connect hs_alice using alice_hubspot`), never the server secret;
 *   - `introspectedSchema: true`: a remote schema is by definition fetched
 *     over the wire, never static.
 */
export function remoteAdapterManifest(file: RemoteAdapterManifestFile): AdapterManifest {
  return {
    adapterType: file.adapterType,
    displayName: file.displayName ?? file.adapterType,
    ...(file.description !== undefined ? { description: file.description } : {}),
    ...(file.handbookSection !== undefined
      ? { handbookSection: file.handbookSection }
      : {}),
    ...(file.vocabulary !== undefined ? { vocabulary: file.vocabulary } : {}),
    supportedTriggers: file.supportedTriggers as readonly TriggerType[],
    ...(file.subscribableEvents !== undefined ? { subscribableEvents: file.subscribableEvents } : {}),
    ...(file.defaultSubscribedEvents !== undefined
      ? { defaultSubscribedEvents: file.defaultSubscribedEvents }
      : {}),
    ...(file.listenConfig !== undefined ? { listenConfig: file.listenConfig } : {}),
    methods: file.methods,
    ...((file.credentials ?? []).length > 0
      ? { declaredCredentials: (file.credentials ?? []).map((declared) => declared.name) }
      : {}),
    introspectedSchema: true,
  };
}
