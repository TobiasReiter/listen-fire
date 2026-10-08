// Serializable catalog snapshot — the checker `Catalog` as plain data.
//
// The checker's `Catalog` is an interface of lookups plus a synchronous
// `instantiate`; everything network-backed (adapter introspection, the
// credential store, the team ontology) happens while ASSEMBLING it. A
// snapshot captures the assembled result as JSON-safe data so it can cross
// the wire once and the browser can parse/check/complete offline.
//
// Two consumers:
//   - apps/api builds a snapshot per team (movement/catalog.ts) and serves
//     it over tRPC;
//   - the editor (and these language-service functions) rebuild a `Catalog`
//     from it via `fromCatalogSnapshot`.
//
// The snapshot is ALSO the enumeration surface completions need: the
// checker only ever asks "does X exist?", but autocomplete must list what
// exists — adapters, credentials, plugins, per-instance schemas.

import type {
  AdapterSpec,
  Catalog,
  CredentialSpec,
  InstanceSchema,
  PluginSpec,
} from '../checker/catalog';
import { credentialArgOf, entryPositionKeyOf, mockCatalog, modelsMember } from '../checker/catalog';
import type { ResolveFile } from '../checker/link';
import { unwrapCredentialArg } from '../parser/scan';

export interface AdapterSnapshot extends AdapterSpec {
  /**
   * Instance schemas by `instanceSchemaKey` — the credential import name plus
   * the ENTRY POSITION the construction pinned. The bare credential name is the
   * meta-position schema (and `''` the credential-free one), so every key
   * written before positions existed still reads.
   *
   * A schema belongs to (adapter, credential, position), which is how the live
   * team catalog has always keyed it. This dropped the position and keyed on the
   * credential alone, so `google_sheets(…, spreadsheet: "LP Commitments")`
   * resolved to the UNPOSITIONED surface — whose leaves deliberately don't exist
   * until a spreadsheet is named — and the editor called a correct program's own
   * table an unknown edge.
   *
   * An adapter with no entries instantiates untyped — same degradation
   * the live catalog has for failed introspection.
   */
  schemas: Record<string, InstanceSchema>;
  /**
   * WHY a pair's schema is missing, keyed like `schemas` — recorded when a
   * `describeInstance` fetch fails (introspection error, missing
   * credential) so the editor's hover can say "couldn't load this
   * instance's schema: <reason>" instead of going silent. A later
   * successful merge for the same key clears its note.
   */
  schemaNotes?: Record<string, string[]>;
  /**
   * The values each entry-position arg can actually take, by credential import
   * name then arg name (`''` = credential-free). The members of the collection
   * the arg draws from — the spreadsheets this connection was granted, the
   * bases it can see.
   *
   * Carried so the editor can say `'spreadsheet' value "new" isn't one this
   * connection can see`. Without it, a value naming nothing degrades SILENTLY
   * to the unpositioned surface: the author pins a position, gets none, and is
   * told nothing — while `save`, which builds a live catalog, warns. The same
   * editor/compiler divergence as the schemas themselves, in another guise.
   *
   * Absent (or an empty list) ⇒ the options didn't resolve, and the checker
   * skips the warning rather than mis-warning.
   */
  constructionArgOptions?: Record<string, Record<string, string[]>>;
}

/** The catalog snapshot contract's version (docs/contracts/catalog-snapshot.md).
 *  A change in meaning bumps it; an additive optional field does not. */
export const CATALOG_SNAPSHOT_VERSION = 1;

/** The snapshot versions this release reads. */
export const SUPPORTED_CATALOG_SNAPSHOT_VERSIONS: ReadonlySet<number> = new Set([1]);

/** Supported snapshot versions that will be removed. */
export const DEPRECATED_CATALOG_SNAPSHOT_VERSIONS: ReadonlySet<number> = new Set<number>();

