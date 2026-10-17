// Adapter registry — central lookup from `adapterType` to a concrete Adapter
// implementation. Per Layer 3e (3e_adapters.md §Registration).

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { Adapter, AdapterManifest, BrandIcon } from 'movement-engine/services/translation_graph/adapter';
import type { PollSource, PollSourceFactory } from '../poll_source';
import type { ConfigBlock, TextBlock } from 'movement-engine/services/translation_graph/triggerConfig';

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { WRITE_METHODS } from 'movement-engine/services/translation_graph/adapter';
import { credentialTypeOf } from './credential_type';
import { KG_ADAPTER_TYPE, KG_MANIFEST, createKnowledgeGraphAdapter } from './knowledge_graph';
import { ATTIO_ADAPTER_TYPE, ATTIO_MANIFEST, createAttioAdapter } from './attio';
import {
  NATIVE_VALUATIONS_ADAPTER_TYPE,
  NATIVE_VALUATIONS_MANIFEST,
  createNativeValuationsAdapter,
} from './native_valuations';
import { SLACK_ADAPTER_TYPE, SLACK_MANIFEST, createSlackAdapter } from './slack';
import { TELEGRAM_ADAPTER_TYPE } from '@lf/telegram/types';
import { TELEGRAM_MANIFEST } from '@lf/telegram/manifest';
import { EMAIL_ADAPTER_TYPE, EMAIL_MANIFEST, createEmailAdapter } from './email';
import { WHATSAPP_ADAPTER_TYPE, WHATSAPP_MANIFEST, createWhatsappAdapter } from './whatsapp';
import { AIRTABLE_ADAPTER_TYPE, AIRTABLE_MANIFEST, createAirtableAdapter } from './airtable';
import { AFFINITY_ADAPTER_TYPE, AFFINITY_MANIFEST, createAffinityAdapter } from './affinity';
import {
  GOOGLE_SHEETS_ADAPTER_TYPE,
  GOOGLE_SHEETS_MANIFEST,
  createGoogleSheetsAdapter,
} from './google_sheets';
import {
  GOOGLE_DRIVE_ADAPTER_TYPE,
  GOOGLE_DRIVE_MANIFEST,
  createGoogleDriveAdapter,
} from './google_drive';
import {
  DROPBOX_ADAPTER_TYPE,
  DROPBOX_MANIFEST,
  createDropboxAdapter,
} from './dropbox';
import { CRON_ADAPTER_TYPE, CRON_MANIFEST, createCronAdapter } from './cron';
import { MANUAL_ADAPTER_TYPE, MANUAL_MANIFEST, createManualAdapter } from './manual';
import { GRANOLA_ADAPTER_TYPE, GRANOLA_MANIFEST, createGranolaAdapter } from './granola';
import { createGranolaPollSource } from './granola/poll';
import {
  EVERTRACE_ADAPTER_TYPE,
  EVERTRACE_MANIFEST,
  createEvertraceAdapter,
} from './evertrace';
import { createEvertracePollSource } from './evertrace/poll';
import { DEALROOM_ADAPTER_TYPE } from '@lf/dealroom/types';
import { DEALROOM_MANIFEST } from '@lf/dealroom/manifest';
import { builtinAdapterFactory, builtinPollSourceFactory } from './builtin_modules';
import { GMAIL_ADAPTER_TYPE, GMAIL_MANIFEST, createGmailAdapter } from './gmail';
import { createGmailPollSource } from './gmail/poll';
import { ASK_ADAPTER_TYPE, ASK_MANIFEST, createAskAdapter } from './ask';
import { SYSTEM_ADAPTER_TYPE, SYSTEM_MANIFEST, createSystemAdapter } from './system';
import { createSystemPollSource } from './system/poll';

/**
 * Factory signature: takes per-team + per-consumer context. Adapters that
 * need credentials (most external adapters) consume `credentialsId`;
 * intrinsic adapters (the knowledge graph) ignore it. Consumer wiring is
 * what pairs credentials with the adapter — for in-flows the credentials
 * live on `pipeline_input.credentials_id`, for out-flows on
 * `pipeline_output.credentials_id`.
 */
