# The catalog snapshot

Version: 1

A catalog snapshot is a tenant's catalog as plain JSON: the adapters it can construct and their schemas, its credential names, its plugins, the models it can reach, and its saved movement files. The checker, the editor and both engines read it; nothing in it is a live object, and it never carries a credential's secret or id (those travel beside it, as a run's `credentialIds`).

- **The type:** `CatalogSnapshot` (`packages/movement-lang/service/snapshot.ts`, re-exported by `engine-contracts`).
- **Read by:** `fromCatalogSnapshot` (the TypeScript checker, the editor, the TypeScript engine's check) and `CatalogSnapshot::load` (`crates/movement-parser/src/catalog/`, the Rust catalog the Rust engine and the browser parser load). The Rust reader refuses any member the TypeScript does not declare.
- **Built by:** this repository's run host (`toCatalogSnapshot` and `runCatalogSnapshotForTeam` in `translation_graph/movement/catalog.ts`) per team and per run, and `catalogSnapshotOf` (`service/snapshot.ts`) over any live `Catalog`.

## Versions

- **The version is an integer**, stated at the top of this document and held by `CATALOG_SNAPSHOT_VERSION`. This release reads version 1 only (`SUPPORTED_CATALOG_SNAPSHOT_VERSIONS`; [the index](README.md) lists each release).
- **On the wire:** a snapshot carries `contractVersion`. Both builders set it. It is optional on read: a snapshot without one (written before snapshots carried it, or a hand-written fixture) reads as version 1.
- **Refusal:** a reader handed a version it does not read refuses it rather than reading it as the current one. The TypeScript reader throws, and the Rust reader answers an error, with the same message: `the catalog snapshot carries contract version 2, which this release does not read (supported: 1)`.
- **What bumps it:** a change in meaning. A member removed or renamed, a member whose meaning changed, or a required member added. A new optional member keeps the version, but note the Rust reader's strictness: a new member must be declared in its types before a builder may write it, or every Rust read of a snapshot carrying it fails.
- **How a break lands:** the builder writes the new version; a reader that reads both branches on `contractVersion` at the point of difference.

## The shapes

The shapes are TypeScript-ish: `x?: T` may be absent, and an absent member and one that is `undefined` are the same.

```ts
interface CatalogSnapshot {
  contractVersion?: number;                       // absent: 1
  adapters: Record<string, AdapterSnapshot>;      // by adapter type
  credentials: Record<string, { adapters: string[] } | { adapter: string }>;   // by import name; `{ adapter }` is the older single-adapter form
  plugins: Record<string, PluginSpec>;            // by registered name
  files?: Record<string, { source: string }>;     // saved movement files, by import path
  models?: string[];                              // logical model names this deployment reaches; absent: models unchecked
}

interface AdapterSnapshot extends AdapterSpec {
  schemas: Record<string, InstanceSchema>;        // by instance key: the credential import name, plus `::<entry position>` when the construction pins one; '' is credential-free
  schemaNotes?: Record<string, string[]>;         // why a key's schema is missing, keyed like `schemas`
  constructionArgOptions?: Record<string, Record<string, string[]>>;   // entry-position arg values, by credential import name then arg name
}

interface AdapterSpec {
  constructionArgs: ConstructionArg[];
  canFire?: boolean;                              // absent on a known spec: it cannot fire anything
  triggerConfig?: string[];
  triggerConfigOptions?: Record<string, string[]>;
  defaultEvents?: string[];
  triggerConfigRequired?: string[];
  triggerConfigRequiredWhy?: Record<string, string>;
  triggerConfigFormats?: Record<string, 'cron' | 'timezone' | 'fields' | 'strings'>;
  connectActions?: Array<{ kind: string; label: string }>;
  connect?: 'oauth' | 'key-entry' | 'intrinsic' | 'handshake' | 'app-only';
  triggerExpectation?: string;
  schemaShape?: 'static' | 'introspected';
}

interface ConstructionArg {
  name: string;
  kind: 'credential' | 'position';
  required: boolean;
  optionsFromType?: string;
  label?: string;
}

interface PluginSpec {
  args: string[];
  priced: boolean;
  argTypes?: Record<string, SchemaFieldType>;   // each argument's declared input type, by name; absent for one nobody typed
  requiredArgs?: string[];
  effects?: { reads?: string[]; writes?: string[]; ai?: boolean; now?: boolean; suspend?: boolean };
  fedByExtraction?: boolean;
  fedArgs?: Array<{ name: string; required?: true }>;
  output?: PluginOutput;
  earlierOutputs?: Array<{ before: number; output: PluginOutput }>;   // the output under language versions before `before`
}

type PluginOutput =
  | { kind: 'value'; type: SchemaFieldType }
  | { kind: 'record'; fields: Record<string, SchemaFieldType> }
  | { kind: 'records'; fields: Record<string, SchemaFieldType> };

type SchemaFieldType =
  | 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'file' | 'json' | 'absent'
  | { kind: 'list'; of: SchemaFieldType; unordered?: true }
  | { kind: 'tuple'; of: Array<SchemaFieldType | null> }
  | { kind: 'dict'; of: SchemaFieldType }
  | { kind: 'enum'; options: string[]; open?: { allowPattern?: string } }
  | { kind: 'maybeAbsent'; of: SchemaFieldType };

interface InstanceSchema {
  positions: Record<string, PositionSchema>;
  collections: Record<string, { target: string; capability?: EdgeCapability }>;
  unions?: Record<string, string[]>;
  unionDisplayNames?: Record<string, string>;
  writableRoots: Record<string, WritableRootSchema>;
  createShapes?: Record<string, WritableRootSchema>;
  supportsInPlaceUpdate?: boolean;
  edgesCarryProperties?: boolean;
  refinements?: Record<string, string>;
  selectedMembers?: Record<string, string>;
  narrowBy?: Record<string, string[]>;
  genericLandings?: Record<string, string>;
  eventPosition?: string;
  eventPositions?: Array<{ position: string; on?: string[] }>;
  eventNarrowingKeys?: string[];
  eventNarrowingValues?: Record<string, Record<string, string[]>>;
}

interface PositionSchema {
  properties: Record<string, SchemaFieldType>;
  edges: Record<string, EdgeSchema>;
  displayName?: string;
  propertyCapabilities?: Record<string, FieldCapability>;
  openProperties?: boolean;
  undescribed?: boolean;
  pending?: boolean;
  writeOnlyProperties?: string[];
  ambiguousProperties?: string[];
}

interface WritableRootSchema {
  fields: Record<string, SchemaFieldType>;
  resultShape: Record<string, SchemaFieldType>;
  discriminated?: { discriminant: string; variants: Record<string, WritableRootSchema> };
  writeUnion?: { variants: Array<{ name: string; fields: string[] }> };
  position?: string;
  nativeUniqueness?: string[][];
  requiredEdges?: Array<{ edge: string; from: string }>;
  edges?: Record<string, EdgeSchema>;
  requiredFields?: string[];
  fieldDocs?: Record<string, string>;
  fuzzyResolution?: true | string[];
  uniquenessAuthorable?: boolean;
}

interface EdgeSchema {
  target: string;
  polymorphic?: boolean;
  required?: boolean;
  capability?: EdgeCapability;
  sequenced?: 'chronological' | 'document' | 'arrival';
  ephemeral?: boolean;
  readable?: boolean;
  writable?: boolean;
  linkable?: boolean;
  requiresLiveRecord?: boolean;
  subject?: boolean;
  awaitable?: boolean;
  resolvesEmpty?: boolean;
  watchable?: boolean;
  genericOver?: { field: string; onNonLiteral?: 'error' | 'warn' };
}

interface EdgeCapability {
  filter?: 'bounded' | 'native';
  order?: 'bounded' | 'native';
  supportsLimit: boolean;
  naturalOrder?: NaturalOrder;
}

interface NaturalOrder {
  field: string;
  direction: 'asc' | 'desc';
}

interface FieldCapability {
  filterOperators?: Array<'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'in' | 'within'>;
  orderable?: boolean;
}
```

`EdgeSchema` is the checker's (`packages/movement-lang/checker/catalog.ts`); `EdgeCapability`, `NaturalOrder` and `FieldCapability` are shared with the expression layer (`packages/shared/expression/types.ts`). A test holds the member names and optional marks of every interface on this page to those sources. A schema's field types are `SchemaFieldType` only: the Rust reader refuses a field typed with what only the checker's typing builds (a record, a union).

## Changes

- **Version 1** (the first version on the wire). (This page first omitted five optional `InstanceSchema` members, `genericLandings` and the four `event…` members, and inlined no capability types; they were on the wire all along and are documented now. No version change: the shapes did not change.) The snapshot gains `contractVersion`, which both builders set and both readers check. Everything else is the snapshot as it was before it was versioned, when compatibility rested on optional members alone (`files`, `models`, `schemaNotes`, `constructionArgOptions` and the positioned instance keys were each added that way).
