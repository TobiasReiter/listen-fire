// Movement-language catalog backed by the host's real registries.
//
// `movement-lang` stays pure: its checker consumes an injected `Catalog`
// interface. This module is apps/api's implementation of that interface.
// Two tiers:
//
//   - `staticCatalogFromManifests` (M3) — construction-free: adapter
//     existence + construction args from the static manifests, plugins from
//     the transform registry, credentials/instance-schemas injected by
//     the caller (thin hardcoded fixtures for tests).
//   - `movementCatalogForTeam` (M5) — the per-team catalog: credentials
//     from `external_service_credentials` (keyed by an identifier-safe
//     projection of the row's `name`), instance schemas from each
//     adapter's REAL `listEntryPoints()` / `describe(typeId)` introspection
//     under the team's resolved credentials (the same path the TG editor's
//     `listEntryPoints` / `describeTypes` endpoints ride). The knowledge
//     graph rides that ONE path like any other adapter — its schema is its
//     own introspection, not a second DB-direct projection.
//
// The movement surface names types/edges/fields by the adapter's NATURAL
// name (`crm.Companies`, `kg.\`Funding Round\``) — the adapter's displayName
// / reference name. Natural→internal translation rides the ADAPTER LAYER (an
// introspection-derived `AdapterNameResolver`, adapters/name_resolution.ts —
// each adapter builds its own; the engine/host carries none);
// the catalog produces ONLY the checker's surface schemas (per-instance from
// `instanceSchemaFromDescriptors`) and holds NO per-adapter naming logic. The
// KG is not special — its resolver comes from its own introspection like every
// other adapter's.
//
// Still stubbed in the team catalog (honest gaps, kept loud here):
//   - construction args beyond `credentials` — manifests don't declare a
//     construction-config block yet (same TODO as the static catalog).

import {
  entryPositionKeyOf,
  instanceSchemaKey,
  catalogSnapshotOf,
  maybeAbsent,
  parseMovementExpression,
  parseTraversalPath,
  referencedConstructions,
  referencedEventAddresses,
  scanInstanceChains,
  surfaceNotEnumerated,
  type AdapterSpec,
  type Catalog,
  type CatalogSnapshot,
  type ConnectAction,
  type ConstructionArg,
  type CredentialSpec,
  type SchemaFieldType,
  type InstanceSchema,
  type LanguageVersion,
  type PluginOutput,
  type PluginSpec,
  type ResolveFile,
} from 'movement-lang';
import type { Expression } from '#shared/expression/types';
import { neverAsAny } from '../../../lib/utils/types';
import { availableChatModels } from '../../../lib/models/map';
import type { TeamId } from '../../../generated/kysely/core/Team';
import { getAutomationsQb } from '../../../lib/kysely';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import type { AdapterManifest, ConfigBlock } from '../adapter';
import {
  makeMetaPosition,
  positionLabel,
  type ExpressionType,
  type Position,
  type TransformOutputKind,
  type TransformSignature,
} from '../types';
import { connectMethodForType } from '../../credentials/connect_link';
import { isLegacyApp } from '../../credentials/app_id';
import { indexManifestsByName, listAdapterManifests } from '../adapters/registry';
import { listRemoteAdapters } from '../adapters/remote/store';
import { remoteAdapterManifest, RemoteAdapterManifestFile } from '../adapters/remote/manifest';
import { registerBundledTransforms } from '../engine/transforms/register-bundled';
import { getTransform, listTransforms } from '../engine/transforms/registry';
import { assembleMovementFileSources, resolverOverSources } from './files';
import {
  adapterInstanceIsWarm,
  introspectAdapterInstanceCached,
  cachedAdapterInstance,
  type CachedAdapterInstance,
} from './instance_cache';
import { deriveCapabilityNote, deriveIdentityNote } from './adapter_notes';
import { normaliseSchemaForAgent } from './agent_schema';
import { landingOf, walkedNodeFrom, type WalkedDescribedNode, type WalkedNode } from './walk';
import { graftGenericLandings } from './generic_landings';
import { narrowForInspection, refineInstanceSchema } from './refinements';
import { narrowEventPositions } from './listen_narrowing';
import { positionConsumedHopKeys } from './listen_address';
import { getMovementRowByName, listMovementRows } from './store';
import {
  credentialImportNames,
  instanceSchemaFromDescriptors,
  type AdapterSchemaProjection,
  type CredentialRow,
} from './schema_projection';
import { closeDemandOverChains, closeDemandOverWriteVariants, demandSeed } from './demand';

const textList: SchemaFieldType = { kind: 'list', of: 'text' };

/**
 * The listen-config keys that ADDRESS this adapter's events, published onto the
 * instance schema so the checker can derive the type a listen fires.
 *
 * The adapter already declares which hop each config key IS
 * (`ListenConfigKey.narrows`); this is only that set, in declaration order. It
 * rides the schema rather than `AdapterSpec` because `derivedEventType` resolves
 * against an INSTANCE — and an instance is where an event type exists at all.
 *
 */
function withEventNarrowingKeys(
  schema: InstanceSchema,
  listenConfig: readonly { key: string; narrows?: unknown }[],
): InstanceSchema {
  const keys = listenConfig.filter((k) => k.narrows !== undefined).map((k) => k.key);
  return keys.length > 0 ? { ...schema, eventNarrowingKeys: keys } : schema;
}

/**
 * Thin per-adapter instance schemas for the M3 fixtures. STUBS — an
 * adapter's real position/field surface depends on the constructed
 * credentials (which Attio workspace, which Slack team) and is served by
 * `Adapter.describe()` / `listEntryPoints()` at runtime. These cover
 * exactly what the movement fixtures read and write so the checker can
 * exercise its typed checks; any adapter not listed here instantiates
 * untyped (the checker stays silent for it, by design). `staticCatalogFromManifests`
 * itself is not wired into any live authoring path (tests only), so the
 * slack entry below keeps its pre-message-write-unification `channel`
 * field/writableRoot shape as a synthetic checker surface — it is not a
 * claim about the live Slack write path, which is edge-only (see
 * adapters/slack/write.ts and the real per-team projection tested by
 * movement/__test__/catalog.unit.test.ts).
 */
const THIN_INSTANCE_SCHEMAS: Record<string, InstanceSchema> = {
  slack: {
    positions: {
      message: {
        properties: { text: 'text', ts: 'text', user: 'text', channel: 'text' },
        // `replies` models the unified write-back shape: a reply IS the
        // same message type as the one it replies to (whatsapp/telegram
        // thread posts work the same way) — there is no separate send type.
        edges: {
          // Mirrors the real adapter: a message's files come back in the order
          // the message attached them.
          files: { target: 'file', sequenced: 'document' },
          replies: { target: 'message', writable: true },
        },
      },
      file: {
        properties: { name: 'text', url: 'text', contentType: 'text', data: 'file' },
        edges: {},
      },
    },
    collections: { messages: { target: 'message' } },
    writableRoots: {
      message: {
        fields: { channel: 'text', text: 'text' },
        resultShape: { externalId: 'text', channel: 'text', text: 'text' },
      },
    },
  },
  attio: {
    positions: {
      company: {
        properties: { name: 'text', domains: textList, url: 'text', summary: 'text' },
        edges: {
          investments: { target: 'investment', writable: true },
          portfolio: { target: 'fund', writable: true },
        },
      },
      person: {
        properties: { name: 'text', email: 'text' },
        edges: {
          company: { target: 'company', writable: true },
          investments: { target: 'investment', writable: true },
        },
      },
      investment: { properties: { amount: 'number' }, edges: {} },
      fund: { properties: { name: 'text', vintage: 'text' }, edges: {} },
    },
    collections: { companies: { target: 'company' }, people: { target: 'person' } },
    unions: { record: ['company', 'person'] },
    writableRoots: {
      company: {
        fields: { name: 'text', domains: textList, summary: 'text' },
        resultShape: {
          externalId: 'text',
          url: 'text',
          name: 'text',
          domains: textList,
          summary: 'text',
        },
      },
      person: {
        fields: { name: 'text', email: 'text' },
        resultShape: { externalId: 'text', url: 'text', name: 'text', email: 'text' },
      },
      investment: {
        fields: { amount: 'number' },
        resultShape: { externalId: 'text', url: 'text', amount: 'number' },
      },
      fund: {
        fields: { name: 'text', vintage: 'text' },
        resultShape: { externalId: 'text', url: 'text', name: 'text', vintage: 'text' },
      },
    },
  },
  email: {
    positions: {
      message: {
        properties: { subject: 'text', text: 'text' },
        edges: { files: { target: 'attachment' } },
      },
      attachment: {
        properties: { filename: 'text', contentType: 'text', data: 'file' },
        edges: {},
      },
    },
    collections: { messages: { target: 'message' } },
    writableRoots: {},
  },
};

/**
 * A transform's registry signature as the checker's plugin surface — ONE
 * projection, so the static catalog, the live one and the editor snapshot
 * cannot disagree about what a plugin accepts or what it does.
 *
 * `auto` params are what a `through [ … ]` stage is FED — the engine fills them
 * from the extract source — so they stay out of `args` and `requiredArgs`,
 * which are what a STAGE may write. They ride `fedArgs` instead, because a
 * plain call has no stage behind it and writes them itself.
 *
 * The effect row rides through verbatim, and so does the declared output —
 * absent stays absent either way, which is what keeps a plugin nobody has
 * described to `through [ … ]` stages.
 */
function pluginSpecOf(signature: TransformSignature): PluginSpec {
  const authorParams = signature.params.filter((p) => !p.auto);
  const requiredArgs = authorParams.filter((p) => p.required === true).map((p) => p.name);
  // Two different facts, kept apart because they have different answers.
  //
  // An `auto` param is one parameter with two ways of being filled: inside a
  // stage the engine feeds it from the `from [ … ]` source, and a plain call
  // writes it itself. So it stays out of `args` (a stage may not write it) and
  // rides `fedArgs` (a plain call must).
  const fedArgs = signature.params
    .filter((p) => p.auto === true)
    .map((p) => ({ name: p.name, ...(p.required === true ? { required: true as const } : {}) }));
  // `fedByExtraction` is the stronger fact: the plugin reads the fields the
  // enclosing extract has produced and takes nothing of its own, so there is
  // no call an author could write. A plugin with parameters is not this,
  // whatever its scheduling dependency says — `dataDependency` says WHEN it
  // runs, not what it runs on.
  const fedByExtraction =
    signature.dataDependency === 'extracted_context' && authorParams.length === 0;
  const earlierOutputs = (signature.output?.previously ?? []).map((entry) => ({
    before: entry.before,
    output: pluginOutputOf(entry.output),
  }));
  return {
    args: authorParams.map((p) => p.name),
    ...(requiredArgs.length ? { requiredArgs } : {}),
    ...(signature.effects !== undefined ? { effects: signature.effects } : {}),
    ...(fedArgs.length ? { fedArgs } : {}),
    ...(fedByExtraction ? { fedByExtraction: true } : {}),
    ...(signature.output !== undefined ? { output: pluginOutputOf(signature.output) } : {}),
    ...(earlierOutputs.length > 0 ? { earlierOutputs } : {}),
  };
}

/**
 * A declared plugin output as the checker's own type vocabulary. The signature
 * speaks `ExpressionType` + `optional`; the checker speaks `SchemaFieldType` +
 * `maybeAbsent`, which is the same two facts under the names the rest of the
 * language already uses. ONE projection, so what the engine hands back and what
 * the checker typed cannot disagree.
 */