export interface CatalogSnapshot {
  /** The contract version the builder wrote it under. Absent on a snapshot
   *  written before snapshots carried one, which reads as version 1. */
  contractVersion?: number;
  adapters: Record<string, AdapterSnapshot>;
  /**
   * Both `{ adapter: string }` (legacy single-adapter form) and
   * `{ adapters: string[] }` (multi-adapter form) are accepted here.
   * `fromCatalogSnapshot` normalizes to `{ adapters }` for the checker.
   */
  credentials: Record<string, { adapter: string } | { adapters: string[] }>;
  plugins: Record<string, PluginSpec>;
  /**
   * The workspace's saved movement files, by name — the import-path
   * namespace (`import { … } from "<file>"`). Carrying the SOURCES keeps
   * the editor's checking full-fidelity offline: imports resolve, library
   * exports complete, imported movements typecheck at call sites.
   */
  files?: Record<string, { source: string }>;
  /** The logical model names this deployment can reach (`Catalog.models`),
   *  so the editor refuses a model the save would refuse. Absent on a
   *  snapshot written before it existed: the model is then left unchecked. */
  models?: string[];
}

export const EMPTY_CATALOG_SNAPSHOT: CatalogSnapshot = {
  adapters: {},
  credentials: {},
  plugins: {},
};

/**
 * Where one instance's schema lives in `AdapterSnapshot.schemas`: its credential
 * import name, plus the entry position its construction pinned.
 *
 * An unpinned instance keys on the bare credential name, so this is backwards
 * compatible with every snapshot written before the position dimension existed
 * — the meta-position schema keeps the key it already had.
 */
export function instanceSchemaKey(instance: {
  credentialName?: string;
  /** From `entryPositionKeyOf`; `''` (or absent) = the meta position. */
  positionKey?: string;
}): string {
  const credential = instance.credentialName ?? '';
  return instance.positionKey ? `${credential}::${instance.positionKey}` : credential;
}

/**
 * Merge one streamed-in `describeInstance` result into a snapshot
 * (non-mutating).
 *
 * The catalog route returns a fast SKELETON (adapters/credentials/plugins,
 * empty `schemas`); per-(adapter, credential) schemas arrive on demand
 * (`describeInstance`) as the editor detects constructions in the source
 * (see ./constructions.ts). Each arrival merges here and the editor
 * re-lints — the checker is silent on unknown schemas by design, so
 * diagnostics only ever TIGHTEN as schemas stream in; no error flicker.
 *
 * A FAILED describe (`schema: null` — broken introspection, missing
 * credential) merges too: its `notes` land in `schemaNotes` under the same
 * key so the hover can explain the gap honestly. A later success for the
 * key replaces the note with the schema.
 *
 * An adapter absent from the snapshot gets a default entry (`credentials`
 * as the universal construction argument) so a late-arriving schema is
 * never dropped.
 */
export function mergeInstanceSchema(
  snapshot: CatalogSnapshot,
  entry: {
    adapter: string;
    credentialName?: string;
    schema: InstanceSchema | null;
    notes?: string[];
  },
): CatalogSnapshot {
  const existing: AdapterSnapshot = snapshot.adapters[entry.adapter] ?? {
    constructionArgs:
      entry.credentialName !== undefined
        ? [{ name: 'credentials', kind: 'credential', required: true }]
        : [],
    schemas: {},
  };
  const key = entry.credentialName ?? '';
  const notes = { ...existing.schemaNotes };
  delete notes[key];
  if (entry.schema === null && entry.notes !== undefined && entry.notes.length > 0) {
    notes[key] = entry.notes;
  }
  const merged: AdapterSnapshot = {
    ...existing,
    schemas:
      entry.schema !== null ? { ...existing.schemas, [key]: entry.schema } : existing.schemas,
  };
  if (Object.keys(notes).length > 0) merged.schemaNotes = notes;
  else delete merged.schemaNotes;
  return {
    ...snapshot,
    adapters: { ...snapshot.adapters, [entry.adapter]: merged },
  };
}

/**
 * The recorded reason an instance's schema is missing, for hover display.
 * Looks up the exact (adapter, credential) key; when that pair has no
 * entry and the adapter has NO schemas at all, any recorded note explains
 * the instance equally (same service, same outage).
 */