type AdapterFactory = (input: {
  teamId: TeamId;
  credentialsId?: string;
  /** Non-credential construction args (`google_sheets(…, spreadsheet: "X")`).
   *  Adapters that take an entry position read theirs from here; the rest
   *  ignore it. Threaded through `resolveAdapter` from both the checker's
   *  introspection and the runtime construction. */
  constructionArgs?: Record<string, string>;
}) => Adapter;

const ADAPTER_FACTORIES: Record<string, AdapterFactory> = {
  [KG_ADAPTER_TYPE]: ({ teamId, credentialsId }) =>
    createKnowledgeGraphAdapter({ teamId, credentialsId }),
  [ATTIO_ADAPTER_TYPE]: ({ teamId, credentialsId }) =>
    createAttioAdapter({ teamId, credentialsId }),
  // Affinity adapter — write target only (v3-output parity). Source-side
  // triggers (snapshot/poll) are deferred — Affinity has no v3 input — so it
  // appears as a target in the editor picker, not a source.
  [AFFINITY_ADAPTER_TYPE]: ({ teamId, credentialsId }) =>
    createAffinityAdapter({ teamId, credentialsId }),
  [NATIVE_VALUATIONS_ADAPTER_TYPE]: createNativeValuationsAdapter,
  [SLACK_ADAPTER_TYPE]: createSlackAdapter,
  // Telegram adapter — source (inbound messages + media) AND target (send a
  // message). Bot-token credential; inbound arrives by webhook
  // (preprocessInbound); outbound is the unified telegram:message, created
  // along Linked User.messages / msg.replies.
  // A module (@lf/telegram); its BUILTIN_MODULES line picks module or legacy.
  [TELEGRAM_ADAPTER_TYPE]: builtinAdapterFactory(TELEGRAM_ADAPTER_TYPE, ({ teamId, credentialsId }) => {
    const { createTelegramAdapter }: typeof import('./telegram') = require('./telegram');
    return createTelegramAdapter({ teamId, credentialsId });
  }),
  // Email adapter — source-only inbound email (body + attachments as
  // Resources). R4b landed unregistered so the wave-1a sub-wave could
  // touch the registry without collisions; G1 wires it in.
  // The createEmailAdapter factory ignores `credentialsId` — there are
  // no per-team email credentials in this build.
  [EMAIL_ADAPTER_TYPE]: ({ teamId }) => createEmailAdapter({ teamId }),
  // WhatsApp adapter — source-only inbound WhatsApp messages (body + media
  // as Resources). The phone-based twin of the email adapter. The factory
  // ignores `credentialsId` — there are no per-team WhatsApp credentials in
  // this build (the v3 Twilio creds live on `pipeline_input`).
  [WHATSAPP_ADAPTER_TYPE]: ({ teamId }) => createWhatsappAdapter({ teamId }),
  // Airtable adapter — read/write target plus webhook source. An optional
  // `base:` entry position (constructionArgs.base) scopes introspection to one
  // base, so a large workspace doesn't walk every base.
  [AIRTABLE_ADAPTER_TYPE]: ({ teamId, credentialsId, constructionArgs }) =>
    createAirtableAdapter({
      teamId,
      credentialsId,
      ...(constructionArgs?.base !== undefined ? { base: constructionArgs.base } : {}),
    }),
  // Google Sheets adapter — append-only write target (v3-output parity).
  // Source-side triggers (snapshot/poll) are deferred — Sheets has no v3
  // input — so it appears as a target in the editor picker, not a source.
  [GOOGLE_SHEETS_ADAPTER_TYPE]: ({ teamId, credentialsId, constructionArgs }) =>
    createGoogleSheetsAdapter({
      teamId,
      credentialsId,
      ...(constructionArgs?.spreadsheet !== undefined
        ? { spreadsheet: constructionArgs.spreadsheet }
        : {}),
    }),
  // Google Drive adapter — create-only write target (v3-output parity).
  // Source-side triggers (snapshot/poll) are deferred — Drive has no v3
  // input — so it appears as a target in the editor picker, not a source.
  [GOOGLE_DRIVE_ADAPTER_TYPE]: ({ teamId, credentialsId }) =>
    createGoogleDriveAdapter({ teamId, credentialsId }),
  // Dropbox adapter — create-only write target (v3-output parity). Source-side
  // triggers (snapshot/poll) are deferred — Dropbox has no v3 input — so it
  // appears as a target in the editor picker, not a source.
  [DROPBOX_ADAPTER_TYPE]: ({ teamId, credentialsId }) =>
    createDropboxAdapter({ teamId, credentialsId }),
  // Cron adapter — time as a source. Credential-free intrinsic; the
  // platform's movement scheduler emits its tick events (see
  // services/movement_scheduler/worker.ts).
  [CRON_ADAPTER_TYPE]: ({ teamId }) => createCronAdapter({ teamId }),
  // Manual adapter — on-demand runs. Credential-free intrinsic; "Run now"
  // injects an invocation event on the channel (movement/run_now.ts).
  [MANUAL_ADAPTER_TYPE]: ({ teamId }) => createManualAdapter({ teamId }),
  // Granola — polled source (meeting notes). The read-side Adapter; event
  // production lives on its PollSource (POLL_SOURCE_FACTORIES below).
  [GRANOLA_ADAPTER_TYPE]: ({ teamId, credentialsId }) =>
    createGranolaAdapter({ teamId, credentialsId }),
  // Evertrace — polled source (signals) AND write target (saved searches,
  // lists, list memberships, and the screened/viewed facts on a signal). Event
  // production lives on its PollSource (POLL_SOURCE_FACTORIES below).
  [EVERTRACE_ADAPTER_TYPE]: ({ teamId, credentialsId }) =>
    createEvertraceAdapter({ teamId, credentialsId }),
  // Dealroom — polled source (new funding rounds) and read-only otherwise: the
  // API has no record-writing endpoint at all. A module (@lf/dealroom); its
  // poll is the module's declared one (POLL_SOURCE_FACTORIES below).
  // Its line in BUILTIN_MODULES says module or legacy; either is loaded on
  // first use.
  [DEALROOM_ADAPTER_TYPE]: builtinAdapterFactory(DEALROOM_ADAPTER_TYPE, ({ teamId, credentialsId }) => {
    const { createDealroomAdapter }: typeof import('./dealroom') = require('./dealroom');
    return createDealroomAdapter({ teamId, credentialsId });
  }),
  // Ask adapter — the awaitable "ask a person" intrinsic (asks-as-adapter).
  // Credential-free, team-scoped; families (Check/Provide/Select/Review) are
  // its writable positions. Runs alongside the legacy `ask` statement.
  // Gmail — one connected Workspace mailbox, polled, read and written: a
  // movement can search it, run when mail arrives, and send or reply as the
  // mailbox. Event production lives on its PollSource (POLL_SOURCE_FACTORIES
  // below). Distinct from the `email` adapter, which only ever sees mail
  // FORWARDED to the deployment's inbound address.
  [GMAIL_ADAPTER_TYPE]: ({ teamId, credentialsId }) =>
    createGmailAdapter({ teamId, credentialsId }),
  [ASK_ADAPTER_TYPE]: ({ teamId }) => createAskAdapter({ teamId }),
  // System — the platform itself as a source (a run failed, …). Credential-
  // free and read-only; event production lives on its PollSource, which reads
  // the run table (POLL_SOURCE_FACTORIES below).
  [SYSTEM_ADAPTER_TYPE]: ({ teamId }) => createSystemAdapter({ teamId }),
};