function pluginOutputOf(output: TransformOutputKind): PluginOutput {
  switch (output.kind) {
    case 'value':
      return { kind: 'value', type: outputFieldType(output) };
    case 'record':
      return { kind: 'record', fields: outputFieldTypes(output.fields) };
    case 'records':
      return { kind: 'records', fields: outputFieldTypes(output.fields) };
    default:
      return neverAsAny(output);
  }
}

function outputFieldTypes(
  fields: Record<string, { type: ExpressionType; optional?: boolean }>,
): Record<string, SchemaFieldType> {
  const out: Record<string, SchemaFieldType> = {};
  for (const [name, field] of Object.entries(fields)) out[name] = outputFieldType(field);
  return out;
}

function outputFieldType(field: { type: ExpressionType; optional?: boolean }): SchemaFieldType {
  const base = fieldTypeOfExpressionType(field.type);
  if (field.optional !== true) return base;
  // `maybeAbsent` widens to undefined only for an undefined input, which a
  // projected base type never is.
  return maybeAbsent(base) ?? base;
}

/**
 * `ExpressionType` → `SchemaFieldType`. Deliberately narrow: a plugin output is
 * scalars, lists of them, and nothing else. A `record` inside one would be a
 * node, and a node needs a graph to belong to — a plugin output that wants one
 * is a `record` output at the top, whose fields are these.
 */
function fieldTypeOfExpressionType(type: ExpressionType): SchemaFieldType {
  switch (type.kind) {
    case 'string':
      return 'text';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'timestamp':
      return 'datetime';
    case 'file':
      return 'file';
    case 'enum':
      return { kind: 'enum', options: [...type.values] };
    case 'list':
      return { kind: 'list', of: fieldTypeOfExpressionType(type.element) };
    case 'json':
    case 'record':
      // Structured data nothing further describes — the data top type, which is
      // exactly what `json` means. A caller passes it through unchanged.
      return 'json';
    default:
      return neverAsAny(type);
  }
}

/**
 * Every registered plugin's checker surface, keyed the way a program spells the
 * name. Movement identifiers can't carry dashes and registered transform names
 * do (`vc-url-retrieval`), so the underscore spelling is what a catalog holds.
 *
 * One projection of the live registry, so a caller that needs the real plugin
 * surface — the snapshot builder, a test checking the handbook's own examples —
 * cannot hand the checker a hand-maintained copy that has drifted.
 */
export function registeredPluginSpecs(): Record<string, PluginSpec> {
  registerBundledTransforms();
  const plugins: Record<string, PluginSpec> = {};
  for (const impl of listTransforms()) {
    plugins[impl.signature.name.replace(/-/g, '_')] = pluginSpecOf(impl.signature);
  }
  return plugins;
}

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
 *     `ensureEventSubscription` provisions externally;
 *   - adapter-declared `listenConfig` keys (the cron adapter's required,
 *     cron-format `schedule`) project as keys + required set + value
 *     formats.
 */
function triggerConfigVocabulary(manifest: {
  supportedTriggers?: readonly string[];
  triggerConfig?: readonly ConfigBlock[];
  subscribableEvents?: readonly string[];
  defaultSubscribedEvents?: readonly string[];
  listenConfig?: readonly {
    key: string;
    required?: boolean;
    format?: NonNullable<AdapterSpec['triggerConfigFormats']>[string];
  }[];
}): Pick<
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
 * A real `Catalog` over the host's static registries. Adapter existence
 * and construction arguments come from the manifests; plugins from the
 * transform registry. Credentials and the kg ontology are injected by
 * the caller (they are per-team data — see module header).
 */
/**
 * A manifest's full construction signature: the credential (when it needs one)
 * folded in as a `kind: 'credential'` entry, plus every entry-position arg. The
 * single source all three catalog builders share so they can't drift — the
 * skeleton dropping position args is exactly the bug this consolidation kills.
 */
