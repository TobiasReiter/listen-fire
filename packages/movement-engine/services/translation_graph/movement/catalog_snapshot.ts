// The catalog snapshot, built from what a shell already holds: each adapter's
// manifest (and whatever instance schemas it introspected), the credentials,
// the plugins, the movement files and the models. Pure — no database, no
// registry, no network — so the hosted product (which gathers these from its
// tables and live introspection) and `lf` (which gathers them from a project
// folder and its externals) hand the checker and the engine the same catalog.
//
// It lives here rather than in movement-lang because its input is the
// ADAPTER's vocabulary (`AdapterManifest`, `ConfigBlock`), which is the
// engine's contract with adapters; the language only knows its own
// `AdapterSpec`, the projection's output.

import {
  CATALOG_SNAPSHOT_VERSION,
  type AdapterSnapshot,
  type AdapterSpec,
  type CatalogSnapshot,
  type ConstructionArg,
  type CredentialSpec,
  type InstanceSchema,
  type PluginSpec,
} from 'movement-lang';

import type { AdapterManifest, ConfigBlock } from '../adapter';

/** The manifest facts a catalog reads. A remote adapter's manifest answer
 *  carries a subset of these; a built-in's carries them all. */
export type CatalogManifest = Pick<
  AdapterManifest,
  | 'adapterType'
  | 'requiredCredentialType'
  | 'positionArgs'
  | 'supportedTriggers'
  | 'triggerConfig'
  | 'subscribableEvents'
  | 'defaultSubscribedEvents'
  | 'listenConfig'
  | 'construction'
  | 'triggerExpectation'
  | 'introspectedSchema'
>;

/**
 * The `listen to <instance> { … }` config vocabulary per adapter — the
 * checker flags unknown keys (MOV_LISTEN_BAD_CONFIG) only where this is
 * declared, and validates VALUES where a key carries a closed set:
 *
 *   - adapters declaring an inbound routing-key config field accept that
 *     field's key (email's plus-suffix `key`, matched by
 *     `findTriggerByInboundKey`);
 *   - adapters declaring `subscribableEvents` accept an `events` key whose
 *     values are exactly those event names (`listen to crm { events:
 *     ["record.created"] } fire …`) — the same vocabulary
 *     `ensureEventSubscription` provisions externally, and the same one
 *     `eventMatchesTriggerScope` routes on;
 *   - adapter-declared `listenConfig` keys (the cron adapter's required,
 *     cron-format `schedule`) project as keys + required set + value
 *     formats.
 */
export function triggerConfigVocabulary(
  manifest: Pick<
    CatalogManifest,
    'supportedTriggers' | 'triggerConfig' | 'subscribableEvents' | 'defaultSubscribedEvents' | 'listenConfig'
  >,
): Pick<
  AdapterSpec,
  | 'canFire'
  | 'triggerConfig'
  | 'triggerConfigOptions'
  | 'triggerConfigRequired'
  | 'triggerConfigRequiredWhy'
  | 'triggerConfigFormats'
  | 'defaultEvents'
> {
  const keys: string[] = [];
  const options: Record<string, string[]> = {};
  const required: string[] = [];
  const why: Record<string, string> = {};
  const formats: NonNullable<AdapterSpec['triggerConfigFormats']> = {};
  // An adapter's inbound routing-key block (email's `key`) becomes a listen
  // config key — routed generically off the block declaration, not a named
  // forwarding-address flag. Presentation/action blocks carry no key.
  //
  // It is also REQUIRED: a routing key is how an inbound event finds its
  // listener (`findTriggerByInboundKey` matches on it and nothing else), so a
  // listen without one provisions a listener no event can ever be addressed
  // to. That saved clean, with no address, and stayed silent forever.
  for (const block of manifest.triggerConfig ?? []) {
    if (
      (block.kind === 'text' || block.kind === 'slug') &&
      block.routingKey === true &&
      !keys.includes(block.key)
    ) {
      keys.push(block.key);
      required.push(block.key);
      why[block.key] =
        block.prefix !== undefined || block.suffix !== undefined
          ? `the ${block.key} is this listener's address, ${block.prefix ?? ''}<${block.key}>${block.suffix ?? ''}; without one nothing can be sent to it and it never fires`
          : `inbound events find this listener by its ${block.key}; without one nothing can reach it and it never fires`;
    }
  }
  if (manifest.subscribableEvents !== undefined && manifest.subscribableEvents.length > 0) {
    keys.push('events');
    options.events = [...manifest.subscribableEvents];
  }
  for (const entry of manifest.listenConfig ?? []) {
    if (!keys.includes(entry.key)) keys.push(entry.key);
    if (entry.required && !required.includes(entry.key)) required.push(entry.key);
    if (entry.format !== undefined) formats[entry.key] = entry.format;
  }
  return {
    // A construction-free manifest fact: an adapter that names no trigger type
    // has no inbound surface to listen to. Only `true` projects — see
    // `AdapterSpec.canFire`.
    ...((manifest.supportedTriggers ?? []).length > 0 ? { canFire: true } : {}),
    ...(keys.length > 0 ? { triggerConfig: keys } : {}),
    ...(Object.keys(options).length > 0 ? { triggerConfigOptions: options } : {}),
    ...(required.length > 0 ? { triggerConfigRequired: required } : {}),
    ...(Object.keys(why).length > 0 ? { triggerConfigRequiredWhy: why } : {}),
    ...(Object.keys(formats).length > 0 ? { triggerConfigFormats: formats } : {}),
    // The adapter's own no-selection dispatch default (whatsapp: messages
    // only) — the checker types a config-less listen with it.
    ...(manifest.defaultSubscribedEvents !== undefined &&
    manifest.defaultSubscribedEvents.length > 0
      ? { defaultEvents: [...manifest.defaultSubscribedEvents] }
      : {}),
  };
}