/**
 * PollSource factories — parallel to `ADAPTER_FACTORIES`, keyed by adapter slug.
 * A slug may appear in one map, the other, or both: `Adapter` (read/write) and
 * `PollSource` (scheduled event production) are independent capabilities of a
 * package. The poll-source worker resolves a source here.
 *
 */
const POLL_SOURCE_FACTORIES: Record<string, PollSourceFactory> = {
  [GRANOLA_ADAPTER_TYPE]: ({ teamId, credentialsId }) =>
    createGranolaPollSource({ teamId, credentialsId }),
  [EVERTRACE_ADAPTER_TYPE]: ({ teamId, credentialsId }) =>
    createEvertracePollSource({ teamId, credentialsId }),
  [DEALROOM_ADAPTER_TYPE]: builtinPollSourceFactory(DEALROOM_ADAPTER_TYPE, ({ teamId, credentialsId }) => {
    const { createDealroomPollSource }: typeof import('./dealroom') = require('./dealroom');
    return createDealroomPollSource({ teamId, credentialsId });
  }),
  [GMAIL_ADAPTER_TYPE]: ({ teamId, credentialsId }) =>
    createGmailPollSource({ teamId, credentialsId }),
  [SYSTEM_ADAPTER_TYPE]: ({ teamId }) => createSystemPollSource({ teamId }),
};