function constructionArgsOf(
  manifest: Pick<AdapterManifest, 'requiredCredentialType' | 'positionArgs'>,
): ConstructionArg[] {
  // A `credentials` slot exists ONLY for adapters that actually authenticate —
  // those that declare a `requiredCredentialType`. Credential-free built-ins
  // (email, manual, cron, kg) take no credential: the email adapter is
  // constructed from teamId alone and ignores any `credentials:` arg, so
  // advertising a slot would be a lie the author reaches for (and a no-op).
  // When present, the credential slot is always required.
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

export function staticCatalogFromManifests(
  options: {
    /** Workspace credentials by import name — `{ acme_main: { adapter: 'attio' } }`. */
    credentials?: Record<string, CredentialSpec>;
    /** Per-adapter instance schemas, overlaying the thin fixtures above. Keyed
     *  by SLUG, so the knowledge graph (`kg`) is supplied exactly the way any
     *  other adapter is. */
    instanceSchemas?: Record<string, InstanceSchema>;
  } = {},
): Catalog {
  // The transform registry starts empty; the bundled plugins register on
  // first use (idempotent).
  registerBundledTransforms();

  const manifests = indexManifestsByName(listAdapterManifests());

  return {
    adapter(name): AdapterSpec | undefined {
      const manifest = manifests.get(name);
      if (!manifest) return undefined;
      return {
        constructionArgs: constructionArgsOf(manifest),
        ...triggerConfigVocabulary(manifest),
      };
    },
    credential(name): CredentialSpec | undefined {
      return options.credentials?.[name];
    },
    credentialNames(): string[] {
      return Object.keys(options.credentials ?? {});
    },
    plugin(name): PluginSpec | undefined {
      // Movement identifiers can't contain dashes; registered transform
      // names do (`vc-url-retrieval`). Accept the underscore spelling.
      const impl = getTransform(name) ?? getTransform(name.replace(/_/g, '-'));
      return impl ? pluginSpecOf(impl.signature) : undefined;
    },
    instantiate(adapterName): InstanceSchema | undefined {
      // STUB — construction arguments are ignored; see module header for
      // the real per-credential seam.
      const schema = options.instanceSchemas?.[adapterName] ?? THIN_INSTANCE_SCHEMAS[adapterName];
      // These fixtures stand opposite FAKE adapters, and a fake declares the
      // permissive runtime capabilities — inline edge properties included. So
      // the fixture says so too, or the checker calls a name a mistake that
      // the adapter under test answers at run time. The real per-credential
      // projection reads the capability off the adapter itself
      // (`instance_cache`), where it is a fact rather than a fixture.
      return schema !== undefined ? { ...schema, edgesCarryProperties: true } : undefined;
    },
  };
}

/**
 * A catalog over the static manifests, as the snapshot the engine takes:
 * every manifest adapter and registered plugin, read through `catalog` —
 * `staticCatalogFromManifests`, or a fixture wrapping it. The catalog's
 * credentials come along via its `credentialNames()`.
 */
export function snapshotOverManifests(catalog: Catalog): CatalogSnapshot {
  registerBundledTransforms();
  return catalogSnapshotOf(catalog, {
    adapters: listAdapterManifests().map((m) => m.adapterType),
    plugins: Object.keys(registeredPluginSpecs()),
  });
}

/** `staticCatalogFromManifests`, as the snapshot the engine takes. */
export function staticCatalogSnapshot(
  options: Parameters<typeof staticCatalogFromManifests>[0] = {},
): CatalogSnapshot {
  return snapshotOverManifests(staticCatalogFromManifests(options));
}

// ═══════════════════════════════════════════════════════════════════════════
// M5 — the per-team catalog (real instance schemas, real credentials). The
// pure projection helpers (descriptors → InstanceSchema,
// credential rows → import names) live in
// `schema_projection.ts` so the unit suite exercises them without this
// module's registry/DB import graph; re-exported here for callers.
// ═══════════════════════════════════════════════════════════════════════════

export {
  importIdentifier,
  fieldTypeFromDescriptor,
  instanceSchemaFromDescriptors,
  credentialImportNames,
} from './schema_projection';
export type { AdapterSchemaProjection } from './schema_projection';

// ── Team catalog assembly (I/O) ─────────────────────────────────────────────

/** One constructed instance's schema, keyed as the snapshot keys it. */
export interface InstanceSchemaEntry {
  adapter: string;
  /** The credential IMPORT name as authored; absent for credential-free adapters. */
  credentialName?: string;
  /** `entryPositionKeyOf` — `''` is the meta position. */
  positionKey: string;
  schema: InstanceSchema;
  notes: string[];
}

export interface TeamMovementCatalog {
  catalog: Catalog;
  /** Imported credential name → `external_service_credentials.id`. */
  resolveCredentialId: (name: string) => string | undefined;
  /** Credential name → credential row, for reporting/UX. */
  credentialsByName: Record<string, { id: string; rowName: string; adapters: string[] }>;
  /**
   * File-import resolution (`import { … } from "<file>"`) against the
   * team's saved movement rows by name — the transitive closure reachable
   * from `options.source` is prefetched (see ./files.ts), so the same
   * synchronous resolver serves checkProgram and runMovement.
   */
  resolveFile: ResolveFile;
  /** Honest gaps hit while assembling (adapters skipped, collisions, …). */
  notes: string[];
  /**
   * The values each entry-position arg can take, by adapter → credential import
   * name (`''` = credential-free) → arg name. Snapshot-shaped, for the same
   * reason as `instanceSchemas`: the editor checks against a serialized catalog
   * and can only key on the import name.
   */
  positionArgOptions: Record<string, Record<string, Record<string, string[]>>>;
  /**
   * The introspected instance schemas, addressed the way a SNAPSHOT keys them:
   * by the credential IMPORT NAME the program wrote and the entry position its
   * construction pinned — not by credential id.
   *
   * This is what lets a serialized snapshot carry everything the live catalog
   * knows, so the editor checks against the compiler's own answer instead of a
   * thinner one assembled its own way. One entry per DISTINCT instance the
   * source constructs; a pair whose introspection failed is absent (rather than
   * present with some other instance's surface).
   */
  instanceSchemas: InstanceSchemaEntry[];
  /** Structured gaps: every referenced adapter this catalog could NOT type,
   *  either because introspecting it FAILED (unreachable / needs-secret /
   *  mid-redeploy) or because its construction's credential did not resolve.
   *  Both leave the instance untyped and the checker silent about it, so both
   *  belong here. This is the `unverified` signal — distinct from a check
   *  error (`invalid`) — so a consumer never has to parse `notes` strings.
   *  See plans/2026-07-13-movement-validity-lifecycle. */
  gaps: CatalogGap[];
  /** What this assembly cost, for the authoring-latency log (./timing.ts).
   *  Absent on a hand-built catalog — only the live assembly pays anything. */
  cost?: CatalogAssemblyCost;
}

/**
 * The catalog step's own explanation of its wall clock: how many instances it
 * introspected, how many of those were already warm in the 20s instance cache,
 * and how deep the demand loop went (each round is another describe wave over
 * the adapter, so rounds multiply the network cost of a pair).
 */
export interface CatalogAssemblyCost {
  /** (adapter, credential) pairs the source constructs. */
  pairs: number;
  /** Extra instances built for an entry position (`spreadsheet:`-style args). */
  positionedPairs: number;
  /** Pairs whose instance was already live in the cache when we started. */
  warmPairs: number;
  /** The deepest demand loop any pair ran (capped at 8 by the loop itself). */
  demandRounds: number;
}

/** A referenced adapter this catalog could not type — so nothing schema-shaped
 *  about that instance was checked. */
export interface CatalogGap {
  adapter: string;
  detail: string;
}

/** One (adapter, credential row) pairing to introspect. */
interface IntrospectionPair {
  slug: string;
  credentialsId?: string;
}

/**
 * The pairs the compile/catalog assembly should introspect.
 *
 * With `sources` (the program plus its imported library files), only the
 * (adapter, credential) pairs those programs actually CONSTRUCT
 * (referencedConstructions — the same detection the editor streams
 * schemas with); without them, every credential of every manifest (the
 * full-workspace sweep, kept for the dev CLI's `catalog` dump).
 *
 * A referenced construction whose credential does NOT resolve records a
 * `gap` as well as a note: its instance is untyped, and an untyped instance
 * silences every schema-typed check downstream of it. See the gap push below.
 */
function introspectionPairs(input: {
  sources?: string[];
  gaps: CatalogGap[];
  manifests: ReturnType<typeof listAdapterManifests>;
  credentialRows: CredentialRow[];
  credentialsByName: Record<string, { id: string; rowName: string; adapters: string[] }>;
  notes: string[];
}): IntrospectionPair[] {
  const { manifests, credentialRows, credentialsByName, notes, gaps } = input;
  const manifestBySlug = indexManifestsByName(manifests);

  if (input.sources === undefined) {
    const pairs: IntrospectionPair[] = [];
    for (const manifest of manifests) {
      const slug = manifest.adapterType;
      const credentialIds = manifest.requiredCredentialType
        ? credentialRows.filter((r) => r.type === manifest.requiredCredentialType).map((r) => r.id)
        : [undefined];
      if (credentialIds.length === 0) {
        notes.push(
          `${slug}: no ${manifest.requiredCredentialType} credential on this team — instance untyped`,
        );
        continue;
      }
      for (const credentialsId of credentialIds) {
        pairs.push({ slug, ...(credentialsId !== undefined ? { credentialsId } : {}) });
      }
    }
    return pairs;
  }

  const pairs: IntrospectionPair[] = [];
  const seen = new Set<string>();
  const configurationGapsSeen = new Set<string>();
  for (const ref of input.sources.flatMap((source) => referencedConstructions(source))) {
    const manifest = manifestBySlug.get(ref.adapter);
    if (!manifest) continue; // not an adapter — the checker reports it
    // Something the DEPLOYMENT owes this adapter and hasn't supplied (email's
    // inbound address). The instance still types — the schema is knowable
    // without it — but nothing will ever reach the movement, so the author is
    // told rather than left with an automation that silently never fires.
    if (manifest.configurationGap !== undefined && !configurationGapsSeen.has(ref.adapter)) {
      configurationGapsSeen.add(ref.adapter);
      gaps.push({ adapter: ref.adapter, detail: manifest.configurationGap });
      notes.push(`${ref.adapter}: ${manifest.configurationGap}`);
    }
    if (!manifest.requiredCredentialType) {
      const key = `${ref.adapter}::`;
      if (!seen.has(key)) {
        seen.add(key);
        pairs.push({ slug: ref.adapter });
      }
      continue;
    }
    const row = ref.credential !== undefined ? credentialsByName[ref.credential] : undefined;
    if (!row || !row.adapters.includes(ref.adapter)) {
      // Missing/unknown/mismatched credential ⇒ the instance stays UNTYPED,
      // and an untyped instance silences every schema-typed check hanging off
      // it (field names, edge names, write shapes — checker/check.ts's
      // `instanceRefOf` returns undefined and each of those checks returns
      // early). The checker does independently error on a name it cannot
      // resolve, but that made the guarantee a COINCIDENCE of two resolvers
      // agreeing rather than a property of the catalog: any divergence
      // between `referencedConstructions`' reading of the credential name and
      // the checker's `importedCredentialName` yields a movement assessed
      // `valid` with nothing checked. So the untypedness is recorded as a
      // GAP — the same `unverified` signal an introspection failure raises —
      // and validity can never come back clean on an unchecked instance.
      const detail =
        ref.credential === undefined
          ? `the construction names no connection`
          : !row
            ? `no connection named '${ref.credential}'`
            : `'${ref.credential}' is a ${row.adapters.join(', ')} connection, not a ${ref.adapter} one`;
      gaps.push({ adapter: ref.adapter, detail });
      notes.push(
        `${ref.adapter}: construction credential unresolved (${detail}) — instance untyped`,
      );
      continue;
    }
    const key = `${ref.adapter}::${row.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      pairs.push({ slug: ref.adapter, credentialsId: row.id });
    }
  }
  return pairs;
}

/**
 * The per-team manifest set: every static manifest plus the
 * team's installed REMOTE adapters, projected into the same `AdapterManifest`
 * shape. A remote slug colliding with a built-in is skipped (built-ins win —
 * resolution is local-first) with a note. All per-team catalog paths read
 * THIS, so remote installs get the same capability truth, catalog view, and
 * schemaShape advertising as built-ins.
 */
async function teamAdapterManifests(
  teamId: TeamId,
  notes: string[],
): Promise<AdapterManifest[]> {
  const manifests = listAdapterManifests();
  const staticSlugs = new Set(manifests.map((m) => m.adapterType));
  let rows;
  try {
    rows = await listRemoteAdapters({ teamId });
  } catch (err) {
    notes.push(
      `remote adapters: install listing failed (${err instanceof Error ? err.message : String(err)}) — remote installs absent from this catalog`,
    );
    return manifests;
  }
  for (const row of rows) {
    const parsed = RemoteAdapterManifestFile.safeParse(row.manifest);
    if (!parsed.success) {
      notes.push(`${row.adapter_type}: stored remote manifest is malformed — install absent from this catalog`);
      continue;
    }
    if (staticSlugs.has(parsed.data.adapterType)) {
      notes.push(
        `${parsed.data.adapterType}: a remote install collides with a built-in adapter — the built-in wins`,
      );
      continue;
    }
    manifests.push(remoteAdapterManifest(parsed.data));
  }
  return manifests;
}

/**
 * The REAL compile-time catalog for one team (M5).
 *
 *   - adapters + construction args: static manifests (as the static catalog);
 *   - credentials: `external_service_credentials` rows, keyed by the
 *     identifier-safe projection of the row's user-facing `name`;
 *   - instance schemas: real `listEntryPoints()`/`describe()` introspection
 *     per (adapter, credential) pair — prefetched (TTL-cached, see
 *     ./instance_cache.ts) because the checker's `instantiate` is
 *     synchronous. Pass `options.source` to introspect ONLY the pairs the
 *     program constructs (the saveMovement/provision path); omit it for
 *     the full-workspace sweep. Adapters whose required credential the
 *     team doesn't hold (or whose introspection throws) instantiate
 *     untyped — the checker stays silent for them, by design;
 *   - plugins: the framework-global transform registry.
 */
/** Unwrap a raw string-literal construction-arg value (`'"Pipeline"'` →
 *  `Pipeline`). A non-string-literal raw passes through trimmed. */
function unquoteArg(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return t;
}

/** The entry-position values an instance was constructed with (unquoted), keyed
 *  by position-arg name. Empty ⇒ the default (meta) position. Exported for the
 *  provision path — resolving a listen's address reads the SAME values off the
 *  same construction args, so the two cannot disagree about where an instance
 *  is positioned. */
export function positionArgValues(
  manifest: Pick<AdapterManifest, 'positionArgs'>,
  rawArgs: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pa of manifest.positionArgs ?? []) {
    const raw = rawArgs?.[pa.name];
    if (raw !== undefined && raw !== '') out[pa.name] = unquoteArg(raw);
  }
  return out;
}

/**
 * Stable key for the node an instance's cursor starts at — `entryPositionKeyOf`,
 * the language's own derivation, applied to the manifest's construction
 * signature. Empty ⇒ the meta position.
 *
 * Deliberately NOT a second implementation. The checker keys snapshot schemas by
 * this same string, so a host that derived it its own way could disagree with
 * the checker about which node a construction stands at — and the symptom of
 * that disagreement is every positioned lookup silently missing, which is
 * exactly the bug this replaced.
 */
function positionKeyForManifest(
  manifest: Pick<AdapterManifest, 'requiredCredentialType' | 'positionArgs'>,
  rawArgs: Record<string, string> | undefined,
): string {
  return entryPositionKeyOf({ constructionArgs: constructionArgsOf(manifest) }, rawArgs);
}


/** The value an entry-position collection member is named by — what the author
 *  types as the arg value. The shared member-labelling convention
 *  (`positionLabel`): prefers a Title/Name field, else the first string. */
function optionLabelOf(pos: Position): string | undefined {
  return positionLabel(pos);
}

export async function movementCatalogForTeam(
  teamId: TeamId,
  options: {
    /** When given, introspect only the (adapter, credential) pairs this
     *  program constructs instead of the whole workspace. */
    source?: string;
    /**
     * Scope the source-less sweep's per-type describes. `[]` describes NOTHING
     * — the entry lists still come back, which is all a caller needs when it
     * cannot type-check anyway (the parse-error fallback in `authoring.ts`).
     *
     * Without this the only way to assemble a catalog for unparseable source
     * was to fetch every type of every connected system, i.e. load the whole
     * graph to report a missing bracket.
     *
     */
    types?: readonly string[];
    /** `source`'s language-version pin — absent means the current version, as
     *  for an entry point given none. */
    languageVersion?: LanguageVersion;
  } = {},
): Promise<TeamMovementCatalog> {
  registerBundledTransforms();
  const notes: string[] = [];
  const gaps: CatalogGap[] = [];

  const manifests = await teamAdapterManifests(teamId, notes);
  const manifestBySlug = indexManifestsByName(manifests);

  const credentialRows = await loadCredentialRows(teamId);
  const credentialsByName = credentialImportNames({ rows: credentialRows, manifests });

  // File-import closure: libraries construct their OWN instances, so their
  // (adapter, credential) pairs join the referenced set, and the resolver
  // over the prefetched sources serves checkProgram/compile/runMovement.
  // Each file's language-version pin, beside its source: the pre-scan reads a
  // file as the version it was saved under.
  const filePins = new Map<string, LanguageVersion>();
  const fileSources =
    options.source !== undefined
      ? await assembleMovementFileSources({
          rootSource: options.source,
          load: async (path) => {
            const row = await getMovementRowByName({ teamId: teamId as unknown as string, name: path });
            if (row === null) return null;
            filePins.set(path, row.languageVersion);
            return row.source;
          },
        })
      : await allTeamMovementSources(teamId, filePins);
  const resolveFile = resolverOverSources(fileSources);

  const schemaByAdapterAndCred = new Map<string, AdapterSchemaProjection>();
  // Keyed by (adapter, credential, ENTRY POSITION) — the position (from the
  // `spreadsheet:`-style construction arg) picks a different node, so a
  // positioned instance is a distinct schema from the meta-position one.
  const schemaKey = (slug: string, credentialsId?: string, posKey = '') =>
    `${slug}::${credentialsId ?? ''}::${posKey}`;

  const pairs = introspectionPairs({
    ...(options.source !== undefined
      ? { sources: [options.source, ...fileSources.values()] }
      : {}),
    manifests,
    credentialRows,
    credentialsByName,
    notes,
    gaps,
  });

  // Sampled BEFORE anything introspects, so it reports what this call FOUND
  // rather than what it leaves behind.
  const warmPairs = pairs.filter(({ slug, credentialsId }) =>
    adapterInstanceIsWarm({
      adapterType: slug,
      teamId,
      ...(credentialsId !== undefined ? { credentialsId } : {}),
    }),
  ).length;
  let demandRounds = 0;

  // The pre-scan feeding both halves of position-aware compilation: the
  // demand set (which types to describe) and the selectors (which positions
  // to refine).
  const scanSources =
    options.source !== undefined ? [options.source, ...fileSources.values()] : [...fileSources.values()];
  const pinnedOf = (languageVersion: LanguageVersion | undefined) =>
    languageVersion !== undefined ? { languageVersion } : undefined;
  const allChains = [
    ...(options.source !== undefined
      ? scanInstanceChains(options.source, pinnedOf(options.languageVersion))
      : []),
    ...[...fileSources].flatMap(([path, source]) =>
      scanInstanceChains(source, pinnedOf(filePins.get(path))),
    ),
  ];
  const chainsForKey = (key: string) =>
    allChains.filter((chain) => {
      const credentialsId =
        chain.credential !== undefined ? credentialsByName[chain.credential]?.id : undefined;
      return schemaKey(chain.adapter, credentialsId) === key;
    });
  // The event addresses the movement SIGNATURES declare, grounded in their
  // constructions — the fourth pre-scan, beside the demand set, the selectors
  // and the listens. A parameter type is not a hop chain and not a listen, so
  // nothing else sees it; yet a signature's address names a position that does
  // not exist until we walk to it (`listen_narrowing.ts`).
  //
  // SIGNATURES, not listens. The movement declares the type it accepts; a listen
  // must produce one that satisfies it, which is a check, not a source of truth.
  // Grafting off the listens is what let two listens collide on one edge.
  const allAddresses = scanSources.flatMap((s) => referencedEventAddresses(s));
  // Keyed with the construction's ENTRY POSITION, exactly as the schemas are:
  // a positioned instance is a different node than the meta one, so its
  // addresses graft onto ITS schema (relative to its position) and never onto
  // the unpositioned pair's.
  const addressesForKey = (key: string) =>
    allAddresses.filter((address) => {
      const credentialsId =
        address.construction.credential !== undefined
          ? credentialsByName[address.construction.credential]?.id
          : undefined;
      const manifest = manifestBySlug.get(address.construction.adapter);
      const posKey = manifest
        ? positionKeyForManifest(manifest, address.construction.constructionArgs)
        : '';
      return schemaKey(address.construction.adapter, credentialsId, posKey) === key;
    });

  // Everything network-backed happens here, in parallel, each pairing
  // isolated by its own catch (a broken adapter leaves that instance
  // untyped instead of failing the catalog).
  //
  // With a source in hand the introspection is DEMAND-SCOPED: describe only
  // the types the program names (`demandSeed`) plus the recursive closure
  // along its traversal paths (`closeDemandOverChains`), iterating because a
  // hop's target only becomes known once its parent is described. The
  // projection always gets the FULL entry list, so collections stay complete
  // and a type nobody demanded projects `undescribed` — "nobody looked", which
  // the checker reports at the USE (`MOV_UNDESCRIBED_POSITION`), NOT as an open
  // door. It does not project OPEN and the checker does not stay silent; that
  // was the pre-layer-8 behaviour, retired as a measured bug because "I haven't
  // looked" and "anything goes" are different facts. The no-source sweep keeps
  // the full surface.
  const instanceByKey = new Map<string, CachedAdapterInstance>();
  await Promise.all(
    pairs.map(async ({ slug, credentialsId }) => {
      try {
        const key = schemaKey(slug, credentialsId);
        const base = { adapterType: slug, teamId, ...(credentialsId !== undefined ? { credentialsId } : {}) };
        let instance: CachedAdapterInstance;
        let projection: AdapterSchemaProjection;
        if (options.source === undefined) {
          instance = await cachedAdapterInstance({
            ...base,
            ...(options.types !== undefined ? { types: options.types } : {}),
          });
          projection = instance.projection;
        } else {
          instance = await cachedAdapterInstance({ ...base, types: [] });
          const supportsInPlaceUpdate =
            manifestBySlug.get(slug)?.methods?.includes('updateRecord') ?? false;
          const chains = chainsForKey(key);
          const demanded = demandSeed({ entries: instance.rawEntries, sources: scanSources });
          const typeIdByName = new Map(instance.rawEntries.map((e) => [e.displayName, e.typeId]));
          projection = instanceSchemaFromDescriptors({
            adapterType: slug,
            entries: instance.rawEntries,
            descriptors: new Map(),
            ...(instance.metaDescriptor !== null
              ? { metaDescriptor: instance.metaDescriptor }
              : {}),
            supportsInPlaceUpdate,
            lazilyWalked: instance.lazilySurfaced,
          });
          const addresses = addressesForKey(key);
          const listenConfig = manifestBySlug.get(slug)?.listenConfig;
          for (let round = 0; round < 8; round++) {
            demandRounds = Math.max(demandRounds, round + 1);
            instance = await cachedAdapterInstance({ ...base, types: [...demanded] });
            // The types the demand round REACHED by traversal — described, but
            // not published off the meta node (a Sheets table behind its
            // spreadsheet). The instance describes them (`reached` in
            // instance_cache.ts); without threading them through here their
            // descriptors never attach to the reachability-derived position and
            // the checker sees the hop landing as `undescribed` — erroring on
            // every field read over a walked-to collection.
            const publishedTypeIds = new Set(instance.rawEntries.map((e) => e.typeId));
            const reached = instance.introspection.entries.filter(
              (e) => !publishedTypeIds.has(e.typeId),
            );
            projection = instanceSchemaFromDescriptors({
              adapterType: slug,
              entries: instance.rawEntries,
              ...(reached.length > 0 ? { reached } : {}),
              descriptors: instance.introspection.descriptors,
              ...(instance.metaDescriptor !== null
                ? { metaDescriptor: instance.metaDescriptor }
                : {}),
              supportsInPlaceUpdate,
              lazilyWalked: instance.lazilySurfaced,
            });
            // A signature names the full address, so the positions it names are
            // walked and grafted here — the event's `record` edge lands on the
            // table the signature pins, not on the meta type `Table`.
            //
            // INSIDE the loop, before the closure walks: demand follows edge
            // TARGETS, so a closure over the unnarrowed schema demands `Table`
            // — a type no one can name — and describing it means resolving a
            // name with no base to scope it, i.e. a `listTables` per base. That
            // is the workspace fanout this whole model exists to kill, arrived
            // at by chasing a target the listen had already narrowed away.
            if (listenConfig?.length) {
              projection = {
                ...projection,
                schema: withEventNarrowingKeys(projection.schema, listenConfig),
              };
            }
            // Even a hop-less adapter (attio: no `narrows` keys) grafts here —
            // an address may pin only the event node's own `action` axis, and
            // a WIDE address over an action-carrying node grafts its per-action
            // union so `IS` narrowing has variants to land on.
            if (addresses.length > 0) {
              const narrowed = await narrowEventPositions({
                adapterType: slug,
                schema: projection.schema,
                listenConfig: listenConfig ?? [],
                addresses,
                entryPoints: instance.entryPoints,
                walkTo: instance.walkTo,
                membersAt: instance.membersAt,
              });
              projection = { ...projection, schema: narrowed.schema, notes: [...projection.notes, ...narrowed.notes] };
            }
            const touched = closeDemandOverChains({ schema: projection.schema, chains });
            // …plus the variant types of every discriminated write we've now
            // described. They are named by a LITERAL in the body, never by a
            // type name, so nothing textual or traversal-based reaches them.
            for (const name of closeDemandOverWriteVariants(instance.introspection.descriptors)) {
              touched.add(name);
            }
            let grew = false;
            for (const name of touched) {
              const typeId = typeIdByName.get(name);
              // A name the meta node doesn't publish, whose position is already
              // fully described, is one the HOST made: an event's `Record
              // Created` variant (synthesized by the projection from the event
              // entry) or a table a listen narrowed to (walked, then grafted).
              // Demand exists to fill gaps and these have none — so demanding
              // them asks the adapter to describe a name it has never heard of,
              // and a container-shaped adapter answers that by resolving the
              // name across the WHOLE WORKSPACE: a `listTables` per base, the
              // 1+N this model exists to kill. Reached by chasing a type that
              // was already in our hands.
              if (typeId === undefined) {
                const position = projection.schema.positions[name];
                if (position !== undefined && !surfaceNotEnumerated(position)) continue;
              }
              const demand = typeId ?? name;
              if (!demanded.has(demand)) {
                demanded.add(demand);
                grew = true;
              }
            }
            if (!grew) break;
          }
        }
        schemaByAdapterAndCred.set(key, projection);
        instanceByKey.set(key, instance);
        notes.push(...projection.notes);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        gaps.push({ adapter: slug, detail });
        notes.push(`${slug}: introspection failed (${detail}) — instance untyped`);
      }
    }),
  );

  // Position-aware narrowing: resolve the program's decidable selections
  // (`-[s:Type WHERE \`Field\` == "literal"]->`) by WALKING to the type each
  // selector names, and graft the refined positions into a copy of the
  // instance's schema, so the checker binds those aliases to the POSITION's
  // actual surface. Sequential per instance (a chain may step through a refinement
  // an earlier chain grafted); instances refine independently in parallel.
  await Promise.all(
    [...instanceByKey].map(async ([key, instance]) => {
      const chains = chainsForKey(key);
      if (chains.length === 0) return;
      const projection = schemaByAdapterAndCred.get(key);
      if (!projection) return;
      const refined = await refineInstanceSchema({
        instance: {
          adapterType: chains[0].adapter,
          schema: projection.schema,
          entryPoints: instance.entryPoints,
          describeType: instance.describeType,
          membersOf: instance.membersOf,
        },
        chains,
      });
      notes.push(...refined.notes);
      if (refined.schema !== projection.schema) {
        schemaByAdapterAndCred.set(key, { ...projection, schema: refined.schema });
      }
    }),
  );

  // Construction-site landings: the refinements pass's other half. Where a WHERE
  // selects a position, a write BODY can decide a landing TYPE — an ask's
  // `Response` is generic over the very `Options` that ask offered — so resolve
  // each write's literals and graft the synthesized position under the key the
  // checker looks it up by. Purely type-space and purely local (no describe, no
  // network), so it runs after refinements over the same chains.
  for (const [key, instance] of instanceByKey) {
    const chains = chainsForKey(key);
    if (chains.length === 0) continue;
    const projection = schemaByAdapterAndCred.get(key);
    if (!projection) continue;
    const landed = graftGenericLandings({
      instance: {
        adapterType: instance.adapter.adapterType,
        schema: projection.schema,
        entryPoints: instance.entryPoints,
      },
      chains,
    });
    if (landed.schema !== projection.schema) {
      schemaByAdapterAndCred.set(key, { ...projection, schema: landed.schema });
    }
  }

  // Entry-position ARG OPTIONS (the enum the checker warns against): the
  // members of each position arg's meta-node collection, per (adapter,
  // credential). Fetched off the BASE (meta-position) instance's `getRelated`.
  const argOptions = new Map<string, string[]>();
  await Promise.all(
    [...instanceByKey.entries()].map(async ([key, instance]) => {
      const [slug = '', credId = ''] = key.split('::');
      const manifest = manifestBySlug.get(slug);
      if (!manifest?.positionArgs?.length) return;
      for (const pa of manifest.positionArgs) {
        try {
          const related = await instance.adapter.getRelated({
            position: makeMetaPosition(slug),
            fieldId: pa.optionsFrom,
            direction: 'outgoing',
          });
          const opts = related
            .map((r) => optionLabelOf(r.position))
            .filter((s): s is string => s !== undefined);
          argOptions.set(`${slug}::${credId}::${pa.name}`, opts);
        } catch {
          // Leave unset — the checker then skips the warn (never mis-warns).
        }
      }
    }),
  );

  // Entry-position schemas: a construction with a `spreadsheet:`-style arg
  // starts the cursor at that node, so its schema is the node's edges (the
  // sheet's leaves as roots), NOT the meta position's. Introspect one per
  // distinct (adapter, credential, position) the program constructs — the
  // instance is built POSITIONED (constructionArgs flow to the adapter), so its
  // projection already reflects the entry node.
  const positionedTargets = new Map<
    string,
    { slug: string; credentialsId?: string; constructionArgs: Record<string, string>; posKey: string }
  >();
  // Driven by CONSTRUCTIONS, not chains. An entry position belongs to the
  // construction, not to whether anything walks from it: a movement can name a
  // positioned instance purely in a parameter type
  // (`movement m(x: <at-[:`Sales CRM — Deals`]->>)`) and never traverse it — which
  // is the ordinary shape of a listen-driven movement. Keying off chains
  // introspected such an instance UNPOSITIONED, so `instantiate` fell through
  // to the meta-position schema and the parameter's type didn't resolve.
  for (const ref of scanSources.flatMap((source) => referencedConstructions(source))) {
    const manifest = manifestBySlug.get(ref.adapter);
    if (!manifest) continue;
    const values = positionArgValues(manifest, ref.constructionArgs);
    if (Object.keys(values).length === 0) continue; // default position — base pair covers it
    const credentialsId =
      ref.credential !== undefined ? credentialsByName[ref.credential]?.id : undefined;
    const posKey = positionKeyForManifest(manifest, ref.constructionArgs);
    const key = schemaKey(ref.adapter, credentialsId, posKey);
    if (!positionedTargets.has(key)) {
      positionedTargets.set(key, { slug: ref.adapter, credentialsId, constructionArgs: values, posKey });
    }
  }
  await Promise.all(
    [...positionedTargets.values()].map(async (t) => {
      try {
        const positionedBase = {
          adapterType: t.slug,
          teamId,
          ...(t.credentialsId !== undefined ? { credentialsId: t.credentialsId } : {}),
          constructionArgs: t.constructionArgs,
        };
        const supportsInPlaceUpdate =
          manifestBySlug.get(t.slug)?.methods?.includes('updateRecord') ?? false;
        // With a source in hand NOTHING is described until the program asks for
        // it: `types: []` is the demand set before any demand, and an empty
        // demand means nothing, never everything.
        //
        // Taking the instance unscoped first let an empty demand fall through
        // to the full surface. That was harmless only for as long as every
        // adapter carrying `positionArgs` happened also to be container-shaped
        // (airtable and google_sheets are the only two, and remote manifests
        // cannot declare position args), because the cache refuses a
        // full-surface describe there anyway. A coincidence between two facts
        // is not a guarantee about either, and this one expires the moment the
        // eager surface is deleted.
        let instance = await cachedAdapterInstance({
          ...positionedBase,
          ...(options.source !== undefined ? { types: [] } : {}),
        });
        // A `types: []` instance projects from an EMPTY entry list, so the
        // projection is built here from `rawEntries` — the always-enumerated
        // cheap half — exactly as the unpositioned demand-scoped path does.
        let projection =
          options.source === undefined
            ? instance.projection
            : instanceSchemaFromDescriptors({
                adapterType: t.slug,
                entries: instance.rawEntries,
                descriptors: new Map(),
                ...(instance.metaDescriptor !== null
                  ? { metaDescriptor: instance.metaDescriptor }
                  : {}),
                supportsInPlaceUpdate,
                lazilyWalked: instance.lazilySurfaced,
              });
        // With a source in hand, describe the positioned entries the program
        // NAMES. An unscoped instance of a lazily-walked adapter deliberately
        // describes NOTHING (the full surface is the fan-out the walk model
        // kills), which left every positioned root — a Sheets table on a
        // `spreadsheet:` instance — projecting `undescribed` and the checker
        // erroring on its every field read. One seed round suffices: an entry
        // position's roots are its container's own leaves, so the program
        // names them verbatim (no closure over deeper hops to iterate).
        if (options.source !== undefined) {
          const demanded = demandSeed({ entries: instance.rawEntries, sources: scanSources });
          if (demanded.size > 0) {
            instance = await cachedAdapterInstance({ ...positionedBase, types: [...demanded] });
            projection = instanceSchemaFromDescriptors({
              adapterType: t.slug,
              entries: instance.rawEntries,
              descriptors: instance.introspection.descriptors,
              ...(instance.metaDescriptor !== null
                ? { metaDescriptor: instance.metaDescriptor }
                : {}),
              supportsInPlaceUpdate,
              lazilyWalked: instance.lazilySurfaced,
            });
          }
          // EVENT EDGES HANG OFF POSITIONS: a positioned instance's root IS
          // the container, so its event edge is that container's events —
          // narrower by construction. The POSITION CONSUMES THE LEADING
          // ADDRESS HOPS (`airtable(…, base: "Dev Base")` consumes `base`), so
          // the hops published to the checker (`eventNarrowingKeys`, the enum
          // options, the graft) are the REMAINING ones: a table-only signature
          // is a COMPLETE address here, and the same walk starts at the
          // positioned root (whose edges are already the tables) — never
          // wider than the unpositioned instance's own 1 + 1.
          const manifest = manifestBySlug.get(t.slug);
          const consumed = positionConsumedHopKeys({
            listenConfig: manifest?.listenConfig,
            positionValues: t.constructionArgs,
          });
          const listenConfig = (manifest?.listenConfig ?? []).filter(
            (key) => key.narrows === undefined || !consumed.has(key.key),
          );
          const addresses = addressesForKey(schemaKey(t.slug, t.credentialsId, t.posKey));
          if (listenConfig.some((key) => key.narrows !== undefined)) {
            projection = {
              ...projection,
              schema: withEventNarrowingKeys(projection.schema, listenConfig),
            };
          }
          if (addresses.length > 0) {
            const narrowed = await narrowEventPositions({
              adapterType: t.slug,
              schema: projection.schema,
              listenConfig,
              addresses,
              entryPoints: instance.entryPoints,
              walkTo: instance.walkTo,
              membersAt: instance.membersAt,
            });
            projection = {
              ...projection,
              schema: narrowed.schema,
              notes: [...projection.notes, ...narrowed.notes],
            };
          }
        }
        schemaByAdapterAndCred.set(
          schemaKey(t.slug, t.credentialsId, t.posKey),
          projection,
        );
        notes.push(...projection.notes);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        gaps.push({ adapter: t.slug, detail });
        notes.push(`${t.slug}: positioned introspection failed (${detail}) — instance untyped`);
      }
    }),
  );

  const catalog: Catalog = {
    adapter(name): AdapterSpec | undefined {
      const manifest = manifestBySlug.get(name);
      if (!manifest) return undefined;
      return {
        constructionArgs: constructionArgsOf(manifest),
        ...triggerConfigVocabulary(manifest),
      };
    },
    credential(name): CredentialSpec | undefined {
      const row = credentialsByName[name];
      return row ? { adapters: row.adapters } : undefined;
    },
    credentialNames(): string[] {
      return Object.keys(credentialsByName);
    },
    plugin(name): PluginSpec | undefined {
      const impl = getTransform(name) ?? getTransform(name.replace(/_/g, '-'));
      return impl ? pluginSpecOf(impl.signature) : undefined;
    },
    instantiate(adapterName, args): InstanceSchema | undefined {
      const manifest = manifestBySlug.get(adapterName);
      if (!manifest) return undefined;
      // The entry position from the construction's position args. A positioned
      // lookup that misses (e.g. an unknown spreadsheet Title) falls back to the
      // meta-position schema — mirroring the adapter's own fallback, so the
      // author still gets a coherent (unpositioned) surface.
      const posKey = positionKeyForManifest(manifest, args);
      if (!manifest.requiredCredentialType) {
        return (
          schemaByAdapterAndCred.get(schemaKey(adapterName, undefined, posKey))?.schema ??
          schemaByAdapterAndCred.get(schemaKey(adapterName))?.schema
        );
      }
      const credentialName = args?.credentials?.trim();
      const credentialsId = credentialName
        ? credentialsByName[credentialName]?.id
        : undefined;
      if (credentialsId) {
        return (
          schemaByAdapterAndCred.get(schemaKey(adapterName, credentialsId, posKey))?.schema ??
          schemaByAdapterAndCred.get(schemaKey(adapterName, credentialsId))?.schema
        );
      }
      // An unresolvable credential leaves the instance UNTYPED — the checker's
      // sanctioned "I can't produce a schema" answer, which makes every
      // schema-typed check stay silent for it while the credential error itself
      // is reported on its own.
      //
      // This used to fall back to the first prefetched schema for the adapter,
      // on the theory that the same service type means the same vocabulary.
      // It doesn't: a schema is per (adapter, CREDENTIAL, position), so the
      // fallback answered with a DIFFERENT connection's surface — and, being
      // plausible, it concealed the very failure it was papering over. Two live
      // bugs hid behind it (a Slack credential the authoring surface filtered
      // out; an entry position that never reached the prefetch), each looking
      // like a type error in a healthy movement rather than the credential
      // failure it was. Silence is the honest answer.
      return undefined;
    },
    constructionArgOptions({ adapter, credentialName, arg }) {
      const manifest = manifestBySlug.get(adapter);
      // Not an entry-position arg → undefined ⇒ the checker leaves it unchecked.
      if (!manifest?.positionArgs?.some((pa) => pa.name === arg)) return undefined;
      const credentialsId = credentialName ? credentialsByName[credentialName]?.id : undefined;
      // Empty array when options didn't resolve ⇒ checker skips (never mis-warns).
      return argOptions.get(`${adapter}::${credentialsId ?? ''}::${arg}`) ?? [];
    },
    // Deployment state, read per assembly: the model map is fixed for the
    // process, so this is the same answer the run's model layer will give.
    models: () => availableChatModels(),
  };

  // The same schemas, re-addressed for a SNAPSHOT: by the credential import
  // name the program wrote rather than by credential id, which is the only
  // handle a serialized snapshot (and the checker reading it) has.
  //
  // Driven by the CONSTRUCTIONS, so the key is built from the very text
  // `instantiate` will later resolve — the two cannot drift apart into naming
  // one instance differently. No fallback to the meta-position projection: the
  // snapshot's own `instantiate` falls back at READ time, and writing the
  // unpositioned surface under a positioned key would assert that the pinned
  // node has leaves it does not have.
  const instanceSchemas: InstanceSchemaEntry[] = [];
  const seenInstances = new Set<string>();
  for (const ref of scanSources.flatMap((source) => referencedConstructions(source))) {
    const manifest = manifestBySlug.get(ref.adapter);
    if (!manifest) continue;
    const positionKey = positionKeyForManifest(manifest, ref.constructionArgs);
    const dedupe = `${ref.adapter}::${ref.credential ?? ''}::${positionKey}`;
    if (seenInstances.has(dedupe)) continue;
    seenInstances.add(dedupe);
    const credentialsId =
      ref.credential !== undefined ? credentialsByName[ref.credential]?.id : undefined;
    const projection = schemaByAdapterAndCred.get(
      schemaKey(ref.adapter, credentialsId, positionKey),
    );
    if (!projection) continue;
    instanceSchemas.push({
      adapter: ref.adapter,
      ...(ref.credential !== undefined ? { credentialName: ref.credential } : {}),
      positionKey,
      schema: projection.schema,
      notes: projection.notes,
    });
  }

  // The same option lists, re-keyed by credential IMPORT NAME — what a snapshot
  // can carry and what `instantiate` will look up.
  const positionArgOptions: Record<string, Record<string, Record<string, string[]>>> = {};
  for (const [credentialName, row] of [
    ...Object.entries(credentialsByName),
    // The credential-free slot, so an adapter that takes position args without
    // a credential still publishes its options.
    ['', { id: undefined }] as [string, { id?: string }],
  ]) {
    for (const manifest of manifests) {
      for (const pa of manifest.positionArgs ?? []) {
        const options = argOptions.get(`${manifest.adapterType}::${row.id ?? ''}::${pa.name}`);
        if (options === undefined) continue;
        ((positionArgOptions[manifest.adapterType] ??= {})[credentialName] ??= {})[pa.name] =
          options;
      }
    }
  }

  return {
    catalog,
    resolveCredentialId: (name) => credentialsByName[name]?.id,
    credentialsByName,
    resolveFile,
    notes,
    gaps,
    instanceSchemas,
    positionArgOptions,
    cost: {
      pairs: pairs.length,
      positionedPairs: positionedTargets.size,
      warmPairs,
      demandRounds,
    },
  };
}

