// Adapter interface — the boundary between the translation-graph framework and
// per-external-system code. Per the adapter-minimalism principle (P11) and the
// architectural critique §C3, the framework owns expression evaluation and
// pushes everything system-specific into the adapter.

// Unprefixed `stream` (not `node:stream`) so rollup-dts treats it as an
// external builtin during tRPC type bundling instead of trying to inline
// it (which fails on the named `Readable` type export). Type-only import;
// no runtime effect.
import type { Readable } from 'stream';

import type { LinkedObject } from '../../generated/kysely/knowledge/LinkedObject';
import type { ResourceId } from '../../generated/kysely/knowledge/Resource';
import type ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import type { MutationContext } from './mutation_context';
import type { TriggerType } from './triggers/types';
import type { AwaitableCapability } from './awaitable';
import type { Actor } from './mutation_context';
import type { UniquenessConstraints } from './uniqueness';
import type { ConfigBlock } from './triggerConfig';
import type { HandbookSection } from '../../lib/handbook_section';
import type {
  SchemaDescriptor,
  SchemaEntryPoint,
  SchemaTypeDescriptor,
  SourcePosition,
} from './types';
import type { Expression } from '#shared/expression/types';

export type { ConfigBlock, TriggerConfigField } from './triggerConfig';

/**
 * Minimal user descriptor returned by Listen-Fire's `resolveActingUser`
 * (acting_user/resolve.ts) and consumed by the engine's meta resolver to
 * populate `@user_email`,
 * `@user_name`, and `@user_id`. Kept shape-loose (name optional) so
 * adapters that can only surface an email don't have to fabricate a
 * display name.
 *
 */
export interface ActingUser {
  id: string;
  email: string;
  name?: string | null;
}

/**
 * Raw event-side actor identity returned by `Adapter.extractActor`. Distinct
 * from `ActingUser`: an `ActorIdentity` is the external originator of the
 * event (the `From:` address on an email, the Slack user that posted, the
 * Attio actor that wrote a record) regardless of whether they are a
 * registered Listen-Fire team member. Powers `@actor_email` / `@actor_name` /
 * `@actor_id` so authors can compare "the team member responsible for this
 * dispatch" (`@user_*`) with "who actually originated the event" (`@actor_*`).
 *
 * Parsed from the event payload — no DB lookups — because actor identity
 * is a parse, not an auth decision. The method is async only so a remote
 * adapter can answer it over the wire; local impls are still pure parses.
 *
 */
export interface ActorIdentity {
  /** Primary key in the source system (email address, phone number,
   *  Slack user id, Attio actor id, etc.). */
  identifier: string;
  /** How this identity resolves to a Listen-Fire team user — the only thing the
   *  resolution logic cares about, independent of which adapter produced it:
   *    • `'email'`  — resolvable to a team user by email (the address is on
   *      `identifier` or `email`).
   *    • `'phone'`  — resolvable to a team user by phone number.
   *    • `'opaque'` — neither; a raw external id with no resolved email/phone,
   *      so it maps to no Listen-Fire user (e.g. a bare Slack/Attio id from the
   *      pure-parse `extractActor`). Resolvers skip it rather than guessing. */
  scheme: 'email' | 'phone' | 'opaque';
  /** Which adapter sourced this identity — provenance only; the resolution
   *  logic never branches on it (it branches on `scheme`). */
  adapterType?: string;
  /** Email address when the source carries one (every email event; Slack
   *  messages don't have this without an API call). */
  email?: string;
  /** Display name (the friendly part of `"Ada" <h@x>`; Slack display
   *  name; etc.). */
  name?: string;
  /** Fallback display label when `name` isn't available. */
  label?: string;
}

/**
 * An ordered actor candidate parsed from an inbound event by the adapter's
 * `getActorCandidates`. Distinct from `ActorIdentity` (the raw event
 * originator surfaced via `@actor_*`): a candidate is a *resolution input*
 * Listen-Fire's `resolveActingUser` maps to a team user. The `source` tag drives
 * the resolution order — `originator` candidates (who sent it) are matched
 * against non-service users first; `relay` candidates (the forwarding /
 * service inbox that delivered it) are matched against service users only.
 *
 */
export interface ActorCandidate {
  identity: ActorIdentity;
  /** who-sent-it (`originator`) vs forwarding/service-inbox (`relay`). */
  source: 'originator' | 'relay';
}

/**
 * A reference to a file's bytes that travels through the engine as a field
 * value — symmetric across the source→engine→target seam.
 *
 * Metadata (`name` / `contentType` / `size`) is always carried. The FileRef
 * carries its OWN byte channel via `retrieve()`, supplied by whatever produces
 * it; the consuming adapter calls it (`streamFileRef`). Byte resolution is not
 * an engine concern (plans/2026-06-18-fileref-resolution-rework).
 *
 * Branded so a plain object can't masquerade as a FileRef in the deep field
 * walk (`isFileRef`).
 *
 */
export interface FileRef {
  readonly __brand: 'FileRef';
  /** Display name. */
  name?: string;
  /** MIME type when known. */
  contentType?: string;
  /** Byte length when known. */
  size?: number;
  /**
   * Produce the bytes — supplied by whatever EMITS the FileRef (a source
   * adapter's `#resources`, the `FILE()` plugin, the remote adapter). The
   * lazy-at-write byte channel: a consuming adapter calls it at the write to
   * get the bytes, and does what its target API needs (upload them, or stash
   * to S3 + hand over a URL for the cross-wire / Airtable cases — `exposeFile`).
   * Always a FRESH stream and RE-CALLABLE — a consumer that needs the bytes
   * twice calls again, so a producer MUST support repeated retrieval.
   *
   * Optional on the type because a FileRef deserialized off the wire arrives
   * without its closure — the remote adapter re-binds it (`reviveFileRefs`)
   * before it reaches a consumer. `streamFileRef` throws on a FileRef that
   * still lacks it.
   */
  retrieve?(): Promise<ResolveFileRefResult>;
  /**
   * The producer's owner-resolvable handle. The remote adapter carries it ACROSS
   * THE WIRE so its `resolveFileRef` (which `retrieve()` binds to) can name the
   * file to the remote server. Local producers needn't set it — `retrieve()` is
   * self-contained.
   */
  source?: { ownerAdapterType: string; handle: string };
  /**
   * A short-lived, fetchable Listen-Fire URL for the bytes. Set when a FileRef is
   * written INTO a remote adapter: the `RemoteAdapter` boundary buffers the
   * bytes to S3 (`exposeFile`) and puts the URL here so the remote server can
   * fetch them (raw bytes can't ride the JSON wire). Absent for in-process
   * writes, which use `retrieve()` directly. Nullable because adapter file
   * VALUES (`FileValue extends FileRef`) carry a nullable `url` off raw JSON.
   */
  url?: string | null;
}

/**
 * Result of resolving a `FileRef` to its live bytes — owner-side. The engine
 * receives a Node `Readable` regardless of how the owner sourced it (local
 * adapters return the stream directly; `RemoteAdapter` converts a wire
 * `{ url }` to a stream via `fetch` + `Readable.fromWeb`).
 *
 */
export interface ResolveFileRefResult {
  stream: Readable;
  contentType?: string;
  size?: number;
}

// ── Adapter manifest ────────────────────────────────────────────────────────

/**
 * The protocol method names a write goes through. Used as the capability
 * basis for "is this adapter a valid TG target" — a manifest whose `methods`
 * include any of these writes meaningfully (`createRecord` is the canonical
 * one). Single source of truth, so writability can't drift from what the
 * adapter actually implements.
 *
 */
export const WRITE_METHODS = ['createRecord', 'updateRecord', 'deleteRecord'] as const;

/**
 * Static, construction-free description of an adapter — identical in shape for
 * LOCAL (built-in) and REMOTE (installed) adapters. Lets the framework
 * enumerate + filter adapters in bulk without constructing them (the prior
 * `WRITABLE_ADAPTER_TYPES` / `ADAPTER_CREDENTIAL_TYPE` whitelists existed only
 * because capabilities were instance fields that needed construction).
 *
 * `methods[]` is THE capability basis: it lists the protocol method names the
 * adapter genuinely implements (mirroring the remote `WireManifestResult.methods`).
 * `writable` / `readable` and every optional-method gate derive from it — no
 * separate flags, so they can't drift from the implementation. A local adapter
 * exports one of these as a static const registered alongside its factory; a
 * remote adapter's stored `WireManifestResult` maps onto it. Read uniformly via
 * `getAdapterManifest` / `listAdapterManifests`.
 *
 */
/**
 * Functional grouping for the public integrations grid — lets the marketing
 * site sort adapters by what they're for rather than alphabetically.
 */
export type IntegrationCategory =
  | 'CRM'
  | 'Email'
  | 'Messaging'
  | 'Files'
  | 'Spreadsheets'
  | 'Meetings';