/** Whether a slug (or trigger-kind alias) has a registered PollSource. */
export function isPollSource(adapterType: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    POLL_SOURCE_FACTORIES,
    resolveAdapterSlug(adapterType),
  );
}

/** Resolve a PollSource for the given type, or null when none is registered. */
export function getPollSource(input: {
  adapterType: string;
  teamId: TeamId;
  credentialsId?: string;
}): PollSource | null {
  const factory = POLL_SOURCE_FACTORIES[resolveAdapterSlug(input.adapterType)];
  return factory
    ? factory({ teamId: input.teamId, credentialsId: input.credentialsId })
    : null;
}

/**
 * Static adapter manifests — the construction-free, no-network source of truth
 * for every adapter's capabilities (`AdapterManifest`). Each adapter declares
 * its own; the framework reads them here. This replaces the former
 * `WRITABLE_ADAPTER_TYPES` / `ADAPTER_CREDENTIAL_TYPE` whitelists — writability
 * and required-credential-type are no longer special-cased centrally, they're
 * read off the adapter's manifest.
 *
 */
const ADAPTER_MANIFESTS: Record<string, AdapterManifest> = {
  [KG_ADAPTER_TYPE]: KG_MANIFEST,
  [ATTIO_ADAPTER_TYPE]: ATTIO_MANIFEST,
  [AFFINITY_ADAPTER_TYPE]: AFFINITY_MANIFEST,
  [NATIVE_VALUATIONS_ADAPTER_TYPE]: NATIVE_VALUATIONS_MANIFEST,
  [SLACK_ADAPTER_TYPE]: SLACK_MANIFEST,
  [TELEGRAM_ADAPTER_TYPE]: TELEGRAM_MANIFEST,
  [EMAIL_ADAPTER_TYPE]: EMAIL_MANIFEST,
  [WHATSAPP_ADAPTER_TYPE]: WHATSAPP_MANIFEST,
  [AIRTABLE_ADAPTER_TYPE]: AIRTABLE_MANIFEST,
  [GOOGLE_SHEETS_ADAPTER_TYPE]: GOOGLE_SHEETS_MANIFEST,
  [GOOGLE_DRIVE_ADAPTER_TYPE]: GOOGLE_DRIVE_MANIFEST,
  [DROPBOX_ADAPTER_TYPE]: DROPBOX_MANIFEST,
  [CRON_ADAPTER_TYPE]: CRON_MANIFEST,
  [MANUAL_ADAPTER_TYPE]: MANUAL_MANIFEST,
  [GRANOLA_ADAPTER_TYPE]: GRANOLA_MANIFEST,
  [EVERTRACE_ADAPTER_TYPE]: EVERTRACE_MANIFEST,
  [DEALROOM_ADAPTER_TYPE]: DEALROOM_MANIFEST,
  [GMAIL_ADAPTER_TYPE]: GMAIL_MANIFEST,
  [ASK_ADAPTER_TYPE]: ASK_MANIFEST,
  [SYSTEM_ADAPTER_TYPE]: SYSTEM_MANIFEST,
};

/**
 * Trigger kind → adapter slug aliases, built from each manifest's
 * `triggerKinds[]`.
 *
 * Trigger rows carry a `kind` mirroring `PipelineInputType` (uppercase enum
 * values like CUSTOM_EMAIL, MAILGUN, ATTIO). The runtime adapter registry
 * uses lowercase slugs (`email`, `attio`, etc.). N3 lets TG `sourceSchemaRef.adapterKind`
 * be the trigger kind (per N3-V's edge-anchoring rule), so the registry has
 * to resolve uppercase kinds to the correct lowercase adapter at lookup time.
 *
 * Derived from the adapters' own declarations (no hardcoded central map) so it
 * can't drift: an adapter that adds/renames an inbound channel kind only edits
 * its manifest. Multiple kinds can alias one adapter (all email-style triggers
 * share the email adapter — TWILIO is WhatsApp here, since the v3 twilio inbound
 * adapter validates the `whatsapp:` prefix on From/To).
 */