/** The full-workspace path → source map (the no-source sweep's resolver
 *  base — the dev CLI's catalog dump has no root program to walk from). */
async function allTeamMovementSources(
  teamId: TeamId,
  pins: Map<string, LanguageVersion>,
): Promise<Map<string, string>> {
  const rows = await listMovementRows(teamId as unknown as string);
  for (const row of rows) pins.set(row.name, row.languageVersion);
  return new Map(rows.map((row) => [row.name, row.source]));
}

// ═══════════════════════════════════════════════════════════════════════════
// Catalog snapshot — the catalog as plain JSON (`CatalogSnapshot`,
// movement-lang/service/snapshot.ts) so the browser editor can parse /
// check / complete offline. The editor rebuilds a checker `Catalog` from
// it via `fromCatalogSnapshot`.
//
// Two forms, one builder (`movementCatalogSnapshotForTeam`):
//
//   - NO source — a fast SKELETON: adapters/construction-args, credentials,
//     plugins and kg from DB + manifests only, NO external introspection,
//     `schemas` empty. The editor's first paint.
//   - WITH source — the same skeleton with `schemas` filled from the COMPILE
//     path (`movementCatalogForTeam`), so the editor type-checks against
//     demand-scoped, positioned and narrowing-refined schemas: the compiler's
//     own answer, serialized.
//
// The checker is silent on unknown schemas, so diagnostics only tighten as the
// filled snapshot replaces the skeleton — no error flicker.
// ═══════════════════════════════════════════════════════════════════════════