export interface AdapterManifest {
  /** Stable slug the engine routes on — matches `Adapter.adapterType`. */
  adapterType: string;
  /** Human label for the picker, free of internal jargon. */
  displayName: string;
  /**
   * The provider's public website — surfaced as a link on the integrations
   * grid. Omitted for built-ins with no external provider (e.g. inbound email).
   */
  website?: string;
  /**
   * Functional grouping for the integrations grid (CRM, Files, …). Omitted ⇒
   * the integration falls into an "Other" bucket.
   */
  category?: IntegrationCategory;
  /**
   * One or two honest sentences about what the external system is and what
   * connecting it lets the team do. Surfaced on the Adapters page, the
   * public integrations grid, and any other catalogue UI; written for users,
   * not engineers. Optional only so remote/wire manifests without one stay
   * admissible — every built-in adapter should declare it.
   */
  description?: string;
  /**
   * Movement-authoring guidance for the agent — adapter-specific tips,
   * caveats, or field-usage hints that help the authoring agent write correct
   * movements. NOT surfaced on any public or user-facing page (the integrations
   * grid and the adapters catalogue both omit it). Included only where the agent
   * reads adapter info at authoring time (e.g. `describeMovementInstance`).
   * Optional; omit when the description alone is sufficient.
   */
  authoringHints?: string;
  /**
   * A conceptual handbook section for this system — what an author should know
   * BEFORE instantiating it (idioms, the choice between two approaches, the
   * behaviour that surprises). Assembled into the automation handbook as a
   * `system:<adapterType>` chapter, so it is bound by the same prose and
   * probe contract as every hand-written chapter.
   *
   * A different tier from `authoringHints`, which is per-instance guidance
   * served AFTER instantiation (`describeMovementInstance`); both may be
   * declared.
   */
  handbookSection?: HandbookSection;
  /** Triggers this adapter declares it can fire (mirrors `Adapter.supportedTriggers`). */
  supportedTriggers: readonly TriggerType[];
  /**
   * Protocol method names the adapter implements — the capability basis.
   * `writable` (includes a write method) and optional-method gating both read
   * this. Mirrors the remote `WireManifestResult.methods`.
   */
  methods: readonly string[];
  /**
   * External-service credential type "enough to connect". Omitted ⇒ the adapter
   * needs no credential (the KG is intrinsic; email / WhatsApp carry inbound
   * creds on the legacy `pipeline_input`). Relocated from `ADAPTER_CREDENTIAL_TYPE`.
   */
  requiredCredentialType?: ExternalServiceType;
  /**
   * `recordType` of the adapter's `meta` root — the signal that the adapter
   * supports a one-off meta-rooted fan-out ("sync everything now" → the Manual
   * source). Mirrors `Adapter.metaRecordType`; omitted by adapters with no meta
   * root.
   */
  metaRecordType?: string;
  /**
   * Trigger-kind aliases (uppercase `PipelineInputType`-style values like
   * `CUSTOM_EMAIL`, `ATTIO`) that route to this adapter. The registry builds
   * its kind→slug alias map from these, so the aliasing can't drift from what
   * the adapters declare. Multiple kinds may share one adapter (all
   * email-style inbound channels resolve to the email adapter); omit when the
   * adapter has no inbound trigger kind. The canonical slug
   * (`adapterType`) is always self-aliasing and need not be listed.
   */
  triggerKinds?: readonly string[];
  /**
   * Other names this same adapter answers to, in movement source and
   * everywhere else a name is resolved. Unlike `triggerKinds` (uppercase
   * dispatch values on stored trigger rows) these are names an AUTHOR writes:
   * email declares `mailgun` and `resend` so a deployment can say which
   * provider its mail runs through without that changing what the adapter
   * does. Registered like a kind alias, and held to the same uniqueness —
   * no two adapters may answer to one name.
   */
  aliases?: readonly string[];
  /**
   * A deployment-level setting this adapter needs and does not have.
   *
   * Not a credential (`requiredCredentialType` is that, and it is per team):
   * this is configuration of the installation itself, like the address inbound
   * mail is delivered to. A movement that references the adapter is recorded
   * as UNVERIFIED while it is missing, so an author is told rather than
   * shipping something that can never fire. Absent ⇒ nothing missing.
   */
  configurationGap?: string;
  /**
   * Config BLOCKS rendered for this adapter's TRIGGER role — the per-trigger
   * config on the automation detail page. An ordered {@link ConfigBlock} list:
   * value blocks (input/slug/select) collect values that persist to
   * `automations.trigger.config`; presentation blocks (section) frame them; an
   * action block (rare here) dispatches to an app handler. Carried on the
   * manifest so construction-free readers (the movement catalog's listen
   * vocabulary, provisioning, the adapters/trigger views) can see it without
   * building the adapter. The adapter instance's `triggerConfig` references it.
   *
   * This is the widened successor to the former `triggerConfigSchema`
   * (`TriggerConfigField[]`) — value blocks ARE that union; section/action are
   * the new arms. It is also where an adapter declares its INBOUND ROUTING KEY
   * (a value block marked `routingKey`) — the de-named successor to the former
   * `inboundChannel: 'forwarding-address'` flag. An adapter whose events arrive
   * addressed by a key (email's plus-suffix `key`) declares that block here,
   * and the framework routes generically off the declaration; there is no named
   * "forwarding address" concept in the engine.
   *
   * Omitted ⇒ the adapter's trigger role needs no user-editable config.
   *
   */
  triggerConfig?: readonly ConfigBlock[];
  /**
   * Config BLOCKS rendered for this adapter's CONSTRUCTION role — shown at an
   * adapter-instance slot in the movement editor (and the chat equivalent).
   * Value blocks bind construction args; ACTION blocks are the connect
   * affordances (the generalised "+"). Reserved here as the single home for
   * the construction-arg UI and the connect actions; the first ship uses it
   * only for `action` blocks. Omitted ⇒ no construction-time config UI.
   *
   */
  construction?: readonly ConfigBlock[];
  /**
   * The adapter's subscribable-event vocabulary — the named events external
   * subscriptions can be registered for (attio: `record.created` /
   * `record.updated` / `record.deleted`; the KG: its mutation change kinds
   * `create` / `update` / `delete`). One declaration drives:
   *   - listen-config validation: a `listen to <instance> { events: […] }`
   *     value outside this set is rejected at check time (the movement
   *     catalog projects it as the `events` key's value vocabulary);
   *   - subscription provisioning: `ensureEventSubscription` receives the
   *     union of the events the team's listens actually want.
   * Omitted ⇒ the adapter declares no subscribable events (its channel is
   * push-free or interpreted elsewhere — inbound email routed by its
   * `key`, the web Send box).
   */
  subscribableEvents?: readonly string[];
  /**
   * The `events:` selection a listen WITHOUT one is subscribed to — the
   * adapter's own dispatch default, declared so the checker derives the same
   * event type the runtime will deliver. WhatsApp is the motivating case: a
   * config-less listen receives MESSAGES ONLY (`triggerAcceptsWhatsappKind`),
   * so reactions/locations never fire a movement that didn't opt in — and the
   * checker must not type a config-less listen as delivering them. Absent ⇒
   * every subscribable event (the attio/airtable registration default).
   */
  defaultSubscribedEvents?: readonly string[];
  /**
   * Listen-config keys whose VALUES jointly scope an external subscription
   * channel, beyond the (adapter, credential) pair. Airtable's `['base',
   * 'table']` is the motivating case: webhooks are per-(base, table), so two
   * listens on different tables need distinct registrations. The listen
   * reconciler folds these config values into the channel key (one
   * `webhook_subscription` row + external webhook per distinct scope) and passes
   * them as `EnsureEventSubscriptionInput.scope`. Omitted ⇒ one channel per
   * (adapter, credential) — the Attio default.
   *
   */
  subscriptionScopeKeys?: readonly string[];
  /**
   * Additional listen routing-config keys this adapter declares, beyond
   * the derived ones (the inbound routing `key` from `triggerConfigSchema`,
   * the subscribable `events`). Each entry names the key, whether a listen MUST carry it,
   * and an optional value format the checker validates statically
   * (`'cron'` — a five-field cron expression, see @listen-fire/shared/cron).
   * The cron adapter's `schedule` is the motivating case:
   * `listen to timer { schedule: "0 9 * * 1" } fire digest`.
   */
  listenConfig?: readonly ListenConfigKey[];
  /**
   * Plain-language truth about WHAT a listener on this adapter actually fires
   * on — surfaced to the authoring agent via `describeInstance` so it grounds
   * its claims instead of inventing them. The motivating bug: an agent told a
   * user a Slack listener runs on "every message in any channel" when Slack
   * only delivers the events the bot is subscribed to (typically @-mentions).
   * Write the honest envelope and the caveats: what arrives by default, what
   * needs extra setup/scope, and "don't assume X — confirm" where the real
   * behaviour depends on external config the framework can't see. Omitted ⇒
   * the agent has no trigger prose and must confirm scope with the user
   * rather than asserting it.
   */
  triggerExpectation?: string;
  /**
   * Ownership gating for inbound events (message-write-unification §6.4b):
   * when true, the dispatcher processes an inbound event ONLY if its actor
   * resolves to a REGISTERED team user (the adapter's `getActorCandidates`
   * chain matched by `resolveActingUser`, WITHOUT trigger context — creator
   * override/fallback never pass the gate). The bot is never a registered
   * user, so self-echo drops for free; an unregistered person is dropped by
   * the same rule. Dropped events are recorded (receipt marked suppressed,
   * replayable), never silent. Set by adapters whose inbound channel is
   * globally addressable (Slack: anyone in the workspace can @-mention the
   * bot); adapters whose inbound is already identity-gated upstream omit it
   * (WhatsApp's sender→team resolution; Telegram's /start handshake binding
   * ON THE BUILT-IN SHARED BOT — a team running its own bot has no such
   * gate, so a BYO-bot team's inbound is not actually identity-gated here).
   */
  inboundRequiresRegisteredActor?: boolean;
  /** True when this adapter's schema comes from LIVE introspection of the
   *  connected workspace (attio, airtable, sheets, affinity) — a
   *  describeInstance costs upstream API calls, so callers should scope with
   *  `types`. Absent/false = the schema is static and describing is free. */
  introspectedSchema?: boolean;
  /**
   * Construction args that pick the instance's ENTRY POSITION — the node the
   * cursor starts at, instead of the meta node (Sheets' `spreadsheet:`,
   * Airtable's `base:`). Each names a construction arg and the meta-node
   * COLLECTION whose members are both its value enum and the node it lands on.
   * Optional args: omitted ⇒ the default (meta) position. The catalog surfaces
   * them as accepted construction args, types their value against the
   * collection, and threads the chosen value into construction (introspection
   * AND runtime). Omitted ⇒ the adapter has no entry position.
   */
  positionArgs?: readonly PositionArg[];
  /**
   * Per-adapter DISPLAY vocabulary for the read-only movement renderer and
   * any other human-facing surface (the integrations grid, the story page) —
   * same ownership story as {@link AdapterManifest.handbookSection}: the
   * adapter is the only thing that knows how to talk about itself, so the
   * renderer core stays adapter-blind and consumes only what is declared
   * here. Optional; a missing field renders a generic composed fallback
   * rather than failing.
   *
   */
  vocabulary?: AdapterVocabulary;
}

// ── Adapter display vocabulary ──────────────────────────────────────────────
//
// Absorbs two former core-side maps that violated adapter encapsulation:
// the icon lookup (`adapters/brand-icons.ts`'s `BRAND_ICONS`) and the event
// phrasing switch (`lib/automation/describe.ts`'s `describeSource`, plus a
// near-duplicate in the home dashboard view). Both are now adapter-owned,
// optional manifest fields — see plans/movement-renderer-2026-08-03/1_shape.md §2.

/**
 * Monochrome brand mark for an adapter — the integrations grid and (later)
 * the movement renderer render it with `fill: currentColor` unless `fill` is
 * false (stroke marks). Ported verbatim from the product app's
 * `service-icon.tsx`; the web app keeps its own copy (a later sweep unifies
 * them) so this shape must stay byte-identical to what `apps/web` expects.
 */
export interface BrandIcon {
  d: string;
  fill?: boolean;
  viewBox?: string;
}

/**
 * One candidate sentence for an adapter event. `{slot}` tokens are filled
 * from the trigger/listen config using the ADAPTER'S OWN config key names
 * (its listen-config / narrowing / routing keys) — the resolver
 * (`services/translation_graph/vocabulary.ts`) does plain string
 * substitution only, never interprets what a slot means. A template whose
 * slot has no matching (non-empty string) config value is skipped, so an
 * adapter can express "prefer the fuller phrasing, fall back to the terser
 * one" as an ORDERED list (email: full address → routing tag → bare).
 */
export interface EventPhraseTemplate {
  template: string;
}

/**
 * The adapter's event-phrasing vocabulary — "When an email arrives at …",
 * "When a record changes in Attio". Keyed by the adapter's own
 * `subscribableEvents` names where it has discrete events (Attio's
 * `record.created`, the KG's `create`); `default` is rendered when the
 * config's selected events don't match a more specific key, or the adapter
 * has no discrete event vocabulary at all (email, Slack — one implicit
 * channel). A manifest with no entry for the resolved key falls through to
 * the renderer core's generic composed phrase, never a per-adapter case
 * living outside the manifest.
 */
export type AdapterEventPhraseVocabulary = Record<string, readonly EventPhraseTemplate[]>;

export interface AdapterVocabulary {
  /** Absorbs the former core-side `BRAND_ICONS` map — see
   *  `adapters/registry.ts`'s `getBrandIcon`. */
  icon?: BrandIcon;
  /** Absorbs `describeSource()`'s per-adapter switch cases. */
  eventPhrase?: AdapterEventPhraseVocabulary;
}