export function instanceSchemaNotes(
  snapshot: CatalogSnapshot,
  ref: { adapter: string; credentialName?: string },
): string[] | undefined {
  const adapter = snapshot.adapters[ref.adapter];
  if (!adapter) return undefined;
  const exact = adapter.schemaNotes?.[ref.credentialName ?? ''];
  if (exact !== undefined) return exact;
  if (Object.keys(adapter.schemas).length > 0) return undefined;
  for (const notes of Object.values(adapter.schemaNotes ?? {})) return notes;
  return undefined;
}

/**
 * A live checker `Catalog` over a snapshot. Mirrors the api-side team
 * catalog's resolution rules: the construction call's credential argument
 * picks the schema; an unresolvable credential leaves the instance UNTYPED,
 * so every schema-typed check stays silent for it (the credential error is
 * reported on its own).
 */
export function fromCatalogSnapshot(snapshot: CatalogSnapshot): Catalog {
  refuseUnsupportedSnapshotVersion(snapshot);
  return {
    adapter(name): AdapterSpec | undefined {
      const adapter = snapshot.adapters[name];
      if (!adapter) return undefined;
      // `AdapterSnapshot extends AdapterSpec`, so the spec IS the snapshot
      // entry minus the two snapshot-only members. Take it by SUBTRACTION
      // rather than rebuilding it field by field.
      //
      // Rebuilt-by-enumeration, this silently dropped `canFire` — a flag whose
      // whole design is that its ABSENCE on a known spec is the positive fact
      // "this system cannot fire anything". So every listen in the editor read
      // as un-fireable and MOV_LISTEN_CANNOT_FIRE fired on correct programs,
      // while the identical check passed server-side where the spec is whole.
      //
      // The missing flag is the symptom; the enumeration is the bug. Any field
      // added to `AdapterSpec` was going to be dropped here until someone
      // remembered this list, and nothing would have failed to say so.
      const {
        schemas: _schemas,
        schemaNotes: _schemaNotes,
        constructionArgOptions: _constructionArgOptions,
        ...spec
      } = adapter;
      return spec;
    },
    credential(name): CredentialSpec | undefined {
      const c = snapshot.credentials[name];
      if (!c) return undefined;
      return { adapters: 'adapters' in c ? c.adapters : [c.adapter] };
    },
    credentialNames(): string[] {
      return Object.keys(snapshot.credentials);
    },
    plugin(name): PluginSpec | undefined {
      return snapshot.plugins[name];
    },
    constructionArgOptions({ adapter, credentialName, arg }): string[] | undefined {
      // Mirrors the live catalog: `undefined` when this isn't an enumerable
      // entry-position arg (the checker then leaves it unchecked), so an
      // adapter that publishes no options can never provoke a wrong warning.
      return snapshot.adapters[adapter]?.constructionArgOptions?.[credentialName ?? '']?.[arg];
    },
    instantiate(adapterName, args): InstanceSchema | undefined {
      const adapter = snapshot.adapters[adapterName];
      if (!adapter) return undefined;
      // The node this construction starts at. A positioned lookup that misses
      // falls back to the meta-position schema — mirroring the live catalog and
      // the adapter's own fallback, so the author still gets a coherent
      // (unpositioned) surface rather than silence. The three must agree: a rule
      // the editor applies and the compiler does not IS the divergence.
      const positionKey = entryPositionKeyOf(adapter, args);
      const at = (credentialName?: string): InstanceSchema | undefined =>
        adapter.schemas[instanceSchemaKey({ ...(credentialName !== undefined ? { credentialName } : {}), positionKey })] ??
        adapter.schemas[instanceSchemaKey({ ...(credentialName !== undefined ? { credentialName } : {}) })];
      const credArg = credentialArgOf(adapter);
      if (!credArg) {
        const direct = at();
        if (direct) return direct;
      }
      // Unwrap any backtick-quoted name that a caller may have forwarded
      // without pre-processing (defense-in-depth: callers should unwrap first,
      // but the snapshot instantiate is the last lookup that can catch it).
      const rawCredName = args?.[credArg?.name ?? 'credentials']?.trim();
      const credentialName = rawCredName !== undefined
        ? (unwrapCredentialArg(rawCredName) ?? rawCredName)
        : rawCredName;
      if (credentialName) {
        const schema = at(credentialName);
        if (schema) return schema;
      }
      // No schema for THIS credential → untyped, not another credential's
      // schema. A schema belongs to one (adapter, credential, position); the
      // adapter's other schemas describe other connections, and answering with
      // one is a plausible wrong answer that hides why the real one is missing.
      // Silence is the checker's designed posture for an unknown schema, and
      // the editor's schemas stream in per credential anyway — so this is also
      // "not loaded yet", where staying quiet beats diagnostics from the wrong
      // connection.
      return undefined;
    },
    ...modelsMember(snapshot.models),
  };
}