/** Pure assembly: prefetched pieces → a serializable snapshot. */
export function toCatalogSnapshot(input: {
  adapters: Record<
    string,
    {
      constructionArgs?: ConstructionArg[];
      /** Whether the adapter declares any trigger surface (see `AdapterSpec.canFire`). */
      canFire?: boolean;
      /** `listen` config-key vocabulary (see triggerConfigVocabulary). */
      triggerConfig?: string[];
      /** Per-key value vocabularies (the subscribable-event surface). */
      triggerConfigOptions?: Record<string, string[]>;
      /** Keys a listen must carry (the cron `schedule`, email's `key`). */
      triggerConfigRequired?: string[];
      /** Why each required key is required (see `AdapterSpec`). */
      triggerConfigRequiredWhy?: Record<string, string>;
      /** Per-key static value formats — DERIVED from movement-lang's own spec
       *  rather than re-spelled, because a hand-mirrored copy of a union is a
       *  copy that goes stale (this one did, the day `'fields'` was added). */
      triggerConfigFormats?: AdapterSpec['triggerConfigFormats'];
      /** Interactive "connect" actions the adapter offers (the "+" affordance). */
      connectActions?: ConnectAction[];
      /** How the adapter is connected: 'oauth' | 'key-entry' | 'intrinsic' |
       *  'handshake' | 'app-only' (absent ⇒ no credential needed). */
      connect?: 'oauth' | 'key-entry' | 'intrinsic' | 'handshake' | 'app-only';
      /** What a listener on this adapter actually fires on (manifest prose). */
      triggerExpectation?: string;
      /** 'introspected' = describeInstance costs upstream API calls (scope
       *  with `types`); 'static' = describing is free. */
      schemaShape?: 'static' | 'introspected';
      /** Instance schema per credential IMPORT name; `''` = credential-free. */
      schemas: Record<string, InstanceSchema>;
      /** Why a schema is missing, keyed like `schemas` — hover surfaces it. */
      schemaNotes?: Record<string, string[]>;
      /** Entry-position arg values, by credential import name then arg name. */
      constructionArgOptions?: Record<string, Record<string, string[]>>;
    }
  >;
  credentials: Record<string, CredentialSpec>;
  plugins: Record<string, PluginSpec>;
}): CatalogSnapshot {
  const adapters: CatalogSnapshot['adapters'] = {};
  for (const [slug, spec] of Object.entries(input.adapters)) {
    adapters[slug] = {
      constructionArgs: spec.constructionArgs ?? [
        { name: 'credentials', kind: 'credential', required: true },
      ],
      // Must be forwarded: absence IS the "cannot fire" fact, so dropping it
      // here would silently make every listen on a snapshot-loaded catalog an
      // error rather than leaving it unchecked.
      ...(spec.canFire !== undefined ? { canFire: spec.canFire } : {}),
      ...(spec.triggerConfig !== undefined ? { triggerConfig: spec.triggerConfig } : {}),
      ...(spec.triggerConfigOptions !== undefined
        ? { triggerConfigOptions: spec.triggerConfigOptions }
        : {}),
      ...(spec.triggerConfigRequired !== undefined
        ? { triggerConfigRequired: spec.triggerConfigRequired }
        : {}),
      ...(spec.triggerConfigRequiredWhy !== undefined
        ? { triggerConfigRequiredWhy: spec.triggerConfigRequiredWhy }
        : {}),
      ...(spec.triggerConfigFormats !== undefined
        ? { triggerConfigFormats: spec.triggerConfigFormats }
        : {}),
      ...(spec.connectActions !== undefined ? { connectActions: spec.connectActions } : {}),
      ...(spec.connect !== undefined ? { connect: spec.connect } : {}),
      ...(spec.triggerExpectation !== undefined
        ? { triggerExpectation: spec.triggerExpectation }
        : {}),
      ...(spec.schemaShape !== undefined ? { schemaShape: spec.schemaShape } : {}),
      schemas: spec.schemas,
      ...(spec.schemaNotes !== undefined ? { schemaNotes: spec.schemaNotes } : {}),
      ...(spec.constructionArgOptions !== undefined
        ? { constructionArgOptions: spec.constructionArgOptions }
        : {}),
    };
  }
  return {
    adapters,
    credentials: input.credentials,
    plugins: input.plugins,
  };
}