/** One entry-position construction arg — see {@link AdapterManifest.positionArgs}. */
export interface PositionArg {
  /** The construction-arg name, e.g. `spreadsheet`. */
  name: string;
  /** The meta-node collection whose members are the value enum and the landed
   *  node (Sheets: `Spreadsheet`). */
  optionsFrom: string;
  /** Author-facing label (defaults to `name`). */
  label?: string;
}

// Interactive "connect" actions are no longer a manifest field of their own —
// they fold into `action` blocks inside `construction` (config-blocks Phase 3,
// `plans/2026-06-14-config-blocks/5_migration.md`). The former
// `connectActions: ConnectAction[]` and the `ConnectAction` interface are
// deleted; the catalog projection (`movement/catalog.ts`) reads the action
// blocks out of `construction` and emits the same `{ kind, label }` the editor
// and chat suggestion engine consume. The app-shipped handler registry,
// `ConnectActionContext`, and `SuggestedAction.connectAction` are untouched —
// action blocks are a new PLACEMENT, not a new dispatch.

/** One adapter-declared listen routing-config key (see
 *  `AdapterManifest.listenConfig`). */
export interface ListenConfigKey {
  key: string;
  /** A listen on this adapter must carry the key. */
  required?: boolean;
  /** Static value validation the movement checker applies. `'cron'` = a
   *  five-field cron expression; `'timezone'` = an IANA time-zone id;
   *  `'fields'` = a list of BARE property names, validated against the position
   *  the listen's address lands on (the changed-attribute filter — any adapter
   *  with a "only fire when one of these changed" surface declares it);
   *  `'strings'` = a non-empty list of non-empty quoted strings (Gmail's
   *  `labels`). */
  format?: 'cron' | 'timezone' | 'fields' | 'strings';
  /**
   * This key is one HOP of the address that narrows the event's record edge.
   *
   * A listen is shorthand for a WHERE. `listen to at { base: "appDevLoop",
   * table: "tblDeals" }` says which table the event's `record` edge lands on,
   * so the author must not have to restate it in the movement — the config IS
   * the address.
   *
   * The keys that declare `narrows` form a PATH, in declaration order, each hop
   * selecting a member of `collection` whose published data has `matchField`
   * equal to the config value:
   *
   *   -[:Base WHERE `Id` == "appDevLoop"]->-[:Table WHERE `Id` == "tblDeals"]->
   *
   * A path, NOT one hop with a compound WHERE — that is the whole cost
   * argument. Read as one hop, "narrowed by (base, table)" must know the valid
   * (base, table) pairs, which is a `listTables` per base: the 1+N this plan
   * exists to kill. As a path the base resolves first (1 call) and only THAT
   * base's tables are walked (1 call).
   *
   * The final hop's `collection` is the type the record edge narrows FROM —
   * an event edge targeting it is retargeted at whatever the walk landed on.
   *
   */
  narrows?: {
    /** The meta-graph collection whose members this hop selects from
     *  (Airtable's `Base`, then `Table`). */
    collection: string;
    /** The field of a member's PUBLISHED DATA the config value is matched
     *  against. A listen names things by ID while type-space addresses by NAME,
     *  so this is normally the id field — and the adapter must publish it on
     *  the member's position or nothing can narrow. */
    matchField: string;
  };
}

// ── Event subscriptions (the listen-reconciliation seam) ──────────────────
//
// Movement `listen` statements are reconciled into trigger rows on save;
// adapters whose events arrive by EXTERNAL subscription (webhooks) expose
// these two optional methods so reconciliation can diff-sync the external
// registration as listens come and go. The platform owns the stable
// per-(adapter, credential) callback URL (a `webhook_subscription` row —
// keyed to the credential, NOT the listen, so reconciliation never changes
// inbound URLs) and the inbound verification path (webhook_sync); the
// adapter owns the source-system API calls.
//
// Adapters whose platform machinery doesn't exist yet implement these as
// DOCUMENTED no-ops (return undefined) or omit them entirely; the KG needs
// neither (mutation dispatch is in-process).

export interface EnsureEventSubscriptionInput {
  /** The events the subscription should now cover — the union of every
   *  listen's `events` config on this (adapter, credential[, scope]) channel,
   *  defaulting to the manifest's full `subscribableEvents`. */
  events: string[];
  /** The stable per-channel URL the source should POST to. */
  callbackUrl: string;
  /** The registration currently held for this URL, when one exists — the
   *  diff-sync input. `events` is what the source is registered for now. */
  current?: { externalId?: string; events: string[] };
  /**
   * The channel's adapter-declared scope (the `subscriptionScopeKeys` config
   * values) — e.g. Airtable's `{ base, table }`. Empty/absent for adapters
   * whose channel is just (adapter, credential). The adapter reads what it
   * declared; the reconciler passes it through opaquely.
   */
  scope?: Record<string, string>;
}

/** What the source issued — the platform persists it on the subscription
 *  row (the secret verifies inbound signatures). Returning `undefined`
 *  means "nothing registered" (a documented no-op adapter). */
export interface EventSubscriptionRegistration {
  /** Source-issued subscription id, when registered via API. */
  externalId?: string;
  /** HMAC secret for inbound signature verification, when issued. */
  secret?: string;
}

export interface RemoveEventSubscriptionInput {
  callbackUrl: string;
  /** The source-issued id held for this URL, when one exists. */
  externalId?: string;
  /** The channel's adapter-declared scope (mirrors
   *  {@link EnsureEventSubscriptionInput.scope}) — Airtable's per-base delete
   *  needs the `base` to address the webhook. Absent for unscoped channels. */
  scope?: Record<string, string>;
}

// ── Adapter contract ──────────────────────────────────────────────────────

export interface Adapter {
  /** Stable identifier — matches `MutationContext.source.adapterType`. */
  readonly adapterType: string;

  /**
   * The AWAITABLE capability (asks-as-adapter §A) — present ONLY on adapters
   * that advertise awaitable edges (`await x-[:E]->`). It answers whether an
   * awaited edge has resolved and, if not, the key that will wake it; the engine
   * keeps the correlation itself. Absent on every ordinary adapter.
   * Delivery-orthogonal (P12) — this is not rendering or delivery.
   */
  readonly awaitable?: AwaitableCapability;

  /**
   * Triggers this adapter declares it can fire (P11). Poll is universal
   * fallback, not framework default. Snapshot/changes-feed/webhook/mutation
   * are per-adapter opt-in.
   */
  readonly supportedTriggers: readonly TriggerType[];

  /**
   * Whole-adapter capability declaration — can the source traverse incoming
   * edges, carry edge properties, expose resources? Static (no credential),
   * so it's a plain method returning a constant. The engine consults it at
   * evaluation time; per-edge / per-field capability lives on `describe()`.
   *
   */
  runtimeCapabilities(): RuntimeCapabilities;

  // ── 1. Schema introspection ──────────────────────────────────────────
  // Two complementary primitives drive every consumer:
  //   • `listEntryPoints` — lightweight catalog (no per-type API
  //     calls). Editor pickers and adapter-level capabilities ride
  //     here.
  //   • `describe(typeId)` — per-type detail loader. Every consumer
  //     (editor, engine polymorphic narrowing) calls this for the
  //     specific type it lands on. Adapters cache results so
  //     repeated calls amortise to a single fetch per-type
  //     per-cache-window.
  //
  // No whole-schema rollup primitive exists by design — every code
  // path operates on at most one type at a time, so paying the
  // descriptor fan-out would be pure waste.

  /**
   * Lightweight catalog of entry-point types: those the editor's "Add
   * action" picker can offer as a starting point (writable types) plus
   * any types that author-time UI needs to enumerate (e.g. Attio's
   * webhook_event meta type). NO per-type API calls — adapters
   * answer this from a single `listObjects` call (or hardcoded for
   * the KG / synthetic types).
   */
  listEntryPoints(): Promise<SchemaEntryPoint[]>;

  /**
   * Full descriptor for a single type — fields, references, scope,
   * labelTemplate. The editor calls this on-demand as the user
   * navigates the schema; adapters fetch the per-type attributes
   * lazily. Returns null when the typeId isn't recognized.
   */
  describe(typeId: string): Promise<SchemaTypeDescriptor | null>;

  /**
   * Forget whatever this adapter has cached about its system's SHAPE — the
   * field catalog, the collections, the workspace identity.
   *
   * Called where a person has just had reason to change it: the forced refresh
   * behind `describeConnection`, and a credential being (re)connected. An
   * adapter that caches nothing has nothing to do here and may leave it out.
   */
  invalidateSchemaCache?(): void | Promise<void>;

  /**
   * Walk the META-GRAPH of types (optional).
   *
   * Introspection is a walk, not a dump: from the schema root (`meta`), the
   * types reachable independently; from a type node, its fields and the edges
   * leaving it; and so on, recursively. `edgesFrom` is that one primitive —
   * `listEntryPoints()` is `edgesFrom(meta)` and `describe(T)` is
   * `edgesFrom(T)`, which is why the three eventually collapse into it.
   *
   * A POSITION IS A PATH from the root. That is the whole point: it carries
   * whatever identifies the node in the source graph, so following an edge
   * costs one upstream call rather than a re-derivation. An Airtable table's
   * position carries its base id, because you can only reach a table through
   * its base — so the caller never re-walks the workspace to route a name.
   * Callers do not construct positions; they echo back one this method handed
   * them on a previous hop's `targetPositions`.
   *
   * These are META-graph positions (type nodes), NOT data-graph positions
   * (records). An adapter keeps them in its own meta vocabulary — Airtable's
   * `Base` / `Table` — so a type node can never be mistaken for a record of
   * that type. The framework's NAME for the type stays the edge's
   * `targetTypeId`; the position is only how the adapter gets back there.
   *
   * Optional, and additive: an adapter of UNIFORM schema (one type-edge per
   * type, however many records sit behind it) is already correct via
   * `listEntryPoints` + `describe` and needs no `edgesFrom`. Only adapters
   * whose schema VARIES per instance — two Airtable bases hold different
   * tables, so they are two types, not two instances of one — have a
   * meta-graph deep enough to walk. Callers fall back to `describe`.
   *
   * Returns null when the position isn't recognised (the same contract as
   * `describe`'s unknown typeId).
   *
   */
  edgesFrom?(position: SourcePosition, cursor?: unknown): Promise<EdgesFromResult | null>;

  /**
   * This adapter's meta graph has CONTAINERS — an Airtable base holding
   * tables, a spreadsheet holding sheets, a list holding its entries. So
   * describing its published entry list is not a local lookup: it walks every
   * container, one call each.
   *
   * That cost is the reason a full-surface describe is refused for these
   * adapters (`instance_cache.ts`), and it is a fact about the SHAPE of the
   * graph, not about whether the adapter implements `edgesFrom`. Keying the
   * refusal off `edgesFrom` conflated the two and silently hollowed out the
   * describe of every uniform adapter the moment it learned to walk —
   * positions came back `undescribed`, with no properties and no error.
   *
   * Absent ⇒ uniform: every type is located by its type id, `describe` is a
   * local lookup, and there is nothing to fan out over.
   *
   */
  readonly walksContainers?: boolean;