/**
 * Build the kind→slug alias map, asserting adapter-identity uniqueness across
 * every LOCAL manifest. Two adapters may never share a routing identity:
 * `resolveAdapterSlug` would otherwise be ambiguous and route events to the
 * wrong adapter. We reject at module load (fail-fast on a bad registration)
 * when:
 *   - two manifests declare the same `triggerKind` alias;
 *   - a `triggerKind` collides with a DIFFERENT adapter's canonical slug
 *     (the slug is always self-aliasing, so a kind equal to another adapter's
 *     slug would shadow it).
 *
 * The canonical slugs themselves are unique by construction — `ADAPTER_MANIFESTS`
 * is keyed by slug — but we also assert each manifest's `adapterType` matches
 * its registration key so a copy-paste can't desync them.
 *
 * Remote adapters resolve local-first (see `adapters/resolve.ts`); enforcing
 * the same uniqueness when a remote manifest is admitted lives at the
 * `remote_adapter` install seam, not here.
 */
function buildKindToAdapterSlug(): Record<string, string> {
  const slugs = new Set(Object.keys(ADAPTER_MANIFESTS));
  const map: Record<string, string> = {};
  for (const [key, manifest] of Object.entries(ADAPTER_MANIFESTS)) {
    // A test that stubs an adapter module can leave its manifest undefined;
    // skip rather than crash (real registrations are always present).
    if (!manifest) continue;
    if (manifest.adapterType !== key) {
      throw new Error(
        `Adapter manifest registered under key '${key}' declares adapterType ` +
          `'${manifest.adapterType}' — the slug and registration key must match.`,
      );
    }
    // Author-facing aliases (`resend` for email) and stored trigger kinds
    // (`CUSTOM_EMAIL`) are two vocabularies for the same thing — another name
    // that must land on exactly one adapter — so they are admitted together
    // and held to the same collision rules.
    for (const kind of [...(manifest.triggerKinds ?? []), ...(manifest.aliases ?? [])]) {
      if (kind === manifest.adapterType) continue; // self-alias, harmless
      if (slugs.has(kind)) {
        throw new Error(
          `Adapter '${manifest.adapterType}' declares triggerKind '${kind}', ` +
            `which collides with the canonical slug of another adapter.`,
        );
      }
      const existing = map[kind];
      if (existing && existing !== manifest.adapterType) {
        throw new Error(
          `Trigger kind '${kind}' is claimed by both '${existing}' and ` +
            `'${manifest.adapterType}'; each kind must route to exactly one adapter.`,
        );
      }
      map[kind] = manifest.adapterType;
    }
  }
  return map;
}

const KIND_TO_ADAPTER_SLUG: Record<string, string> = buildKindToAdapterSlug();

export function resolveAdapterSlug(adapterType: string): string {
  return KIND_TO_ADAPTER_SLUG[adapterType] ?? adapterType;
}

/**
 * Get an adapter for the given adapterType. Throws if not registered.
 *
 * Per the Layer 3e contract, this is the framework's only entry point for
 * obtaining adapter instances. Engine code routes all adapter calls through
 * the result of this function.
 *
 * Accepts either lowercase adapter slugs ('email', 'attio') OR uppercase
 * trigger-kind values ('CUSTOM_EMAIL', 'ATTIO') via the KIND_TO_ADAPTER_SLUG
 * alias map — N3 trigger orchestration lets TG bodies carry the trigger
 * kind on `sourceSchemaRef.adapterKind`.
 */
export function getAdapter(input: {
  adapterType: string;
  teamId: TeamId;
  credentialsId?: string;
  /** Non-credential construction args (e.g. Sheets' `spreadsheet:` entry
   *  position). Passed to the factory; position-free adapters ignore it. */
  constructionArgs?: Record<string, string>;
}): Adapter {
  const slug = resolveAdapterSlug(input.adapterType);
  const factory = ADAPTER_FACTORIES[slug];
  if (!factory) {
    throw new Error(
      `Unknown adapter type: ${input.adapterType}. Registered: ${Object.keys(ADAPTER_FACTORIES).join(', ')}`,
    );
  }
  return factory({
    teamId: input.teamId,
    credentialsId: input.credentialsId,
    ...(input.constructionArgs !== undefined ? { constructionArgs: input.constructionArgs } : {}),
  });
}