export interface TeamCatalogSnapshot {
  snapshot: CatalogSnapshot;
  /** Honest gaps hit while assembling (untyped adapters, collisions, …). */
  notes: string[];
  /** Per remote-adapter-install connection status — 'needs-secret' when the
   *  install has no credential yet, 'connected' once its secret is provisioned.
   *  Agent-view only (NOT on the checker's `CatalogSnapshot`): construction is
   *  credential-free, so this is a connection fact, not a type-catalog fact. */
  remoteConnections?: Record<string, 'connected' | 'needs-secret'>;
  /**
   * Referenced adapters that could NOT be typed (introspection failed, or the
   * construction's credential didn't resolve) — the same structured signal
   * `movementCatalogForTeam` reports. Only populated for the source-aware form;
   * the skeleton introspects nothing, so it has nothing to fail at.
   *
   * The editor needs this to tell "this instance is untyped, so I am staying
   * silent about it" apart from "this instance is fine" — the two look
   * identical in the diagnostics, which is why it must be said out loud.
   */
  gaps?: CatalogGap[];
  /**
   * Credential import name → `external_service_credentials.id`. Beside the
   * snapshot, never in it: the snapshot is what the engine and the browser
   * read, and credentials stay with the host that resolves adapters.
   */
  credentialIds: Record<string, string>;
}

/**
 * The agent-facing projection of a catalog snapshot — the curated view BOTH
 * the MCP `listCatalog` tool and the in-app agent return (one source of truth;
 * the raw snapshot also carries editor-only detail the agent doesn't need).
 * Per adapter: its construction args, whether it needs a credential, HOW it
 * connects ('oauth' | 'key-entry' | 'intrinsic' | 'handshake' | 'app-only',
 * absent ⇒ none), its listener-config keys, and — where the manifest states
 * one — `triggerExpectation`, the plain-language truth about what a listener
 * fires on. That rides HERE (the discovery surface, before any credential
 * exists) so the author grounds trigger-surface claims at the moment they
 * form the mental model, not after connecting via describeInstance.
 */
export function toAgentCatalogView(input: {
  snapshot: CatalogSnapshot;
  notes: string[];
  remoteConnections?: Record<string, 'connected' | 'needs-secret'>;
}) {
  const { snapshot, notes, remoteConnections } = input;
  return {
    adapters: Object.fromEntries(
      Object.entries(snapshot.adapters).map(([slug, spec]) => {
        // A remote install connects its secret via a key-entry link. Surface
        // that connect method + whether it's connected yet — WITHOUT flipping
        // `requiresCredential` (construction stays credential-free). A remote
        // adapter with no credential yet reads 'needs-secret' so the author
        // knows to connect it before relying on a live listener.
        const remoteStatus = remoteConnections?.[slug];
        const connect = remoteStatus !== undefined ? ('key-entry' as const) : spec.connect;
        return [
          slug,
          {
            // The full construction signature reaches the agent here — each arg
            // with its kind, whether it's required, and (for position args) the
            // type whose members are the value enum. `requiresCredential` is
            // true only when the folded-in credential slot is REQUIRED (a
            // credential-free adapter exposes an optional slot, not a demand).
            constructionArgs: spec.constructionArgs,
            requiresCredential: spec.constructionArgs.some(
              (a) => a.kind === 'credential' && a.required,
            ),
            ...(connect !== undefined ? { connect } : {}),
            ...(remoteStatus !== undefined ? { remoteConnection: remoteStatus } : {}),
            ...(spec.triggerExpectation !== undefined
              ? { triggerExpectation: spec.triggerExpectation }
              : {}),
            ...(spec.schemaShape !== undefined ? { schemaShape: spec.schemaShape } : {}),
            listenerConfigKeys: spec.triggerConfig ?? [],
          },
        ];
      }),
    ),
    credentials: snapshot.credentials,
    plugins: snapshot.plugins,
    notes,
  };
}

/**
 * The per-team snapshot.
 *
 * WITHOUT a source: the SKELETON — DB + manifests only, no external service
 * touched, `schemas` empty for every adapter. This is the editor's first paint.
 *
 * WITH a source: the same skeleton, with `schemas` filled from
 * `movementCatalogForTeam` — the compile path itself. That means the editor
 * checks against demand-scoped, POSITIONED and NARROWING-REFINED schemas: the
 * compiler's own answer, serialized, rather than a thinner one the editor
 * assembled its own way.
 *
 * That divergence was a live bug class, not a theoretical one. The editor could
 * only ask about an (adapter, credential) pair, so a construction that pinned an
 * entry position (`google_sheets(…, spreadsheet: "LP Commitments")`) or narrowed
 * one (`-[s:Spreadsheet WHERE \`Title\` == "…"]->`) was introspected
 * unpositioned and unrefined — and the editor reported a correct program's own
 * table as an unknown edge while `save` compiled it fine.
 */