  /**
   * Type id for this adapter's webhook/synthetic event positions — the
   * engine resolves an unstable position's type to this. Pure config;
   * declared in the manifest for remote adapters. A stable position
   * resolves to its own `recordType`; an unstable position resolves to
   * this id (e.g. Attio's `attio:webhook_event`). Adapters with no
   * synthetic event positions leave it undefined.
   *
   * Consumed by the generic `resolvePositionTypeId` engine resolver
   * (`engine/position_type.ts`), which replaced the former per-adapter
   * `getPositionTypeId` method now that the logic is purely config.
   */
  readonly webhookEventTypeId?: string;

  /**
   * `recordType` value of this adapter's `meta` root that should resolve
   * to null (rather than `webhookEventTypeId`) when carried on an
   * unstable position. Only adapters whose meta root flows through
   * position-type resolution need it (Listen-Fire Valuations); pure config.
   */
  readonly metaRecordType?: string;

  /**
   * Config blocks this adapter exposes for its trigger role — the
   * {@link ConfigBlock} list a user's automation-detail form renders for a
   * `automations.trigger` whose `kind` resolves to this adapter (e.g. the
   * inbound-email forwarding-address framing + slug). One declaration drives
   * the form, the write-path validation (`updateTriggerConfig`), and the
   * runtime config-validity check. Pure config; omitted by adapters whose
   * trigger role needs no user-editable settings. Mirrors the manifest's
   * `triggerConfig`.
   *
   */
  readonly triggerConfig?: readonly ConfigBlock[];

  /**
   * Ensure the source system delivers the named events to `callbackUrl` —
   * the listen-reconciliation seam (see the module-level event-subscription
   * notes above `EnsureEventSubscriptionInput`). Idempotent: called with
   * the full desired event set every time the team's listens change; the
   * adapter diffs against `current` and registers / updates as needed.
   * Implemented for real where the source has a subscription API (attio
   * webhooks); a documented no-op (return undefined) where it doesn't;
   * omitted where events need no external registration at all.
   */
  ensureEventSubscription?(
    input: EnsureEventSubscriptionInput,
  ): Promise<EventSubscriptionRegistration | undefined>;

  /** Tear down the registration `ensureEventSubscription` created — called
   *  when the last listen on the (adapter, credential) channel retires. */
  removeEventSubscription?(input: RemoveEventSubscriptionInput): Promise<void>;

  // ── 2. Entity resolution ──────────────────────────────────────────────
  /**
   * Match an inbound record against existing linked_objects. The framework
   * supplies candidates filtered by adapterType + recordType; the adapter
   * decides match/no-match using whatever natural keys fit.
   */
  resolveEntity(input: ResolveEntityInput): Promise<ResolveEntityResult>;

  // ── 3. Field-level access (replaces evaluateTraversal per critique §C3)
  /**
   * Read a single field value at a position. For in-memory sources this is
   * a local lookup; for external sources it may consult cached payload data
   * within the position itself.
   */
  getFieldValue(input: GetFieldValueInput): Promise<unknown>;

  /**
   * Resolve a reference field at a position to one or more related positions.
   * For in-memory sources: local graph traversal. For external sources: may
   * invoke API calls; any fetch caching is internal to the adapter.
   */
  getRelated(input: GetRelatedInput): Promise<RelatedResult[]>;

  /**
   * Streaming variant of `getRelated` — adapters that can yield results
   * incrementally implement this so the engine doesn't have to hold the
   * full result set in memory. Used primarily for the snapshot fan-out
   * (`getRelated(adapter-meta, collection)`) where the collection may
   * contain millions of records. When this method is present, the engine
   * prefers it over `getRelated`; absent, the engine falls back to the
   * eager collection path.
   *
   * Adapters with no genuine streaming source (in-memory KG traversal,
   * single-record webhook lookups) can leave this undefined — the engine
   * just collects via `getRelated`.
   */
  iterateRelated?(input: GetRelatedInput): AsyncIterable<RelatedResult>;

  // ── 4. Event seams ────────────────────────────────────────────────────
  // The adapter turns an UNSOLICITED inbound signal into a stream of
  // `DiscriminableEvent`s; the engine discriminates each against the declared
  // `listEventTypes()` union into a typed root position and runs the trigger.
  //
  //   • UNSOLICITED (`preprocessInbound`) — any unprompted inbound signal
  //     (webhook, arriving email, dropped file) normalised into events.
  //
  // SOLICITED pull (poll a source on a schedule for new/changed events) is NOT
  // an adapter concern — it lives on the separate `PollSource` interface
  // (`poll_source.ts`), driven by the poll-source worker, so this interface
  // stays about reading and writing records.

  /**
   * Unsolicited push. Turn a raw inbound signal into a stream of discriminable
   * events, doing whatever work that needs — including an async API fetch to
   * pull the actual changes when the signal is only a thin "something changed"
   * ping (Airtable), or to type a thin payload (in which case it sets each
   * event's `tag`). A provider that delivers full payloads in the body (Attio)
   * just splits the batch with no I/O.
   *
   * `checkpoint` carries the per-subscription cursor from the prior delivery
   * (opaque to the framework); the returned `checkpoint` is persisted and fed
   * back next time. Push providers that hold no cursor ignore it and return it
   * unset. This mirrors `PollSource.getEvents` — the two seams differ only in
   * what wakes them (a delivery vs a timer).
   */
  preprocessInbound?(input: { raw: unknown; checkpoint?: unknown }): Promise<{
    events: DiscriminableEvent[];
    checkpoint?: unknown;
  }>;

  /**
   * The wake door, separate from `preprocessInbound`'s events: the correlation
   * keys (as `awaitable.resolveAwait` names them when pending) that this raw
   * inbound payload may have resolved. The engine resumes whatever is parked on
   * them; a key nothing waits on is a no-op. No ordering against the events —
   * a resumed await re-checks live, so it never relies on the payload.
   */
  wakeKeys?(input: { raw: unknown }): Promise<string[]>;

  /**
   * The instance-aware union of event types this connection can emit. The
   * engine discriminates `DiscriminableEvent`s against it (and the editor runs
   * author-time type logic over it). Connection-level, like `listEntryPoints`.
   */
  listEventTypes?(): Promise<EventType[]>;

  // ── 5. Writes (called by the evaluator for out-flows) ─────────────────
  // A write returns the written record and nothing else. Mutation events are
  // NOT a write's return value: every adapter's changes reach dependent
  // automations through its own inbound event channel (M-38).
  createRecord(input: WriteInput): Promise<WriteResult>;
  /**
   * Write an EXISTING record by id. Beyond the fields, an update answers for
   * the parent association the write named (`UpdateWriteResult.association`):
   * a matched record whose fields were all unchanged is reported to the author
   * as an attach, and that report is only honest if the adapter says whether
   * the attach happened.
   */
  updateRecord(input: UpdateInput): Promise<UpdateResult>;
  deleteRecord(input: DeleteInput): Promise<DeleteResult>;

  // ── 5b. Optional: link two existing records ───────────────────────────
  /**
   * Assert a relationship between two records that BOTH already exist —
   * the write primitive behind the movement language's standalone
   * `edge a -[:e]-> b` statement. Record *creation* wires its links via
   * `WriteInput.parentLinks`; this covers the rare case where neither side
   * is being written.
   *
   * `edgeName` arrives in the adapter's own currency, resolved against the
   * FROM side's schema (KG: the ontology edge display name, exactly what
   * `ParentLink.edgeName` already resolves; external systems: the reference
   * fieldId `describe(from.recordType).references` publishes). Idempotent:
   * an already-present link returns `created: false` with no side effects.
   *
   * Optional — adapters without a uniform "link two records" call (their
   * reference-value shapes don't support a free-standing assert) omit it;
   * callers reject up front with the adapter named. Manifests list
   * `linkRecords` in `methods` where genuinely implemented.
   */
  linkRecords?(input: LinkRecordsInput): Promise<LinkRecordsResult>;

  /**
   * Sever a relationship between two existing records — the inverse of
   * `linkRecords`, behind the movement language's `unlink a -[:e]-> b`
   * statement. Same input currency (from / edgeName / to, the edge resolved
   * against the FROM side's schema). Idempotent: an absent link returns
   * `removed: false` with no side effects.
   *
   *   - KG: delete the resolved edge row (its evidence cascades) and emit
   *     one adjacency-changed mutation event per endpoint — the mirror of
   *     `linkRecords`' insert.
   *   - External systems: read-modify-write the from side's reference
   *     field — remove the target from a multi-reference, clear a
   *     single-reference that points at it.
   *
   * Optional — adapters without a free-standing unlink omit it; callers
   * reject up front with the adapter named. Manifests list `unlinkRecords`
   * in `methods` where genuinely implemented.
   */
  unlinkRecords?(input: UnlinkRecordsInput): Promise<UnlinkRecordsResult>;

  // ── 5a. Optional: field functions ─────────────────────────────────────
  /**
   * Run an adapter-provided expression function scoped to a writable field
   * (the bodies behind a field's advertised `functions`, see
   * `SchemaFieldDescriptor.functions`). Called by the evaluator when a field
   * mapping's expression invokes a non-built-in function that the target
   * field advertises — e.g. Slack's `SLACK_MESSAGE`. Adapters without field
   * functions leave this undefined.
   *
   * The function is ordinary in every way but two (P8): its scope is the
   * field, and its body is here rather than in the engine's built-in table.
   * Input + output are serialisable so a remote adapter answers over the
   * wire. The body gets no roster/channel — anything channel-scoped (Slack
   * mention resolution) happens later at the write boundary.
   *
   */
  invokeFieldFunction?(input: InvokeFieldFunctionInput): Promise<unknown>;

  // ── 6. Optional: read for no-op detection (P14.2) ─────────────────────
  /**
   * Adapters that can read cheaply implement this so the engine can skip
   * writes whose values haven't changed. Adapters without it: writes
   * unconditionally; adapterType provenance still prevents echo loops.
   */
  readRecord?(input: ReadInput): Promise<Record<string, unknown> | null>;

  /**
   * Resolve an opaque adapter-internal id to a human-readable label.
   * Powers `prettyForm` in picker results — `event.id.object_id == '<uuid>'`
   * gets rendered as "object is Companies" instead of "object is <uuid>".
   *
   * Optional. When absent, opaque ids surface as their raw value.
   */
  describeOpaqueId?(input: {
    /** The field/path whose value is being described (e.g. `id.object_id`).
     *  Adapters use this to pick the right catalog (objects vs lists vs
     *  attributes). */
    fieldPath: string;
    /** The id value to look up. */
    value: string;
  }): Promise<string | null>;

  // ── 6b. Optional: filter pushdown for snapshot/poll/scope ─────────────
  /**
   * Translate a filter expression into the adapter's native query body, plus
   * a residual expression carrying anything that couldn't be pushed down.
   *
   * Default policy when the residual is non-null: throw at the boundary
   * unless the caller explicitly opts into client-side fallback. Loud
   * failure prevents the "fetch a million records to filter in memory"
   * footgun that comes with quiet fallback.
   *
   * Adapters that publish nothing in `capabilities.pushdown` should not
   * implement this — callers will skip pushdown entirely and ask for an
   * unfiltered fetch.
   */
  translateFilter?(input: {
    /** The filter expression authored by the user / generated by the AI
     *  builder. The framework guarantees only that its node kinds are a
     *  subset of `capabilities.pushdown.expressionKinds`. */
    expression: Expression;
    /** The entity type the filter applies to (e.g. `attio:companies`).
     *  Adapters use this to scope the native query body. */
    entityType: string;
  }): Promise<FilterTranslationResult>;