/**
 * A manifest's full construction signature: the credential (when it needs one)
 * folded in as a `kind: 'credential'` entry, plus every entry-position arg. The
 * single source every catalog builder shares so they can't drift — a builder
 * dropping position args is exactly the bug this consolidation killed.
 */
export function constructionArgsOf(
  manifest: Pick<CatalogManifest, 'requiredCredentialType' | 'positionArgs'>,
): ConstructionArg[] {
  // A `credentials` slot exists ONLY for adapters that actually authenticate —
  // those that declare a `requiredCredentialType`. Credential-free built-ins
  // (email, manual, cron, kg) take no credential: advertising a slot would be
  // a lie the author reaches for (and a no-op). When present, it is required.
  return [
    ...(manifest.requiredCredentialType
      ? [{ name: 'credentials', kind: 'credential' as const, required: true }]
      : []),
    ...(manifest.positionArgs ?? []).map((pa) => ({
      name: pa.name,
      kind: 'position' as const,
      required: false,
      optionsFromType: pa.optionsFrom,
      ...(pa.label !== undefined ? { label: pa.label } : {}),
    })),
  ];
}

/** One adapter, as the catalog builder takes it. */
export interface CatalogAdapterInput {
  manifest: CatalogManifest;
  /**
   * The construction signature when it is not the manifest's own. A remote
   * install the hosted product holds the credential for constructs
   * credential-free; the same external run by `lf` takes the credential its
   * secrets name — a fact about the shell holding the secret, not the adapter.
   */
  constructionArgs?: ConstructionArg[];
  /** How the adapter is connected — a product-shell fact (the hosted product's
   *  connect links); absent where the shell has no such affordance. */
  connect?: AdapterSpec['connect'];
  /** Instance schemas by `instanceSchemaKey`; absent ⇒ none introspected yet. */
  schemas?: Record<string, InstanceSchema>;
  /** Why a schema is missing, keyed like `schemas`. */
  schemaNotes?: Record<string, string[]>;
  /** Entry-position arg values, by credential import name then arg name. */
  constructionArgOptions?: Record<string, Record<string, string[]>>;
}

/** How one adapter's manifest (plus what was introspected) reads to the checker. */
export function adapterSnapshotOf(input: CatalogAdapterInput): AdapterSnapshot {
  const { manifest } = input;
  // Connect affordances are `action` blocks in the manifest's `construction`
  // block list, projected into the `{ kind, label }` the editor and the chat
  // suggestion engine consume — `actionKind` IS the app-shipped handler id.
  const connectActions = (manifest.construction ?? [])
    .filter((b): b is Extract<ConfigBlock, { kind: 'action' }> => b.kind === 'action')
    .map((b) => ({ kind: b.actionKind, label: b.label }));
  return {
    constructionArgs: input.constructionArgs ?? constructionArgsOf(manifest),
    ...triggerConfigVocabulary(manifest),
    ...(connectActions.length > 0 ? { connectActions } : {}),
    ...(input.connect !== undefined ? { connect: input.connect } : {}),
    ...(manifest.triggerExpectation !== undefined ? { triggerExpectation: manifest.triggerExpectation } : {}),
    schemaShape: manifest.introspectedSchema ? 'introspected' : 'static',
    schemas: input.schemas ?? {},
    ...(input.schemaNotes !== undefined ? { schemaNotes: input.schemaNotes } : {}),
    ...(input.constructionArgOptions !== undefined ? { constructionArgOptions: input.constructionArgOptions } : {}),
  };
}

/** The catalog snapshot the checker and the engine read. */
export function buildCatalogSnapshot(input: {
  adapters: readonly CatalogAdapterInput[];
  credentials: Record<string, CredentialSpec>;
  plugins: Record<string, PluginSpec>;
  /** The movement files by import path — what a file import resolves against. */
  files?: Record<string, { source: string }>;
  /** The logical model names this deployment can reach. */
  models?: string[];
}): CatalogSnapshot {
  return {
    contractVersion: CATALOG_SNAPSHOT_VERSION,
    adapters: Object.fromEntries(input.adapters.map((a) => [a.manifest.adapterType, adapterSnapshotOf(a)])),
    credentials: input.credentials,
    plugins: input.plugins,
    ...(input.files !== undefined ? { files: input.files } : {}),
    ...(input.models !== undefined ? { models: input.models } : {}),
  };
}