export async function movementCatalogSnapshotForTeam(
  teamId: TeamId,
  options: {
    /**
     * The program being edited. Its constructions decide which instances are
     * introspected, at which positions, and which types are described — so the
     * cost is bounded by what the program actually names.
     */
    source?: string;
    /** `source`'s language-version pin — absent means the current version. */
    languageVersion?: LanguageVersion;
  } = {},
): Promise<TeamCatalogSnapshot> {
  registerBundledTransforms();
  const notes: string[] = [];

  const manifests = await teamAdapterManifests(teamId, notes);
  const credentialRows = await loadCredentialRows(teamId);
  const credentialsByName = credentialImportNames({ rows: credentialRows, manifests });

  const adapters: Parameters<typeof toCatalogSnapshot>[0]['adapters'] = {};
  for (const manifest of manifests) {
    // Connect affordances are now `action` blocks in the manifest's
    // `construction` block list (config-blocks Phase 3). Project them into the
    // catalog's `connectActions` shape (`{ kind, label }`) the editor / chat
    // suggestion engine already consumes — `actionKind` IS the app-shipped
    // handler id. The downstream `MovementCompletionItem.connectAction` output
    // is unchanged; only the manifest SOURCE moved (connectActions → action
    // blocks). The kind discriminant does all the branching.
    const connectActions = (manifest.construction ?? [])
      .filter((b): b is Extract<ConfigBlock, { kind: 'action' }> => b.kind === 'action')
      .map((b) => ({ kind: b.actionKind, label: b.label }));
    // How this adapter is connected, surfaced up-front so an author never
    // authors toward (then fails to connect) an app-only adapter: reuse the
    // SAME derivation connectCredential applies — 'oauth'/'key-entry'/
    // 'intrinsic'/'handshake' when a link can be minted, else 'app-only' (a
    // credential is needed but connects in-app). Absent ⇒ no credential needed.
    const connect = manifest.requiredCredentialType
      ? connectMethodForType(manifest.requiredCredentialType)
      : undefined;
    adapters[manifest.adapterType] = {
      // The full construction signature — credential (if any) folded in, plus
      // every position arg. The skeleton is the surface `listConnections` serves
      // and the checker builds its Catalog from, so a dropped arg is both
      // invisible to the author AND rejected as unknown when they reach for it.
      // Shared with the static + live builders via `constructionArgsOf`.
      constructionArgs: constructionArgsOf(manifest),
      ...triggerConfigVocabulary(manifest),
      ...(connectActions.length > 0 ? { connectActions } : {}),
      ...(connect !== undefined ? { connect } : {}),
      ...(manifest.triggerExpectation !== undefined
        ? { triggerExpectation: manifest.triggerExpectation }
        : {}),
      schemaShape: manifest.introspectedSchema ? ('introspected' as const) : ('static' as const),
      schemas: {},
    };
    if (
      manifest.requiredCredentialType &&
      !credentialRows.some((r) => r.type === manifest.requiredCredentialType)
    ) {
      const note = `${manifest.adapterType}: no ${manifest.requiredCredentialType} credential on this team — instance untyped`;
      notes.push(note);
      // Carry the reason in the snapshot itself so the editor's hover can
      // explain WHY this adapter's instances are untyped.
      adapters[manifest.adapterType].schemaNotes = { '': [note] };
    }
  }

  // WITH a source: fill the schemas from the compile path, so the editor reads
  // exactly what `save` will compute. One routine, two consumers — which is the
  // whole point; a second implementation here is what let them disagree.
  let gaps: CatalogGap[] = [];
  if (options.source !== undefined) {
    const live = await movementCatalogForTeam(teamId, {
      source: options.source,
      ...(options.languageVersion !== undefined ? { languageVersion: options.languageVersion } : {}),
    });
    notes.push(...live.notes);
    gaps = live.gaps;
    for (const instance of live.instanceSchemas) {
      const adapter = adapters[instance.adapter];
      if (!adapter) continue;
      adapter.schemas[
        instanceSchemaKey({
          ...(instance.credentialName !== undefined
            ? { credentialName: instance.credentialName }
            : {}),
          positionKey: instance.positionKey,
        })
      ] = instance.schema;
    }
    // What each `spreadsheet:`-style arg can actually be set to, so a value
    // naming nothing WARNS instead of silently falling back to the
    // unpositioned surface.
    for (const [slug, byCredential] of Object.entries(live.positionArgOptions)) {
      const adapter = adapters[slug];
      if (adapter) adapter.constructionArgOptions = byCredential;
    }
  }

  const credentials: Record<string, CredentialSpec> = {};
  const credentialIds: Record<string, string> = {};
  for (const [name, row] of Object.entries(credentialsByName)) {
    credentials[name] = { adapters: row.adapters };
    credentialIds[name] = row.id;
  }

  const plugins = registeredPluginSpecs();

  // Saved movement files — the import-path namespace. Carrying the
  // sources keeps the editor full-fidelity offline: imports resolve,
  // library exports complete, imported movements typecheck at call sites.
  const files: Record<string, { source: string }> = {};
  for (const row of await listMovementRows(teamId as unknown as string)) {
    files[row.name] = { source: row.source };
  }

  // Remote-adapter connection status: 'connected' once the install carries a
  // credential FK, else 'needs-secret'. Keyed by slug; agent-view only.
  const remoteConnections: Record<string, 'connected' | 'needs-secret'> = {};
  try {
    for (const row of await listRemoteAdapters({ teamId })) {
      remoteConnections[row.adapter_type] = row.credentials_id ? 'connected' : 'needs-secret';
    }
  } catch {
    // A listing failure is already surfaced via `notes` by teamAdapterManifests.
  }

  return {
    snapshot: {
      ...toCatalogSnapshot({ adapters, credentials, plugins }),
      files,
      models: availableChatModels(),
    },
    notes,
    remoteConnections,
    ...(gaps.length > 0 ? { gaps } : {}),
    credentialIds,
  };
}

// ── On-demand instance schemas (the streaming half of the skeleton) ────────

export interface DescribedInstance {
  /** Null when the pair can't be introspected — the instance stays
   *  untyped and the checker stays silent for it, by design. */
  schema: InstanceSchema | null;
  notes: string[];
  /**
   * THE WALK'S ANSWER: the node at the requested position (the root when none
   * was given) — what it is, its properties, and every edge leaving it, each
   * edge carrying what it lands on and the address that walks it.
   *
   * This is the shape the contract is converging on: one call, one shape at
   * every depth, and no second mechanism by which a type becomes known. It is
   * present only for adapters that walk (`edgesFrom`); while the rest are
   * Every adapter walks, so this is THE answer — there is no second view of
   * the same graph to disagree with.
   *
   */
  node?: WalkedNode;
  /** The adapter's user-facing one-liner (what it is, what connecting it does). */
  description?: string;
  /** Plain-language truth about what a listener on this adapter fires on —
   *  the agent grounds trigger claims in this rather than inventing them. */
  triggerExpectation?: string;
  /** Movement-authoring tips and caveats for the agent — adapter-specific
   *  guidance that helps it write correct movements. Not surfaced in any
   *  public or user-facing UI; for the authoring agent only. */
  authoringHints?: string;
  /** Who a movement over this system runs AS (the connecting account), and
   *  whose activity triggers a listener on it — derived from the manifest's
   *  credential + registered-actor facts, so the identity idiosyncrasy is
   *  carried by the manifest rather than hand-written prose. Absent for a
   *  system with neither axis (an intrinsic, or a manual/scheduled channel). */
  identity?: string;
  /** What Listen-Fire can and can't do with this system — read/write limits and
   *  whether it can be listened to — derived from its methods + triggers.
   *  Absent when there's nothing limiting to say. */
  capability?: string;
}

/** The manifest's prose about a system — true whether or not it can be introspected. */
type DescribedAbout = Pick<
  DescribedInstance,
  'description' | 'triggerExpectation' | 'authoringHints' | 'identity' | 'capability'
>;

type DescribeCandidate = { id: string; rowName: string; adapters: string[] };

/**
 * Which connection a describe runs against. Naming one is exact — it's the
 * same name the movement source imports by. Naming none is the documented
 * default ("defaults to the system name"), and is the ordinary first hop: an
 * author exploring a system hasn't seen its connections' stored names yet.
 *
 * Ambiguity is reported, never guessed — two connections to one system are two
 * different workspaces, and quietly describing the wrong one is worse than
 * asking. Every unresolved case names what IS reachable, since that's the way
 * out of it.
 */
export function resolveDescribeConnection(input: {
  candidates: DescribeCandidate[];
  requested?: string;
  systemNames: (string | undefined)[];
  credentialType: string;
}): { row: DescribeCandidate } | { note: string } {
  const reachable = () => input.candidates.map((c) => `'${c.rowName}'`).join(', ');

  if (input.candidates.length === 0) {
    return { note: `no ${input.credentialType} credential on this team — instance untyped` };
  }
  if (input.requested !== undefined) {
    const named = input.candidates.find((c) => c.rowName === input.requested);
    return named
      ? { row: named }
      : { note: `connection '${input.requested}' not found — its connections are: ${reachable()}` };
  }

  const systemNames = new Set(
    input.systemNames.filter((n): n is string => n !== undefined).map((n) => n.toLowerCase()),
  );
  const namedForSystem = input.candidates.find((c) => systemNames.has(c.rowName.toLowerCase()));
  if (namedForSystem) return { row: namedForSystem };
  if (input.candidates.length === 1) return { row: input.candidates[0] };

  return {
    note: `several connections could serve — name one of: ${reachable()}`,
  };
}

/**
 * Run a requested narrowing through the SAME machinery the checker's chain
 * pre-pass uses (`refinements.ts`), and report the outcome honestly. `where` is
 * parsed by the language's own expression parser — narrowing on inspect and
 * narrowing in a movement are one vocabulary, not two.
 */
async function applyNarrowing(input: {
  instance: Awaited<ReturnType<typeof cachedAdapterInstance>>;
  adapterType: string;
  narrow: { type: string; where: string };
}): Promise<{
  schema: InstanceSchema | null;
  notes: string[];
  /** Kept internal: the outcome is folded into `notes`, which IS read. The
   *  structured form used to ride out on `DescribedInstance.narrowed` and had
   *  zero readers anywhere — agent, editor or test. */
  report: { type: string; where: string } & Record<string, unknown>;
}> {
  const { instance, narrow } = input;
  const miss = (error: string, members?: string[]) => ({
    // Never the unnarrowed surface: the narrowing WAS the request, and a thin
    // shared surface returned as though it answered is precisely the silent
    // degradation this path exists to prevent.
    schema: null,
    notes: [error],
    report: { type: narrow.type, where: narrow.where, error, ...(members ? { members } : {}) },
  });

  let filter: Expression;
  try {
    filter = parseMovementExpression(narrow.where);
  } catch (err) {
    return miss(
      `narrow: could not parse \`where\` (${err instanceof Error ? err.message : String(err)}) — ` +
        'it is a movement-lang predicate, e.g. `listName` == "Pipeline"',
    );
  }

  const result = await narrowForInspection({
    instance: {
      adapterType: input.adapterType,
      schema: instance.projection.schema,
      entryPoints: instance.entryPoints,
      describeType: instance.describeType,
      membersOf: instance.membersOf,
    },
    typeName: narrow.type,
    filter,
  });

  if (result.ok) {
    return {
      schema: result.schema,
      notes: [],
      report: {
        type: narrow.type,
        where: narrow.where,
        member: result.member,
        as: result.refinedName,
      },
    };
  }

  const failure = result.failure;
  switch (failure.kind) {
    case 'not-polymorphic':
      return miss(
        `narrow: \`${narrow.type}\` has no members to narrow to — it is not a polymorphic type on this connection ` +
          '(an edge that lists `members` is the narrowable one)',
      );
    case 'undecidable':
      return miss(
        `narrow: ${JSON.stringify(narrow.where)} cannot be decided while typing — a narrowing predicate must compare a ` +
          "member's own labelled fields to literals (no AI(), traversals, or runtime values)",
      );
    case 'no-match':
      return miss(
        `narrow: no member of \`${narrow.type}\` matches ${JSON.stringify(narrow.where)} — its members are: ` +
          failure.members.join(', '),
        failure.members,
      );
    case 'no-descriptor':
      return miss(
        `narrow: \`${narrow.type}\` narrowed to \`${failure.member}\`, but describing that member returned nothing`,
      );
    case 'error':
      return miss(`narrow: narrowing \`${narrow.type}\` failed (${failure.message})`);
    default:
      throw new Error(`Unhandled narrow failure: ${neverAsAny(failure)}`);
  }
}