  // ── 7. Resources ──────────────────────────────────────────────────────
  // READING resources is NOT a bespoke method (P12). Resources are reached
  // through the uniform traversal path: a resource-bearing type declares a
  // reserved `RESOURCES_REFERENCE_FIELD_ID` reference in `describe`, and the
  // adapter resolves it via `getRelated` — each result a position whose
  // `data` carries the `Resource` shape (FILE resources carry a `fileRef`).
  // The engine's `#resources` meta-edge and the `resource_traverse`
  // expression both walk that reference. There is no `getResources` method.
  //
  // WRITING resources is NOT a bespoke method either: resources ride
  // `WriteInput.resources` (node-level provenance, `4d_resources.md`) and the
  // target adapter persists them as part of the record's own create/update.

  /**
   * Resolve a `FileRef` this adapter owns to its live bytes. Called by the
   * `/api/files/{token}` pass-through while the originating action is still
   * in flight (the engine keeps the `(ownerAdapter, ref)` pair registered for
   * the duration of the target's write). The owner uses its OWN credentials to
   * fetch — no caller-supplied target, no creds in the token.
   *
   * Optional — only adapters that EMIT `FileRef`s (carry `source` handles)
   * implement it. `RemoteAdapter` implements it by calling the wire
   * `resolveFileRef` (which returns `{ url }`) and converting url→stream.
   *
   */
  resolveFileRef?(input: { ref: FileRef }): Promise<ResolveFileRefResult>;

  /**
   * Return the type's in-batch dedup rules — the uniqueness constraints
   * the framework uses to collapse co-extracted ephemeral duplicates
   * before C9 apply (W6-D1).
   *
   * Adapters return their existing uniqueness metadata projected into
   * an ephemeral-vs-ephemeral form: an OR-of-AND of property-keyed
   * entries the framework can evaluate against `EphemeralNode.data`
   * pairs. Entries the framework can't resolve in dedup time (e.g.
   * KG `edge_to:` references that require a materialised graph
   * context) are simply omitted — the framework's pair evaluator
   * bails on such entries and falls through to the next constraint.
   *
   * Adapters that don't want dedup (Slack, Email) return `null`; the
   * framework skips the type entirely.
   *
   */
  getDedupRules?(input: { typeRef: string }): Promise<DedupRules | null>;

  /**
   * Parse ordered actor candidates from an inbound event — a pure parse of
   * who-sent-it / who-relayed-it, with NO Listen-Fire DB access (external-system
   * API enrichment IS allowed: Slack `users.info`, Attio
   * `/v2/workspace_members/{id}`, etc., to surface the actor's email).
   *
   * This is the adapter half of the acting-user split (the extensible
   * adapter protocol, 2026-05-29). The adapter no longer reaches into
   * Listen-Fire's user tables — it only describes the candidates; Listen-Fire's
   * `resolveActingUser` (acting_user/resolve.ts) runs the identical
   * resolution chain (creator-override → originator/non-service →
   * relay/service → creator-fallback → null) by mapping these candidates
   * to a team user. Splitting parse from resolution lets the parse cross a
   * remote-adapter boundary that the DB chain never could.
   *
   * Candidate ordering and `source` tags reproduce the prior per-adapter
   * chains exactly:
   *   - Email: sender (`From:` / `sender`) as `originator`; each parsed
   *     forwarding-header recipient as `relay`.
   *   - Slack / Attio: the runtime-resolved actor email as a single
   *     `originator` candidate (empty array when no email resolves).
   *
   * The terminal recipient on the deployment's own inbound address is ROUTING ONLY and is never a
   * candidate — auth comes from who SENT it or which inbox RELAYED it.
   *
   * Optional — adapters with no acting-user concept omit it; the resolver
   * then yields null (no `@user_*`). `extractActor` (`@actor_*`) is
   * independent of this method.
   *
   */
  getActorCandidates?(input: {
    event: import('./triggers/types').TriggerEvent;
  }): Promise<ActorCandidate[]>;

  /**
   * Extract the raw actor identity from an inbound event. A pure parse,
   * no DB lookups — actor identity is "who originated this event
   * in the source system" regardless of whether they map to a Listen-Fire
   * user. Powers `@actor_email` / `@actor_name` / `@actor_id` so authors
   * can attribute events to their raw originator independently of the
   * authenticated team member.
   *
   * Returns `null` when the event has no actor-shaped originator (e.g.
   * a snapshot replay with no per-record provenance). Adapters that
   * don't implement get `@actor_*` = null at dispatch time, gracefully.
   *
   */
  extractActor?(input: {
    event: import('./triggers/types').TriggerEvent;
  }): Promise<ActorIdentity | null>;

  // (§8 correspondence — `getPriorMatch` / `recordLink` — retired with the TG
  // engine. Correspondence is now the engine-owned, symmetric `bind` store
  // (`translation_graph/movement/record_bindings.ts`), declared in the language via
  // `write … bind other`; the adapter is correspondence-agnostic. See
  // plans/2026-06-14-explicit-linking/3b_explicit_link_model.md and
  // plans/2026-06-14-kill-tg.)

  // ── 9. Optional: echo authorship (the 2-way-sync suppression capability) ──
  //
  // NOT a loop detector — the substrate for the opt-in `suppress_self` listen
  // flag (a declarative 2-way-sync semantic, default off). When an author
  // builds an A↔B sync (one movement reads AND writes the same system) they
  // turn `suppress_self` on; at the inbound boundary the framework asks the
  // SOURCE adapter "did WE author this change?" and skips the firing when the
  // answer is yes, so the sync doesn't self-echo.
  //
  // Scoped to AUTHORSHIP OF THIS CHANGE, never the record's identity-forever:
  // a human's later edit of a record we once wrote (human actor, no matching
  // recent write of ours) must answer `false` and fire normally. The adapter
  // answers from what it OWNS — the change's actor (the bot/service identity
  // we write as; a Slack message's `user`, an Attio change's editor, the KG
  // mutation-context source) and/or the write's returned id matched against a
  // short-TTL record of our own recent writes (see engine/recent_writes.ts).
  //
  // Optional + capability-gated: an adapter that can't tell its own writes
  // apart from foreign ones simply omits this (its manifest `methods[]`
  // excludes `didWeAuthor`). The framework then treats `suppress_self` as a
  // clearly-logged no-op — the author asked for something this source can't
  // answer. Implementers return:
  //   - `true`  — WE authored this inbound change (suppress the echo);
  //   - `false` — someone/something else did (fire normally);
  //   - `null`  — can't determine for THIS event (treated as "don't suppress",
  //               same as a non-implementer, so an indeterminate answer never
  //               silently swallows a legitimate change).
  didWeAuthor?(input: {
    event: import('./triggers/types').TriggerEvent;
  }): Promise<boolean | null>;
}

// ── Resource types ────────────────────────────────────────────────────────

/**
 * Reserved reference fieldId for a type's attached resources (the `resources`
 * edge). A resource-bearing source type declares a reference with this fieldId
 * in `describe`; the adapter resolves it via `getRelated` to resource positions
 * (each `position.data` carrying a `Resource`). The engine's `resources` edge
 * and the `resource_traverse` expression walk it.
 *
 * The label is `_resources` (a leading-underscore identifier, no `#` prefix) so
 * it parses everywhere an edge name can appear — the movement language treats
 * `#` as a comment outside traversal-hop brackets, so a `#`-prefixed label was
 * swallowed in any other position. The leading underscore is a valid identifier
 * char that also signals "reserved/meta" and keeps the name clear of
 * extraction-derived edge/node names. `_resources` is a reserved resource-hop
 * keyword in `-[:_resources]->`.
 *
 * This replaces the retired `getResources` method — resources are "just an
 * edge" on the uniform traversal path.
 *
 */
export const RESOURCES_REFERENCE_FIELD_ID = '_resources';

export interface ResourceFilter {
  resourceType?: 'URL' | 'EMAIL' | 'WHATSAPP' | 'FILE' | 'TEXT';
  hasDocument?: boolean;
  mimeType?: string;
  namePattern?: string;
}

/**
 * Unified resource shape carried on a resource position's `data` (resolved via
 * the `RESOURCES_REFERENCE_FIELD_ID` reference through `getRelated`) and
 * consumed by `Adapter.writeResource`. Persisted superset of the older
 * `ResourcePosition`
 * — carries the same opaque handle plus the fields the engine and downstream
 * adapters need to round-trip a resource without re-fetch.
 *
 * Per the 2026-05-21 R3 ruling, this is the single resource currency across
 * KG / Slack / email / Attio adapters. Adapters materialise the fields a
 * `resource` expression can read into `data`; the engine reads them there
 * directly (a local lookup — no bespoke resource-field method).
 */
export interface Resource {
  /** Internal UUID identifier, generated by the system. For persisted
   *  resources this is the `public.resource.id` UUID; for resources that
   *  haven't been written yet (e.g. fresh adapter `#resources` output)
   *  this is `undefined` and the persistence layer (`writeResource`)
   *  generates one via `gen_random_uuid()` after the lookup-by-externalId
   *  miss.
   *
   *  Adapters MUST NOT stuff external identifiers (Slack `ts`, file id,
   *  Attio attachment id, etc.) into this slot. External identifiers
   *  belong in `externalId`. The W3-B2 separation enforces this: `id` is
   *  a branded UUID type that Postgres will reject if any external string
   *  leaks into it. */
  id?: ResourceId;
  /** Original identifier from the source system (Slack `ts`, file id,
   *  email attachment key, Attio attachment id, MIME content-id, etc.).
   *  Adapters populate this on `#resources` resolution; `persistKgResources`
   *  looks up by `(team, adapterType, externalId)` for idempotent re-delivery
   *  — same external handle → same internal UUID across re-fires. The
   *  `(team, adapterType, externalId)` namespace's `adapterType` is taken from
   *  `provenance.adapterType`. */
  externalId?: string;
  /** Resource kind. Mirrors `public."ResourceType"`. */
  type?: 'URL' | 'EMAIL' | 'WHATSAPP' | 'FILE' | 'TEXT';
  /** Display name. */
  name?: string;
  /** Stable URL when one exists (URL/FILE resources; null for inline text).
   *  DISPLAY-ONLY per `3_model.md` — never the byte channel. Bytes for FILE
   *  resources ride on `fileRef`; consumers that need the binary call its
   *  `retrieve()` (`streamFileRef`), not `url`. */
  url?: string | null;
  /** Byte channel for FILE resources: a `FileRef` carrying its own `retrieve()`
   *  (the producing source adapter closed over its credentials). Absent for
   *  TEXT/URL resources whose payload rides `content` / `url`. */
  fileRef?: FileRef;
  /** MIME type when known. */
  contentType?: string | null;
  /** Materialised field bag a `resource` expression reads from (a local
   *  lookup). Adapters populate the fields they expose; KG materialises the
   *  standard set when it resolves the resource. */
  data?: Record<string, unknown>;
  /** Inline content payload — text body for TEXT resources, the raw
   *  string for URL resources, etc. Undefined when the adapter prefers
   *  the lazy-fetch path. */
  content?: string;
  /** Free-form adapter-defined metadata (mirrors `public.resource.metadata`
   *  for the KG impl). */
  metadata?: Record<string, unknown>;
  /** Facts (subject-predicate-object triples) extracted from this resource.
   *  Persisted by the target adapter in the same transaction as the resource
   *  itself (KG: `extraction_fact` rows). Empty / absent when the resource
   *  carries no extracted facts. */
  facts?: Fact[];
  /** Where this resource came from — the external record + the field on it.
   *  Same currency as a prior match (`ExternalRecordRef`) plus the source
   *  `field`, so "this came from the `body` of this email" /
   *  "the `description` of this Attio record" is recorded structurally.
   *  `provenance.adapterType` also namespaces the `externalId` for idempotent
   *  persistence. */
  provenance?: ResourceProvenance;
}