/** Whether an adapter for the given type is registered. */
export function hasAdapter(adapterType: string): boolean {
  const slug = resolveAdapterSlug(adapterType);
  return Object.prototype.hasOwnProperty.call(ADAPTER_FACTORIES, slug);
}

/**
 * The set of trigger kinds that resolve to the same adapter as `kind`
 * (its siblings). Scopes adapter-declared uniqueness checks: an email
 * slug must be unique across every email-style kind, since they all land
 * in the same inbound router.
 */
export function siblingKindsForAdapter(kind: string): string[] {
  const slug = resolveAdapterSlug(kind);
  const siblings = Object.keys(KIND_TO_ADAPTER_SLUG).filter(
    (k) => KIND_TO_ADAPTER_SLUG[k] === slug,
  );
  if (!siblings.includes(kind)) siblings.push(kind);
  return siblings;
}

/**
 * The trigger-config BLOCK list an adapter declares for `kind`, or null when
 * the kind has no registered adapter or declares no editable config. The full
 * {@link ConfigBlock} union (value + presentation + action blocks) — the host
 * renders all of them, the validator walks only the value ones. Read straight
 * off the static manifest — construction-free. Accepts a slug or trigger-kind
 * alias.
 */
export function getTriggerConfigSchema(input: {
  kind: string;
  teamId: TeamId;
}): readonly ConfigBlock[] | null {
  return getAdapterManifest(input.kind)?.triggerConfig ?? null;
}

/**
 * The adapter's INBOUND ROUTING KEY block, or null when it declares none —
 * the generic, de-named successor to `inboundChannel === 'forwarding-address'`.
 * An adapter whose inbound events arrive addressed by a config value (email's
 * plus-suffix `key`) marks that `triggerConfig` text/slug block
 * `routingKey: true`; provisioning, the listen vocabulary, and inbound dispatch
 * all route off this one declaration. Accepts a slug or trigger-kind alias.
 */
export function adapterInboundRoutingKey(
  adapterType: string,
): TextBlock | null {
  const blocks = getAdapterManifest(adapterType)?.triggerConfig;
  for (const block of blocks ?? []) {
    if ((block.kind === 'text' || block.kind === 'slug') && block.routingKey === true) {
      return block;
    }
  }
  return null;
}

/**
 * The address inbound events for this listen have to be sent TO, composed from
 * the routing-key block's own `prefix` + value + `suffix` (email:
 * `<local>+<key>@<domain>`, from `INBOUND_EMAIL_ADDRESS`). Null for an adapter
 * with no routing key, or a config
 * carrying no value for it.
 *
 * It lives beside the declaration it is composed from because more than one
 * reader needs it: provisioning surfaces it on the listener row, and the story
 * renderer says it out loud in the trigger's own sentence. A second spelling of
 * "how the address is built" is how two surfaces start telling a user two
 * different addresses.
 */
export function inboundAddressFor(
  adapterType: string,
  config: Record<string, unknown>,
): string | null {
  const field = adapterInboundRoutingKey(adapterType);
  if (!field) return null;
  const value = config[field.key];
  if (typeof value !== 'string' || value.length === 0) return null;
  return `${field.prefix ?? ''}${value}${field.suffix ?? ''}`;
}

/** Registered adapter types — for diagnostics, agent-facing schema introspection, etc. */
export function listAdapterTypes(): string[] {
  return Object.keys(ADAPTER_FACTORIES);
}

// ── Server-side adapter declarations (dynamic Read-from / Write-to) ─────────
// The editor used to hold these facts client-side (`TYPE_TO_SERVICE` +
// per-option `credentialServiceType` + a static TARGET_OPTIONS list). They
// live here now so the server is the single source of truth: the
// `listUsableSources` / `listUsableTargets` endpoints fold them with the
// team's live credentials + ontology, and the editor renders the result.
//
// Keyed by the canonical adapter slug (`listAdapterTypes()` values) — callers
// pass either a slug or a trigger-kind alias and `resolveAdapterSlug`
// normalises first.
//
// The manifests themselves are defined at the top of this module (the
// kind-alias map is derived from them); the accessors below read that map.