/** A snapshot written under a version this release cannot read is refused,
 *  never read as though it were the current one. */
function refuseUnsupportedSnapshotVersion(snapshot: CatalogSnapshot): void {
  const seen = snapshot.contractVersion;
  if (seen === undefined || SUPPORTED_CATALOG_SNAPSHOT_VERSIONS.has(seen)) return;
  throw new Error(
    `the catalog snapshot carries contract version ${JSON.stringify(seen)}, which this release does not read ` +
      `(supported: ${[...SUPPORTED_CATALOG_SNAPSHOT_VERSIONS].join(', ')})`,
  );
}

/**
 * A live `Catalog` read back out as a snapshot — for a holder of a catalog
 * object whose consumer takes data (the movement engine takes a snapshot).
 *
 * A `Catalog` answers lookups but cannot list what it holds, so the caller
 * names the adapters and plugins to read; credentials default to the
 * catalog's own `credentialNames()`. Each instance schema is read once per
 * (adapter, credential) at the meta position, so a catalog whose
 * `instantiate` answers differently per entry position is flattened to its
 * unpositioned answer — which is where a snapshot's positioned lookup falls
 * back anyway.
 */
export function catalogSnapshotOf(
  catalog: Catalog,
  names: {
    adapters: Iterable<string>;
    plugins?: Iterable<string>;
    credentials?: Iterable<string>;
  },
): CatalogSnapshot {
  const credentials: Record<string, { adapters: string[] }> = {};
  for (const name of names.credentials ?? catalog.credentialNames?.() ?? []) {
    const spec = catalog.credential(name);
    if (spec) credentials[name] = { adapters: [...spec.adapters] };
  }
  const adapters: CatalogSnapshot['adapters'] = {};
  for (const slug of names.adapters) {
    const spec = catalog.adapter(slug);
    if (!spec) continue;
    const schemas: Record<string, InstanceSchema> = {};
    const credentialArg = credentialArgOf(spec);
    if (!credentialArg) {
      const schema = catalog.instantiate(slug, {});
      if (schema) schemas[instanceSchemaKey({})] = schema;
    } else {
      for (const [credentialName, credential] of Object.entries(credentials)) {
        if (!credential.adapters.includes(slug)) continue;
        const schema = catalog.instantiate(slug, { [credentialArg.name]: credentialName });
        if (schema) schemas[instanceSchemaKey({ credentialName })] = schema;
      }
    }
    adapters[slug] = { ...spec, schemas };
  }
  const plugins: CatalogSnapshot['plugins'] = {};
  for (const name of names.plugins ?? []) {
    const spec = catalog.plugin(name);
    if (spec) plugins[name] = spec;
  }
  const models = catalog.models?.();
  return {
    contractVersion: CATALOG_SNAPSHOT_VERSION,
    adapters,
    credentials,
    plugins,
    ...(models !== undefined ? { models: [...models] } : {}),
  };
}

/** `mockCatalog`, as a snapshot: the fixture's own adapters and plugins. */
export function mockCatalogSnapshot(spec: Parameters<typeof mockCatalog>[0]): CatalogSnapshot {
  return catalogSnapshotOf(mockCatalog(spec), {
    adapters: Object.keys(spec.adapters ?? {}),
    plugins: Object.keys(spec.plugins ?? {}),
  });
}

/** A checker `ResolveFile` over the snapshot's saved movement files;
 *  undefined when the snapshot carries none (file imports then keep the
 *  unresolved behavior). */
export function resolveFileFromSnapshot(snapshot: CatalogSnapshot): ResolveFile | undefined {
  const files = snapshot.files;
  if (!files) return undefined;
  return path => {
    const file = files[path];
    return file !== undefined ? { source: file.source } : undefined;
  };
}