/**
 * Where a `Resource` originated: the external record it was read from, in the
 * same flat currency as a correspondence (`ExternalRecordRef`), plus the name
 * of the source field. Lets the persistence layer record provenance at the
 * grain of "the <field> of <record>" without a bespoke shape.
 *
 */
export interface ResourceProvenance extends ExternalRecordRef {
  /** The source field the resource's content was read from (e.g. `body`,
   *  `description`, `notes`). Absent when the resource is the whole record
   *  rather than one of its fields. */
  field?: string;
}

/**
 * @deprecated Use `Resource`. Retained as a structural alias for
 * source-compatibility while the wave-1 R4a/b/c adapter impls migrate.
 */
export type ResourcePosition = Resource;

/**
 * A subject-predicate-object triple extracted from a resource. Carried on
 * `Resource.facts` so the adapter persists facts in the same write as the
 * resource itself (`4d_resources.md`).
 */
export interface Fact {
  /** Subject phrase. */
  s: string;
  /** Predicate phrase. */
  p: string;
  /** Object phrase. */
  o: string;
  /** Optional temporal modifier (e.g. "2024-05"). */
  t?: string;
}

/**
 * Per-field provenance for a written value (3b §3.3). Carried inline on
 * `WriteInput.evidence`, keyed by the adapter's target field name, so the
 * record and its provenance persist as one transactional unit — no
 * post-structural `writeEvidence` call, no ephemeral-ref → node-id dance.
 *
 * The engine attaches a `FieldEvidence` to a field only when the value is
 * *provenance-faithful* — it arrived un-transformed from an extraction /
 * property read (3b §3.4). A value dropped through `AI()` or a function is no
 * longer evidence-bearing, so no evidence is attached (a misleading citation
 * is worse than none).
 *
 */
export interface FieldEvidence {
  /** Verbatim text that justified the value. */
  quote?: string;
  /** Character offsets into the source resource content, when known. */
  startOffset?: number;
  endOffset?: number;
  /** Evidence kind — defaults to `extraction` when omitted. */
  type?: 'extraction' | 'user_edit' | 'retrieval';
  /** The resource the quote came from, when the adapter can anchor to it. */
  sourceResourceRef?: { externalId?: string; fileRef?: FileRef };
}

/**
 * In-batch dedup rules surfaced by an adapter for one target type.
 * Consumed by the framework's W6-D1 dedup phase: per ephemeral pair,
 * walk OR-of-AND constraints; one matching constraint = pair merges
 * (or routes to the LLM judge when the matching constraint contained
 * any fuzzy entry).
 *
 * Adapters that don't model dedup return `null` from `getDedupRules`.
 * Adapters whose existing uniqueness shape is constraint-of-property
 * (KG) just project their stored rules into this form by name; adapters
 * with richer (cross-record / cross-edge) constraints omit the parts
 * that can't be evaluated in ephemeral-vs-ephemeral form.
 *
 */
export interface DedupRules {
  /** OR-list of constraints; any one matching means the pair merges. */
  constraints: DedupConstraint[];
}

export interface DedupConstraint {
  /** AND-list of entries; every entry must fire for the constraint to
   *  match. Empty entries lists never fire. */
  entries: DedupConstraintEntry[];
}

export interface DedupConstraintEntry {
  /** Adapter-neutral property identifier the framework maps to an
   *  ephemeral data field name via the bundle's synthetic schema
   *  (every `FieldShape.propertyTypeId` is stamped during W3-F4
   *  pre-collection). Entries whose id has no matching FieldShape on
   *  the ephemeral's site are silently skipped — the constraint then
   *  bails for the pair. */
  propertyTypeId: string;
  /** When true, values within similarity threshold count as a match
   *  and the matching constraint is flagged as fuzzy — pairs whose
   *  only matching constraint is fuzzy route to the LLM judge rather
   *  than auto-merge. */
  fuzzy: boolean;
}

// ── Input/output types ────────────────────────────────────────────────────

export interface ResolveEntityInput {
  /**
   * The fields the engine intends to write, keyed by the adapter's
   * `targetField` (e.g. KG property type id, Attio attribute slug).
   * Adapters interpret these values against their own identity model:
   *   - KG-as-target: feeds the node type's `uniqueness_constraints`
   *     (see `services/knowledge_pipeline/uniqueness_constraints.ts`).
   *   - External-as-target: native rules — e.g. Attio's per-attribute
   *     `is_unique` flag (deferred today).
   *
   * Identity is the *target system's* concern; the framework no longer
   * tags individual mappings as identity-critical. Adapters that can't
   * search by identity return no candidates and the engine falls through
   * to create.
   */
  record: Record<string, unknown>;
  /** A typeId in this adapter's SchemaDescriptor. */
  recordType: string;
  /** Prior linked_objects matching adapterType + recordType. */
  candidates: LinkedObject[];
  /**
   * Effective uniqueness constraints — the opaque union of the adapter's
   * native constraints (from `describe(recordType).uniquenessConstraints`)
   * and any author-defined constraints on the TG action node. An OR-of-AND
   * of the adapter's own field names (3b §3.2); the adapter compiles it to
   * its native search. The engine pre-combines the two sets and also uses
   * them to arbitrate exactness over the returned candidates — the adapter
   * just compiles + searches.
   */
  constraints: UniquenessConstraints;
}

/**
 * The single external-record currency. One flat shape returned by
 * `resolveEntity` candidates and `createRecord`/`updateRecord`.
 *
 * `adapterType` names the system the `externalId` lives in — so a link
 * store knows whose id it's recording, and a candidate/write result
 * carries its own provenance. `data` is the record's flat field bag: the
 * LLM judge compares candidates over it, the engine snapshots it onto
 * `linked_object.data` for the UI prettifier, and any relationship
 * disambiguation context folds into it as ordinary entries (e.g.
 * `data['participates in'] = 'Series A'`). `displayName` is *derived*
 * from `data` via the type's `labelTemplate` — never a separate field.
 *
 * Replaces the KG-shaped `ResolveEntityCandidate` (`matchedNodeId` /
 * `relationships` / `allEntriesExact`): the engine arbitrates from the
 * flat candidate set plus the constraint payload it already holds, and
 * bridges off `externalId` (which == the KG node id for a KG target).
 *
 */
export interface ExternalRecordRef {
  /** The system this `externalId` lives in (e.g. `attio`, the KG). */
  adapterType: string;
  /** Target-system id — the value the engine passes to `updateRecord`,
   *  and the KG node id when the target is the KG. */
  externalId: string;
  /** The record's type in its own system (e.g. `attio:companies`). The KG
   *  persists it on `linked_object.external_object_type` (which
   *  `resolveByBridge` filters on). Optional; omitted when unknown. */
  recordType?: string;
  /** Canonical link to the record in its own system, when one exists. */
  url?: string;
  /** Flat field bag — judge comparison, UI snapshot, folded-in
   *  relationship context. `{}` when the adapter has nothing to surface. */
  data: Record<string, unknown>;
}

export interface ResolveEntityResult {
  /**
   * Ordered candidate shortlist from the target system. Empty when no
   * existing record matches. Flat `ExternalRecordRef`s — same shape as
   * write results.
   *
   * Engine semantics:
   *   0 candidates → create new record
   *   1 candidate → match it (single result is unambiguous by definition)
   *   N candidates → the engine arbitrates (exactness over the held
   *     constraints, then the LLM judge over each candidate's `data`)
   */
  candidates: ExternalRecordRef[];
}

export interface GetFieldValueInput {
  position: SourcePosition;
  fieldId: string;
}

export interface GetRelatedInput {
  position: SourcePosition;
  fieldId: string;
  /**
   * Direction of traversal. 'outgoing' is universal — every adapter must
   * support it. 'incoming' is gated by `capabilities.incomingEdges`; the
   * engine checks the capability before passing 'incoming' through.
   */
  direction: 'outgoing' | 'incoming';
  /**
   * Native filter pushed down by the engine — the output of the source
   * adapter's `translateFilter` for the step's `expressionFilter`.
   * Adapter-opaque (each adapter knows its own shape). Adapters that
   * don't support pushdown can ignore this; the engine still
   * post-filters in that case. Always `undefined` when no
   * `expressionFilter` is set on the step or when the adapter doesn't
   * publish `translateFilter`.
   */
  nativeFilter?: unknown;
  /**
   * The hop's WHERE predicate, pushed for the adapter to NARROW THE FETCH
   * (adapter-capability-contract chunk 7) — so an unbounded collection hits the
   * provider's filtered query API instead of paging every record. Only ever a
   * PURE predicate (the checker gates impure WHEREs to bounded edges; the engine
   * pushes only pure ones). An adapter that can't translate it may ignore it and
   * over-fetch — the engine still satisfies the predicate via the shared filter
   * unit over what comes back, so results are correct either way. The win is
   * purely fetching less.
   */
  where?: Expression;
  /** The hop's ORDER BY, pushed so the adapter can sort at the source.
   *  `fieldId` is the surface property name; the adapter resolves it. An
   *  adapter whose API cannot sort that way ignores it and the engine sorts
   *  what comes back. */
  orderBy?: { fieldId: string; direction: 'asc' | 'desc' };
  /**
   * The hop's LIMIT, pushed so the adapter can bound the fetch.
   *
   * THE CONTRACT: honour `limit` only when you also honoured `orderBy`, or
   * when no `orderBy` was given. A limit taken WITHOUT the sort it came with
   * returns an arbitrary n of the matching set, and the engine's sort over
   * those n then answers a different question than the author asked — "the
   * newest two" becomes "the two we happened to page first, newest first".
   * Over-fetching is always safe (the engine sorts and slices); truncating
   * without the sort is not.
   * plans/ordering-primitives-2026-09-04/1_decisions.md D1
   */
  limit?: number;
}

/**
 * One hop of the meta-graph walk (`Adapter.edgesFrom`) — the node you landed
 * on, and the paths on from it.
 *
 * The node itself is a plain `SchemaTypeDescriptor`, byte-for-byte what
 * `describe` returns: fields and edges (`references`). That is deliberate —
 * it keeps ONE shape for "what is this type", so a caller that falls back to
 * `describe` handles the same descriptor, and the eventual collapse of
 * `describe` into `edgesFrom` adds paths and paging rather than a second
 * vocabulary for the same facts.
 */