/** The static manifest for an adapter, or null when unknown. Accepts a slug or
 *  a trigger-kind alias. Construction-free — safe for bulk enumeration. */
export function getAdapterManifest(adapterType: string): AdapterManifest | null {
  return ADAPTER_MANIFESTS[resolveAdapterSlug(adapterType)] ?? null;
}

/** Every registered local adapter's manifest. */
export function listAdapterManifests(): AdapterManifest[] {
  return Object.values(ADAPTER_MANIFESTS);
}

/**
 * Index manifests by every name they answer to — the canonical slug plus the
 * author-facing aliases.
 *
 * Callers that look an adapter up by a name a HUMAN wrote (the movement
 * catalog, resolving `resend(…)` in a program) build their map with this
 * rather than keying on `adapterType` alone. A second, narrower spelling of
 * "which adapter is this name" is how a construction the registry resolves
 * fine becomes an instance the checker silently leaves untyped.
 */
export function indexManifestsByName(
  manifests: readonly AdapterManifest[],
): Map<string, AdapterManifest> {
  const index = new Map<string, AdapterManifest>();
  for (const manifest of manifests) {
    index.set(manifest.adapterType, manifest);
    for (const alias of manifest.aliases ?? []) index.set(alias, manifest);
  }
  return index;
}

/**
 * Monochrome brand mark for an adapter, or null when it declares none.
 * Manifest-first (`vocabulary.icon`) — absorbs the former core-side
 * `BRAND_ICONS` map (`adapters/brand-icons.ts`, deleted); every built-in
 * adapter with a public brand mark now declares it on its own manifest, so
 * there is no residual map to fall back to. Accepts a slug or trigger-kind
 * alias.
 *
 */
export function getBrandIcon(adapterType: string): BrandIcon | null {
  return getAdapterManifest(adapterType)?.vocabulary?.icon ?? null;
}

/**
 * The external-service credential type an adapter needs to be usable, or
 * `null` when it needs none — read off the manifest. Accepts a slug or alias.
 */
export function adapterRequiredCredentialType(
  adapterType: string,
): ExternalServiceType | null {
  return credentialTypeOf(getAdapterManifest(adapterType)?.requiredCredentialType);
}

/**
 * Whether an adapter is a valid TG target — derived from the manifest's
 * `methods[]` (it implements a write method), so writability can't drift from
 * what the adapter actually does. Accepts a slug or kind alias.
 */
export function isWritableAdapterType(adapterType: string): boolean {
  const manifest = getAdapterManifest(adapterType);
  if (!manifest) return false;
  return manifest.methods.some((m) =>
    (WRITE_METHODS as readonly string[]).includes(m),
  );
}

/**
 * A construction-free, credential-free capability summary for one adapter,
 * derived entirely from its manifest. The basis for letting the system
 * *surface what it can* — sources and targets — instead of scripting a
 * fixed list. `connected` is deliberately NOT here: whether a team has
 * authorised the credential is a per-team DB question the caller layers on
 * (the manifest only knows whether a credential is *required*).
 */
export interface AdapterCapabilitySummary {
  adapterType: string;
  displayName: string;
  /** Can originate an automation (declares at least one trigger). */
  canSource: boolean;
  /** Can be written to (implements a write method). */
  canTarget: boolean;
  /** Credential type needed to use it, or null when it needs none. */
  requiredCredentialType: ExternalServiceType | null;
  /** Uppercase trigger-kind aliases that route to this adapter (for provisioning). */
  triggerKinds: readonly string[];
}

/**
 * Every registered adapter's capability summary — the enumeration surface
 * for pickers and the setup agent. Pure: derived from the static manifests,
 * no construction, no network, no credentials.
 */
export function listAdapterCapabilities(): AdapterCapabilitySummary[] {
  return listAdapterManifests().map((m) => ({
    adapterType: m.adapterType,
    displayName: m.displayName,
    canSource: m.supportedTriggers.length > 0,
    canTarget: m.methods.some((x) => (WRITE_METHODS as readonly string[]).includes(x)),
    requiredCredentialType: credentialTypeOf(m.requiredCredentialType),
    triggerKinds: m.triggerKinds ?? [],
  }));
}