/**
 * Stand at a position and describe what is there — the walk's half of a
 * describe.
 *
 * Three outcomes, and they are deliberately distinguishable. The adapter does
 * not walk: nothing to say (every built-in does; a remote install may not).
 * The path lands somewhere: the node. The path lands NOWHERE: a note saying
 * so, never the root's answer — a call that quietly answers a different
 * question than the one asked is the silent degradation this model removes.
 */
async function walkFor(input: {
  instance: CachedAdapterInstance;
  at?: string;
}): Promise<{ node?: WalkedNode; notes: string[] }> {
  const at = input.at?.trim();

  const steps = at ? parseTraversalPath(at) : [];
  if (steps === undefined) {
    return { notes: [`position: ${JSON.stringify(at)} is not a path — echo one an edge handed back`] };
  }

  const hop = await input.instance.walkFrom(steps);
  if (!hop) {
    // No walk at all is not a failure to report; a walk that went nowhere is.
    return steps.length === 0
      ? { notes: [] }
      : { notes: [`position: ${JSON.stringify(at)} reaches nothing on this connection`] };
  }

  return { node: walkedNodeFrom({ hop, at: at ?? '' }), notes: [] };
}

/**
 * One (adapter, credential) pair's `InstanceSchema` — the same projection
 * the compile path uses, behind the same TTL cache (./instance_cache.ts).
 * `credentialName` is the credential IMPORT name the editor sees in the
 * snapshot. Absent for credential-free adapters, and absent when the caller
 * wants the system's default connection (`resolveDescribeConnection`).
 */
export async function describeMovementInstance(input: {
  teamId: TeamId;
  adapter: string;
  credentialName?: string;
  /** Scope the (expensive) per-type describes to just these type names —
   *  the nodes-then-per-node contract. Omitted = the full surface. The
   *  walked `node` always comes back either way. */
  types?: string[];
  /** Narrow a POLYMORPHIC type to one member and describe that member —
   *  `where` is movement-lang predicate source, parsed by the language's own
   *  parser, so exploring and authoring share one vocabulary (the string that
   *  narrows here is the string that goes in the `WHERE`). */
  narrow?: { type: string; where: string };
  /**
   * WHERE TO STAND. An address handed back by a previous call — one of the
   * edges' `position` strings — echoed verbatim. Absent means the root, which
   * is not a special case but simply the node you get when you name no path.
   *
   * The caller never constructs one of these: an address is only ever learned
   * by walking, which is what keeps a position a route the adapter handed over
   * rather than a name that encodes one.
   *
   */
  position?: string;
  /**
   * The NAMES the caller's program mentions (`referencedNames(source)`).
   *
   * Scopes the describes to the types actually named, so the editor and the
   * compiler see the SAME schema for one source instead of two different
   * answers. Ignored when `types` is given explicitly.
   *
   * Names, not the source text: `describeInstance` is a tRPC QUERY, so its
   * input rides in the URL and a movement of any size overruns it.
   *
   * Matched EXACTLY against published entry names, and only matches are
   * demanded — so an over-inclusive list (which `referencedNames` deliberately
   * is, being lexical) costs nothing. Passing an unmatched name through as a
   * `type` would instead ask the adapter to describe something it never
   * published, which for a container-shaped adapter means resolving that name
   * across the whole workspace.
   *
   */
  mentions?: readonly string[];
  /** Drop the cached entry first — re-introspect the external service. */
  forceRefresh?: boolean;
}): Promise<DescribedInstance> {
  const adapterType = input.adapter;
  const target = await resolveDescribeTarget(input);
  if ('note' in target) return { schema: null, notes: [target.note], ...target.about };
  const { about, credentialsId } = target;

  try {
    const base = {
      adapterType,
      teamId: input.teamId,
      ...(credentialsId !== undefined ? { credentialsId } : {}),
      ...(input.forceRefresh !== undefined ? { forceRefresh: input.forceRefresh } : {}),
    };
    // DEMAND-SCOPE FROM THE SOURCE, exactly as the compile path does.
    //
    // A container-shaped adapter refuses a full-surface describe (it is the
    // 1+N this model exists to kill), so an unscoped call returns every
    // position `undescribed`. The compile path never noticed because it always
    // demand-scopes; the EDITOR could not, having no way to say what it wanted
    // — so for attio, airtable, sheets and affinity it received a hollow
    // schema and the checker reported real errors on correct programs
    // (`'-[:Companies]->' is read-only on 'crm'`, because nothing described
    // the root's writable edges).
    //
    // Two consumers of one instance were reading two different schemas from
    // the same source. That divergence is the defect; the same `demandSeed`
    // on both sides is the fix.
    //
    // `types` still wins when given — an explicit ask is not second-guessed.
    let types = input.types;
    if (types === undefined && input.mentions !== undefined) {
      const seedInstance = await cachedAdapterInstance({ ...base, types: [] });
      // THE SAME demand rule the compile path runs — including its "every
      // firing entry, named or not" clause. Reimplemented here, it lost that
      // clause and the editor reported a correct movement's own event type as
      // unknown.
      types = [...demandSeed({ entries: seedInstance.rawEntries, mentions: input.mentions })];
    }
    const instance = await cachedAdapterInstance({
      ...base,
      ...(types !== undefined ? { types } : {}),
    });
    const narrowed = input.narrow
      ? await applyNarrowing({ instance, adapterType, narrow: input.narrow })
      : undefined;

    const walked = await walkFor({ instance, at: input.position });

    return {
      ...(walked.node ? { node: walked.node } : {}),
      schema: narrowed?.schema === null ? null : normaliseSchemaForAgent(narrowed?.schema ?? instance.projection.schema),
      notes: [...instance.projection.notes, ...(narrowed?.notes ?? []), ...walked.notes],
      ...about,
    };
  } catch (err) {
    return {
      schema: null,
      notes: [
        `${input.adapter}: introspection failed (${err instanceof Error ? err.message : String(err)}) — instance untyped`,
      ],
      ...about,
    };
  }
}

/**
 * Which instance a describe reads: the adapter's manifest prose (carried on
 * every answer, so it is there even when introspection fails) and the
 * credential the named connection resolves to. A note instead when there is
 * nothing to describe against.
 */
async function resolveDescribeTarget(input: {
  teamId: TeamId;
  adapter: string;
  credentialName?: string;
}): Promise<
  | { about: DescribedAbout; credentialsId?: string }
  | { note: string; about?: DescribedAbout }
> {
  const adapterType = input.adapter;
  const manifests = await teamAdapterManifests(input.teamId, []);
  const manifest = manifests.find((m) => m.adapterType === adapterType);
  if (!manifest) return { note: `${input.adapter}: unknown adapter` };

  const identity = deriveIdentityNote(manifest);
  const capability = deriveCapabilityNote(manifest);
  const about: DescribedAbout = {
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(manifest.triggerExpectation ? { triggerExpectation: manifest.triggerExpectation } : {}),
    ...(manifest.authoringHints ? { authoringHints: manifest.authoringHints } : {}),
    ...(identity ? { identity } : {}),
    ...(capability ? { capability } : {}),
  };

  if (!manifest.requiredCredentialType) return { about };
  const credentialRows = await loadCredentialRows(input.teamId);
  const credentialsByName = credentialImportNames({ rows: credentialRows, manifests });
  const resolved = resolveDescribeConnection({
    candidates: Object.values(credentialsByName).filter((c) => c.adapters.includes(adapterType)),
    ...(input.credentialName !== undefined ? { requested: input.credentialName } : {}),
    systemNames: [input.adapter, adapterType, manifest.displayName],
    credentialType: manifest.requiredCredentialType,
  });
  if ('note' in resolved) return { note: `${input.adapter}: ${resolved.note}`, about };
  return { about, credentialsId: resolved.row.id };
}

/**
 * The record types a walk left as STUBS, described by name: each one's fields
 * and identity, as the edge that reaches it would land on them.
 *
 * Through the same cached instance the compile path and describe use, scoped to
 * just these types — so the fetches are shared (single-flight, within the
 * cache window) with any describe or compile that names them, and a type
 * described once costs nothing the next time. A name the instance does not
 * publish is simply absent from the answer.
 */
export async function describeMovementLandings(input: {
  teamId: TeamId;
  adapter: string;
  credentialName?: string;
  types: readonly string[];
}): Promise<Record<string, WalkedDescribedNode>> {
  if (input.types.length === 0) return {};
  const target = await resolveDescribeTarget(input);
  if ('note' in target) return {};
  const instance = await cachedAdapterInstance({
    adapterType: input.adapter,
    teamId: input.teamId,
    ...(target.credentialsId !== undefined ? { credentialsId: target.credentialsId } : {}),
    types: input.types,
  });
  const landings: Record<string, WalkedDescribedNode> = {};
  await Promise.all(
    input.types.map(async (name) => {
      const entry = instance.rawEntries.find((e) => e.typeId === name || e.displayName === name);
      if (!entry) return;
      const descriptor = await instance.describeType(entry.typeId).catch(() => null);
      if (descriptor) landings[name] = landingOf(descriptor);
    }),
  );
  return landings;
}

/**
 * Resolve a movement credential IMPORT name (the snapshot's `credentials`
 * key the editor sees) to its `external_service_credentials.id` for a team,
 * scoped to the adapter that names it — the same mapping `describeInstance`
 * uses. Returns null when the name is unknown or belongs to a different
 * adapter. The connect-affordance grant flow rides this so the editor can
 * pass the credential name it already has, never a raw id.
 */
export async function resolveCredentialIdByImportName(input: {
  teamId: TeamId;
  adapter: string;
  credentialName: string;
}): Promise<string | null> {
  const manifests = await teamAdapterManifests(input.teamId, []);
  const credentialRows = await loadCredentialRows(input.teamId);
  const credentialsByName = credentialImportNames({ rows: credentialRows, manifests });
  const row = credentialsByName[input.credentialName];
  if (!row || !row.adapters.includes(input.adapter)) return null;
  return row.id;
}

// ── DB helpers ──────────────────────────────────────────────────────────────

async function loadCredentialRows(teamId: TeamId): Promise<CredentialRow[]> {
  const rows = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', teamId)
    .select(['id', 'name', 'type', 'created_at', 'app_id'])
    .orderBy('created_at', 'asc')
    .execute();
  return rows
    // Modern authoring surface: hide the legacy Slack app's credentials
    // — movements run on the "listen-fire" app, so only its Slack credentials are
    // offered here. Non-Slack credentials are unaffected.
    .filter((r) => !(r.type === ExternalServiceType.SLACK && isLegacyApp(r.app_id)))
    .map((r) => ({ id: r.id as unknown as string, name: r.name, type: r.type as string }));
}