/**
 * What an edge says about WHERE IT LANDS: the target node whole — its fields,
 * what is writable, what is required — minus the target's own onward edges.
 *
 * The omission is the contract, not an oversight. It buys the asymmetry the
 * walk runs on: an agent can decide **"write here"** with no further call,
 * because it already holds the landing's fields; deciding **"walk further"**
 * costs exactly one hop. Writing is answered locally, exploring is paid for a
 * hop at a time — which is what lets an agent author in one shot without a
 * speculative describe per candidate edge.
 *
 * `Omit<…, 'references'>` rather than a descriptor with an empty array: "this
 * node has no edges" and "we deliberately did not tell you its edges" are
 * different statements, and only one of them is true here.
 *
 * DELIBERATELY ITS OWN TYPE so the lookahead can shrink. Hydrating every
 * target of every edge is the expensive read in this design and may not
 * survive a large workspace; narrowing this alias to a stub (name and type
 * only) must not change the walk, the call, or any caller's control flow.
 * That is why callers read `targetNodes[edge].<x>` and never reach for the
 * same fact somewhere else.
 *
 */
export type EdgeTargetNode = DescribedTargetNode | StubTargetNode;

/** The target, described: its fields, what is writable, what is required —
 *  everything but its own onward edges. An agent holding this can author a
 *  write with no further call. */
export type DescribedTargetNode = Omit<SchemaTypeDescriptor, 'references'> & {
  /** Present and false-y so a reader never has to infer which kind it holds. */
  stub?: false;
};

/**
 * The target, NAMED but not described — "there is a node here; hop to see its
 * fields".
 *
 * Whether to stub is the ADAPTER's call, edge by edge, because the adapter is
 * the only thing that knows what a describe costs it. Attio pays an attribute
 * fetch per object, so hydrating its root means fetching the whole workspace to
 * answer "what is in this connection"; email's describes are local, so it
 * hydrates freely. Neither is more correct.
 *
 * `stub: true` is EXPLICIT and never inferred from an empty field list,
 * because "hop to see the fields" and "this node has no fields" are different
 * facts. A stub that read as the latter would be silence dressed as an answer —
 * the exact failure this model exists to remove.
 *
 */
export interface StubTargetNode {
  stub: true;
  typeId: string;
  displayName: string;
  description?: string;
}

/**
 * A described type as an edge's landing — everything it says about itself,
 * minus its onward edges. ONE implementation so "what does an edge tell you
 * about its target" has a single answer across every adapter, and so scaling
 * the lookahead back to a stub is an edit here rather than in sixteen places.
 */
export function targetNodeOf(descriptor: SchemaTypeDescriptor): DescribedTargetNode {
  const { references: _onward, ...node } = descriptor;
  return node;
}

/** The target as a NAME only — for an edge the adapter judges too expensive to
 *  describe up front. Costs nothing to produce, and says so. */
export function stubTargetOf(input: {
  typeId: string;
  displayName?: string;
  description?: string;
}): StubTargetNode {
  return {
    stub: true,
    typeId: input.typeId,
    displayName: input.displayName ?? input.typeId,
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
}

export interface EdgesFromResult {
  /** The node at `position` — its fields and the edges leaving it. */
  descriptor: SchemaTypeDescriptor;
  /**
   * What each edge LANDS ON, keyed by the edge's `fieldId` — the same keying
   * as `targetPositions`, which says how to get there while this says what is
   * there.
   *
   * Absent/partial is legitimate: an edge with no entry is one whose target
   * the caller must describe by walking to it. That tolerance is what lets the
   * hydration be scaled back later without a contract break.
   */
  targetNodes?: Record<string, EdgeTargetNode>;
  /**
   * Path to each edge's TARGET type node, keyed by the edge's `fieldId` (the
   * `references` entry it belongs to). The caller echoes one back as
   * `edgesFrom`'s position to follow that edge.
   *
   * A POLYMORPHIC edge is ONE reference with MANY members, so its members
   * ride here under their own keys with no reference row each: the member's
   * `recordType` says which polymorphic edge it belongs to, and the label the
   * adapter minted onto its data (`{ Name }`, `{ Title }` — `positionLabel`)
   * is the name that addresses it. Narrowing evaluates its predicate over
   * exactly these members (4_polymorphic_edges.md).
   *
   * A side map rather than a field on the reference descriptor: a position is
   * the walk's currency, not part of a type's published shape, and `describe`
   * has no paths to state. Absent/partial is fine — an edge with no path is
   * simply one the caller must reach by name.
   */
  targetPositions?: Record<string, SourcePosition>;
  /**
   * Opaque continuation for a wide hop. Pagination is in the contract from the
   * start as the general bound on fan-out: "each instance is a type-edge" is
   * only safe if a hop with very many instances can be walked incrementally
   * instead of returned whole. Absent ⇒ this page is the whole hop.
   */
  nextCursor?: unknown;
}

export interface RelatedResult {
  /** The resolved related position (the node on the other end of the edge). */
  position: SourcePosition;
  /**
   * Edge identifier when the source has first-class edges. Populated by KG
   * sources; left undefined by adapters where references are plain record
   * fields with no separate edge identity.
   */
  edgeId?: string;
  /**
   * The walked edge's properties, inline (3b §2). The engine captures these
   * during traversal so an `edge_property` expression reads them directly —
   * generalising edge-property filtering to any adapter (gated by
   * `capabilities.traversal.edgeProperties`) and retiring the bespoke
   * `getEdgeFieldValue`. Keyed by the adapter's field id (KG: property type
   * id). Omitted by adapters without edge properties.
   */
  edgeProperties?: Record<string, unknown>;
}

// ── Capability declarations ───────────────────────────────────────────────
/**
 * The small, honest whole-adapter capability set — facts that hold for the
 * adapter as a whole (not per-edge / per-field). These are read by the engine
 * at evaluation time: a `traverse direction=incoming` step, an `edge_property`
 * read, or a `resource` / `resource_traverse` step against an adapter that
 * doesn't support them raises `UnsupportedSourceCapabilityError`.
 *
 * Answered statically by `Adapter.runtimeCapabilities()` — no credential
 * needed, so it can be a plain method returning a constant. Per-edge filter /
 * order / limit live on the `describe()` output, NOT here (principle 1 —
 * capability at grain).
 *
 */
export interface RuntimeCapabilities {
  /** Traversal direction + edge-property support. `outgoing` is universal
   *  (every adapter must implement it) and therefore implicit. `incoming`
   *  lets `traverse`/`exists` walk inverse edges (KG yes; most external
   *  systems no). `edgeProperties` lets `edge_property` expressions read
   *  fields off walked edges. */
  traversal: { incoming: boolean; edgeProperties: boolean };

  /** Resources (files, URLs, content) attached to source positions, plus
   *  `resource_traverse` step support. Typically only the KG adapter. */
  resources: boolean;
}

/**
 * The base/default whole-adapter capability set — what a plain external
 * adapter supports: outgoing-only traversal, no edge properties, no
 * resources. The KG overrides to enable all three.
 */
export const BASE_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  traversal: { incoming: false, edgeProperties: false },
  resources: false,
};

/**
 * Result of `Adapter.translateFilter` — a partial-pushdown contract. The
 * `native` value goes to the adapter's query API; the `residual` (if any)
 * carries the part of the filter that couldn't be pushed down.
 *
 * Default policy: `residual !== null` is a loud failure unless the caller
 * opts into client-side fallback (which has to be explicit because it can
 * mean "fetch everything and filter in memory").
 */
export interface FilterTranslationResult {
  /** Adapter-opaque native query/filter body. */
  native: unknown;
  /** The portion of the filter the adapter couldn't push down. */
  residual: Expression | null;
}

/**
 * Input to `Adapter.invokeFieldFunction` — a fully-evaluated field-function
 * call. `instructions` is `args[0]` coerced to a string (the brief); `data`
 * is `args[1..]` as bare values in author order, passed through verbatim. No
 * ontology, no roster, no channel.
 *
 */
export interface InvokeFieldFunctionInput {
  recordType: string;
  fieldId: string;
  functionName: string;
  args: {
    instructions: string;
    data: unknown[];
  };
}

/** One parent → child connection a write carries (`WriteInput.parentLinks`). */
export interface ParentLink {
  /** The parent's type. Adapters need this to scope edge / reference
   *  resolution to the parent's type. */
  recordType: string;
  /** External id of the parent record (returned by the parent's
   *  createRecord call). */
  externalId: string;
  /** The user-facing name of the edge that connects parent → child.
   *  Adapter resolves this to a concrete edge / reference per its
   *  schema. Outbound and inbound KG names are first-class equals;
   *  adapter references match by `fieldId`. */
  edgeName: string;
  /** The parent's payload, in the PARENT adapter's own shape: a handle
   *  parent contributes its WriteResult `data` (e.g. Slack's
   *  `{ channelId, ts }`), a traversed/event parent its position `data`
   *  (e.g. the inbound Slack event's `{ channel, ts, … }`). Adapters read
   *  only their OWN parents' data — no cross-adapter shape assumptions.
   *  Absent when the parent carried none. */
  data?: Record<string, unknown>;
}

/** The parent-link set of a write — a list of 0/1/N parents. A linked
 *  write is just the 1-element case of the general N-parent write, so the
 *  engine always provides `parentLinks` and this is a stable accessor. */
export function writeParentLinks(input: Pick<WriteInput, 'parentLinks'>): ParentLink[] {
  return input.parentLinks ?? [];
}

/** The lone parent of a write, for adapters whose record types attach to
 *  exactly one parent (a note/file/folder/list-entry belongs to a single
 *  owner). Collapses the general N-parent list to that one case: returns
 *  `undefined` for a root write (empty list) and throws if the program
 *  somehow handed a single-parent type more than one parent — a misconfig
 *  the adapter can't honour. */
export function singleParentLink(input: Pick<WriteInput, 'parentLinks'>): ParentLink | undefined {
  const links = writeParentLinks(input);
  if (links.length > 1) {
    throw new Error(
      `expected at most one parent link, got ${links.length}: this record type attaches to a single parent`,
    );
  }
  return links[0];
}

export interface WriteInput {
  recordType: string;
  fields: Record<string, unknown>;
  /**
   * Per-field provenance, keyed by the adapter's target field name (the same
   * keys as `fields`). The record and its evidence persist as one
   * transactional unit (3b §3.3) — no post-structural `writeEvidence`. The
   * engine only includes a field here when its value is provenance-faithful
   * (un-transformed from an extraction / property read, 3b §3.4); adapters
   * without an evidence sink ignore it.
   */
  evidence?: Record<string, FieldEvidence>;
  /**
   * Source material this record drew from — node-level provenance (3b §3.3 /
   * `4d_resources.md`). Every resource that contributed to *any* of this
   * record's fields, each carrying its stable engine-stamped `id`, its
   * `facts`, and its `provenance`. The adapter persists / dedupes on `id`
   * (KG: resource row + `node_resource` link + `extraction_fact`); adapters
   * without a resource sink ignore it. Replaces the standalone `writeResource`
   * call — resources persist as part of the record's own write.
   */
  resources?: Resource[];
  /**
   * Mutation context applied to the write at the adapter boundary. The KG
   * adapter uses this to populate evidence.mutation_context; external
   * adapters use it for linked_object creation and adapterType tagging.
   */
  mutationContext: MutationContext;
  /**
   * Parent context when this write is the child of another action.
   * Adapters use this to wire the parent → child relationship in the
   * target system:
   *
   *   - KG adapter: resolves `edgeName` against the ontology (outbound
   *     name match → outgoing edge from parent; inbound name match →
   *     incoming edge to parent) and inserts the corresponding edge
   *     between parent and new child.
   *   - External adapters: resolve `edgeName` against the parent
   *     type's references in their schema descriptor and set the
   *     matching reference field (or per-entity parent fields like
   *     Attio's `parent_record_id`) on the create payload.
   *
   * A list of 0/1/N parents — a linked write is just the 1-element case
   * of the general N-parent write (the movement language's tuple-path
   * form: `write (company-[:investments]->, investor-[:investments]->)
   * { … }`). ONE create carries every parent link: the KG inserts each
   * connecting edge inside the record's own transaction; external
   * adapters set each matching reference on the create payload (or link
   * the parent side afterwards). Adapters read it via `writeParentLinks`
   * (or `singleParentLink` for single-parent record types).
   *
   * Empty for root actions and for child actions whose authored
   * relationship predates the edge-aware picker (no `edgeName`
   * recorded); adapters then create the record with no parent linking.
   */
  parentLinks?: ParentLink[];
  /**
   * Provenance from an external trigger. Set by the engine when a
   * webhook / snapshot / poll event fires a TG and the target side is
   * the KG (or an adapter that wants to record the bridge). Adapters
   * use this to insert a `linked_object` row alongside the new record so
   * future events from the same external record resolve back to this
   * write rather than creating a duplicate.
   *
   * Undefined when the trigger source is the KG itself (mutation
   * trigger) or when the engine has no record id (e.g. the trigger fires
   * but doesn't reference a single source record).
   */
  bridgeToExternal?: {
    /** Source adapter that produced the trigger event (e.g. 'attio'). */
    adapterType: string;
    /** The source's record id. */
    recordId: string;
    /** Source-side object type label, for `linked_object.external_object_type`. */
    recordType?: string;
  };
}

export interface UpdateInput extends WriteInput {
  externalId: string;
}

export interface DeleteInput {
  recordType: string;
  externalId: string;
  mutationContext: MutationContext;
}

/** One end of a `linkRecords` assert — an existing record, by the same
 *  (recordType, externalId) coordinates every write method speaks. */
export interface LinkRecordEndpoint {
  /** A typeId in this adapter's schema (KG: a NodeTypeId). */
  recordType: string;
  /** The record's id in this adapter's system (KG: the node id). */
  externalId: string;
}

/** Input to `Adapter.linkRecords` — assert `from -[edgeName]-> to`. */
export interface LinkRecordsInput {
  from: LinkRecordEndpoint;
  /**
   * The edge connecting from → to, resolved against the FROM side's
   * schema, in the adapter's own currency: the KG resolves it like
   * `ParentLink.edgeName` (outbound/inbound ontology names); external
   * adapters match it against the from type's reference fieldIds.
   */
  edgeName: string;
  to: LinkRecordEndpoint;
  /** Provenance context — evidence-free (an edge assert writes no field
   *  values), but the KG threads it onto the mutation events it emits. */
  mutationContext: MutationContext;
}

export interface LinkRecordsResult {
  /** True when the link was newly asserted; false when it already existed
   *  (the call is idempotent). */
  created: boolean;
}

/** Input to `Adapter.unlinkRecords` — sever `from -[edgeName]-> to`. Same
 *  currency as the link assert it inverts. */
export type UnlinkRecordsInput = LinkRecordsInput;

export interface UnlinkRecordsResult {
  /** True when a link existed and was severed; false when none was present
   *  (the call is idempotent). */
  removed: boolean;
}

/**
 * A write's return — the written record as the flat `ExternalRecordRef`
 * currency (the write return *is* the display data; `getDisplayData` is
 * gone). The engine snapshots `data` onto `linked_object.data` for the UI
 * prettifier when it bridges KG → external.
 */
export type WriteResult = ExternalRecordRef;

/**
 * The id-based-write NOT-FOUND signal — the one adapter-side requirement of
 * the engine-owned binding model (3b_explicit_link_model.md). An
 * `updateRecord` (a write BY id) targets a record the caller believes exists;
 * when the underlying record is gone (deleted externally), the adapter MUST
 * report it through this typed signal rather than throwing an opaque error, so
 * the engine's bind self-heal can deterministically distinguish "wrote fine"
 * from "target is gone → drop the stale binding and re-mint."
 *
 * This carries NO correspondence concept — it is purely "the record you named
 * by id does not exist." Every adapter implementing `updateRecord` translates
 * its system's not-found (Attio/Valuations 404, a missing KG node, a missing
 * Airtable/Sheets row, …) into this signal. Adapters whose `updateRecord`
 * unconditionally throws (Slack: posts aren't updatable) never need it.
 *
 */
export interface UpdateNotFound {
  notFound: true;
}

/**
 * What became of the parent association an update named. Every `updateRecord`
 * states one, because "the engine sent a parent-only update" and "the record
 * is attached to its parent" are different facts, and only the adapter knows
 * which one happened. A matched record whose fields were all unchanged reports
 * itself as an `attach` on the strength of this value, so a guess here would
 * be a run that claims a relationship nobody made.
 *
 *   - `made`        — the association was absent and now exists.
 *   - `already`     — it was already there; nothing needed sending.
 *   - `unsupported` — this system cannot attach an EXISTING record along the
 *     edge the write named. The engine FAILS the write: the author asked for
 *     a relationship the system has no way to make, and a quiet success would
 *     be the very lie this value exists to prevent.
 *   - `none`        — the write named no parent, so nothing was asked.
 */
export type ParentAssociation = 'made' | 'already' | 'unsupported' | 'none';

/** The association an adapter reports when it has no way to attach a MATCHED
 *  record to a parent at all: nothing was asked of it (`none`), or something
 *  was and it cannot deliver (`unsupported`). */
export function unsupportedAssociation(
  input: Pick<WriteInput, 'parentLinks'>,
): ParentAssociation {
  return writeParentLinks(input).length === 0 ? 'none' : 'unsupported';
}

/** The association an adapter reports when its parents are CONTAINERS the
 *  child cannot leave — a row in a tab, an entry that IS its (list, member)
 *  pair. Having matched the record through the container is already the whole
 *  of the relationship, so there is nothing left to make. */
export function containerAssociation(
  input: Pick<WriteInput, 'parentLinks'>,
): ParentAssociation {
  return writeParentLinks(input).length === 0 ? 'none' : 'already';
}

/**
 * The success arm of an id-based write: the written record in the flat
 * `ExternalRecordRef` currency, plus what became of the parent association the
 * write named. `association` is REQUIRED — an adapter that stays silent about
 * a parent it was handed is exactly the silent degradation this field removes,
 * and a new adapter is caught by the compiler rather than by a missing edge in
 * production.
 */
export interface UpdateWriteResult extends ExternalRecordRef {
  association: ParentAssociation;
}

/**
 * An id-based write returns the written record (`UpdateWriteResult` —
 * `externalId` echoes the input id) OR the typed not-found signal. Discriminate
 * with `'notFound' in result` (or the `updateRecordSucceeded` helper).
 */
export type UpdateResult = UpdateWriteResult | UpdateNotFound;

/** Narrow an `UpdateResult` to the success arm — `false` when the target was
 *  reported not-found. The single discrimination point engine + callers use. */
export function updateRecordSucceeded(result: UpdateResult): result is UpdateWriteResult {
  return !('notFound' in result);
}

/** A delete's return carries no payload — the absence of a throw IS the
 *  result. Kept as a named type so the `Adapter` signature stays readable. */
export type DeleteResult = Record<string, never>;

export interface ReadInput {
  recordType: string;
  externalId: string;
  /** When set, request only these fields (adapter may ignore and return all). */
  fieldIds?: string[];
}

/**
 * A typed event from an UNSOLICITED inbound signal (`Adapter.preprocessInbound`)
 * or a SOLICITED poll (`PollSource.getEvents`). The engine discriminates it
 * against the adapter's `listEventTypes()` union into a typed root
 * `SourcePosition` and runs the trigger. See `4b_inbound_pseudocode.md`.
 */
export interface DiscriminableEvent {
  /** The event body — what an `EventType.match` is evaluated against, and what
   *  becomes the seeded position's `data`. */
  payload: unknown;
  /** Re-identifying external key for the record this event concerns; the
   *  engine uses it for the KG bridge / correspondence lookup. */
  externalId?: string;
  /** The source's own per-DELIVERY id (Slack envelope `event_id`, …), stable
   *  across at-least-once redeliveries — the receipt store dedupes on it so a
   *  retry is a no-op, not a duplicate run. Distinct from `externalId` (the
   *  record id, which repeats across legitimate distinct deliveries). Absent
   *  ⇒ not deduped. */
  idempotencyKey?: string;
  /** Set when the adapter already classified the event (e.g. `preprocessInbound`
   *  fetched a thin payload to type it): the matching `EventType.tag`. When
   *  absent, the engine discriminates via each type's `match`. */
  tag?: string;
  actor?: Actor;
  occurredAt?: string;
  changeType?: 'create' | 'update' | 'delete';
  /** The source's own event-type string (e.g. Attio `record.created`), when it
   *  has one. The inbound dispatcher narrows a webhook delivery to the triggers
   *  whose `listen { events: [...] }` selection includes it — so authors (and
   *  Airtable's registration) only pay for the change types they chose. Poll
   *  events leave it unset. */
  eventType?: string;
  /** External-side record type the source names directly (e.g. Attio's object
   *  id). Carried onto the `TriggerEvent.externalRecordRef.recordType` for the
   *  KG bridge. When absent, the dispatch layer falls back to the discriminated
   *  `rootRecordType`. */
  recordType?: string;
  /** Adapter-specific ids of the fields that changed, when the source surfaces
   *  field-level change info (e.g. Attio attribute UUIDs). Threaded onto the
   *  `TriggerEvent` for edge pruning; absent ⇒ "possibly affected" for every
   *  edge. */
  changedFields?: string[];
}

/**
 * A member of an adapter's declared event-type union (`listEventTypes`). The
 * engine matches a `DiscriminableEvent` against these — by `tag` when the event
 * carries one, else by evaluating `match` over its payload — to assign the
 * concrete position type up front (no `webhook_event` meta-type + per-target-edge
 * hop). Instance-aware: for Attio the union is the connection's object types.
 */
export interface EventType {
  /** Stable discriminator, e.g. `company.updated`. */
  tag: string;
  /** Concrete typeId the event yields, e.g. `attio:companies`. */
  positionType: string;
  /** Declarative recogniser the engine evaluates over `DiscriminableEvent.payload`.
   *  OPTIONAL: an adapter whose normalized payload carries no literal
   *  discriminator (Telegram, WhatsApp — they classify at parse time)
   *  omits it and sets `DiscriminableEvent.tag` instead; a match-less type
   *  is selectable ONLY by tag, never by payload probing. */
  match?: { path: string; equals: string | readonly string[] };
}

/**
 * Input to an adapter's internal collection-paging generator (Attio,
 * Valuations). Not an engine-facing method — the engine reaches a
 * collection through the meta-position `getRelated`/`iterateRelated`
 * fan-out, and those adapters call their own pager from there.
 */
export interface SnapshotInput {
  pipelineInputId: string;
  recordType: string;
  /** Pagination state, opaque to framework. Adapter controls shape. */
  cursor?: unknown;
  /** Adapter-specific filter (e.g., subset by status, owner, etc.). */
  filter?: unknown;
}
