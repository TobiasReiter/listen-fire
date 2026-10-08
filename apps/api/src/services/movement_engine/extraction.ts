// Movement engine — the extraction planner + materialiser (E2).
//
// `extract from [data…] { tree }` is a MATERIALISATION: it plans LLM
// phases over the authored tree, runs them, and yields an ephemeral
// result graph (`ExtractEmission`) that the interpreter binds as an
// `extractRoot` and traverses like any other graph.
//
// Planning model (knowledge-pipeline skeleton, author-fenced):
//   - The author's `through` fences are THE ONLY phase boundary. A
//     through-free (sub)tree is ONE LLM call regardless of nesting
//     depth — children nest as arrays inside their parent's emitted
//     entities, so parent↔child association costs nothing.
//   - A `through` pipeline runs PER ENTITY between its node's stages
//     (progressive per-entity branching): the fenced stage re-extracts
//     against the original data plus the entity's accumulated fields
//     plus the plugins' outputs, so deeper nodes see enriched context.
//   - A stage INHERITS the fields of the stage before it and declares
//     only what it transforms, so a node's shape is every field it
//     declares anywhere; a re-declaration is the transformation, and
//     the later stage's value is the one exported.
//
// Runtime conventions are the TG batched-extraction module's
// (`engine/batched_extraction/`): the same pluggable `LlmClient`, the
// same `{ evidence, value }` field wrapping, the same entity-guide
// line shapes, the same validate-then-retry-once loop, the same
// entity-density model selection. What is NEW here is the phase
// planner and the nested (tree-shaped) response schema — the TG
// engine runs one call per `#extract` site; this planner batches a
// whole through-free region into one.
//
// `through` plugins are invoked through the host (`transforms.invoke`); what
// the engine knows of each — the arguments a stage feeds it, the ones it must
// be handed — comes from the run's catalog snapshot (`plugins`).
//
// Field types (incl. enum options) come from EXPLICIT annotations only —
// a primitive name (`amount: number "…"`) or a BORROWED dotted path
// (`stage: crm.companies.funding_stage "…"`) resolved against the live
// instance schema at every firing (the checker's borrow resolution,
// mirrored runtime-side). Backward adoption from typed write targets is
// DEMOTED (explicit over implicit, 3_syntax_sketch.md "Borrowed types
// and enums"): the checker suggests the annotation; only the annotation
// constrains what reaches the LLM.

import { z } from 'zod';
import {
  before,
  BridgeError,
  borrowedTypeSegments,
  isEnumType,
  parseFieldTypeName,
  expressionOfSlot,
  variantOf,
} from 'movement-lang';
import type {
  DeclaredExtractNode,
  EnumType,
  ExprSlot,
  ExtractExpression,
  ExtractField,
  ExtractStage,
  FieldType,
  LanguageVersion,
  PluginCall,
  PluginSpec,
  ShapeNode,
} from 'movement-lang';
import { neverAsAny } from '../../lib/utils/types';
import { mapConcurrent, settledAll } from './fans';
import { languageVersionOf, runLogFields, stopwatch, throwIfCancelled, type IdMint, type RunFacts } from './run_context';
import { matchOption } from '../../lib/utils/string';
import type { LlmCallResult, LlmClient } from '../translation_graph/engine/batched_extraction/llm_call';
import { selectModel } from '../translation_graph/engine/batched_extraction/model_choice';
import { extractionCallSettings, type ExtractionCallSettings, type TierModel } from './ai_tiers';
import { logger } from '../logger';
import type { FileRef, Resource } from '../translation_graph/adapter';
import { fileHandle, isFileRef } from '../translation_graph/adapter';
import { stampResourceIds } from '../translation_graph/engine/files/resources';
import {
  isFileUnreadable,
  MovementEngineError,
  type ExtractionTraceFile,
  type FileTextResolution,
  type FileTextResult,
  type MovementTraceEntry,
  type TracedEntity,
} from './expression';
import type { ExtractSiteRef, Provenance, ProvenanceOrigin } from './provenance';

// ── The result graph ────────────────────────────────────────────────────────

/**
 * One materialised entity of the extract result graph. The root binding
 * is a single emission (the synthetic "extract result" entity); child
 * edges yield the per-entity emissions, exactly as the language's
 * traversal model expects (`deals-[c:company]->` runs once per child).
 */
export interface ExtractEmission {
  /** The node's name in the tree (the root reads as 'extract result'). */
  nodeName: string;
  /** The node's exported field values — every field it declares, across
   *  all its stages. */
  fields: Record<string, unknown>;
  /**
   * Per-field extraction origins (E4): the interned call-site ref, the
   * field's authored description, and the LLM's verbatim quote — the
   * `{ evidence, value }` wrapping the response already carried, kept
   * instead of dropped at materialisation. Keys ⊆ `fields` keys.
   */
  provenance: Record<string, ProvenanceOrigin>;
  /** The entity's own origin (site-level, no field) — what aggregating
   *  the positions themselves carries. */
  origin?: ProvenanceOrigin;
  /**
   * The SOURCE CONTENT that fed this node's extraction (provenance) — the
   * `from [...]` data materialised as resources: one FILE resource per source
   * `FileRef` (the descriptor kept so a downstream write can carry the
   * file forward) and one TEXT resource per text segment. Every emission of one
   * `extract` shares the same `from` data, so the same list rides the root and
   * every descendant. This is what `extractedNode-[:_resources]->` walks and
   * what the engine attaches to `WriteInput.resources` when the node is written
   * (`4d_resources.md` / Layer 5 provenance). */
  resources: Resource[];
  /** Child node name → emissions. */
  children: Map<string, ExtractEmission[]>;
}

// ── The static tree spec (AST projection + annotation resolution) ──────────

export interface ExtractFieldSpec {
  name: string;
  description: string;
  /** The explicit annotation's resolved type — primitive, or borrowed
   *  from a live instance schema (`crm.companies.funding_stage`). */
  type?: FieldType;
  /** `<text | null>` — a value nobody found is handed over null rather than
   *  `""`. The author's side only: the prompt never sees it. */
  nullable?: true;
}

export interface ExtractStageSpec {
  /** The pipeline that runs BEFORE this stage (per entity). Empty on an
   *  unfenced first stage; the ROOT's first-stage pipeline is the
   *  `from [...] through [...]` data pipeline (bundle-level). */
  through: PluginCall[];
  fields: ExtractFieldSpec[];
  children: ExtractNodeSpec[];
}

export interface ExtractNodeSpec {
  name: string;
  description: string;
  stages: ExtractStageSpec[];
  /** The exported shape: every stage's field names, in declaration order,
   *  each named once (a later stage re-declaring a field transforms it). */
  exported: string[];
}

/**
 * The synthesized description for the tree root (it carries the
 * top-level fields; exactly one entity). Mirrors the retired TG-lowering compiler's
 * `ROOT_EXTRACT_DESCRIPTION` so both engines prompt the same intent.
 */
export const ROOT_EXTRACT_DESCRIPTION =
  'the relevant information in the provided source content (exactly one entity carrying the requested fields)';

export interface ExtractSpecOptions {
  /**
   * Resolve a borrowed `<instance>.<root>.<field>` annotation against the
   * LIVE schemas in scope. Called while building the spec — i.e. per
   * firing, so an option added to the borrowed field (an Attio select, a
   * KG enum) is followed without re-saving; no option list is ever
   * copied out of its system. Absent (or unresolvable) → the field
   * extracts untyped, exactly like any other unknown.
   */
  resolveBorrowed?: (
    segments: [instance: string, root: string, field: string],
  ) => FieldType | undefined;
  /**
   * Resolve an annotation naming an author-declared refinement
   * (`type Thesis = <"A" | "B">`). Unlike a borrow this needs no live schema —
   * the program says the whole of it — but it reaches the prompt by the same
   * road, so the extractor is told to pick from a written set exactly as it is
   * told to pick from a fetched one.
   */
  resolveDeclaredType?: (name: string) => FieldType | undefined;
  /**
   * Evaluate a description in the FIRING environment. A description is an
   * ordinary string expression — `deep_dive: "pick from ${\`Deep Dive
   * Themes\`}"` interpolates exactly as a write field's value does — so the
   * words the extractor is given are only known once the environment exists.
   * Building the spec per firing is what makes that honest.
   *
   * Absent, only descriptions that interpolate NOTHING can be resolved; one
   * that does throws rather than pasting `${…}` into the prompt.
   */
  resolveDescription?: (slot: ExprSlot) => Promise<string>;
  /**
   * The node declaration `node entry: <Entry>` takes as its shape, with the
   * resolvers for ITS words and types — a declaration's descriptions and
   * refinements read the scope it was declared in (its file's), not the scope
   * of whichever movement reuses it. Absent (or unresolvable) and a declared
   * node cannot be built.
   */
  resolveDeclaredNode?: (type: string) => DeclaredNodeShape | undefined;
}

export interface DeclaredNodeShape {
  /** The declaration as written — its own members only when it extends one. */
  root: ShapeNode;
  resolveDeclaredType: (name: string) => FieldType | undefined;
  resolveDescription: (slot: ExprSlot) => Promise<string>;
  /** `node X extends Y`: Y, with the resolvers of the scope Y was declared in. */
  base?: DeclaredNodeShape;
}

export async function buildExtractSpec(
  extract: ExtractExpression,
  options?: ExtractSpecOptions,
): Promise<ExtractNodeSpec> {
  return buildNodeSpec('extract result', ROOT_EXTRACT_DESCRIPTION, extract.stages, options);
}

/**
 * One description, as text. The literal is desugared by the shared bridge —
 * the same code path as every other string in the language, so escapes and
 * `${…}` mean here exactly what they mean in a write field.
 */
async function describeSlot(
  slot: ExprSlot,
  options: ExtractSpecOptions | undefined,
): Promise<string> {
  let expr;
  try {
    expr = expressionOfSlot(slot);
  } catch (e) {
    if (!(e instanceof BridgeError)) throw e;
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `invalid extract description (the checker should have caught this): ${e.message}`,
    );
  }
  if (expr.type === 'static') return typeof expr.value === 'string' ? expr.value : `${expr.value ?? ''}`;
  if (options?.resolveDescription === undefined) {
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `an extract description that interpolates (${slot.raw}) can only be built with a firing environment — build the spec with 'resolveDescription'`,
    );
  }
  return options.resolveDescription(slot);
}

/** Words that may not have been written: an undescribed field of a node
 *  declaration is extracted by its name alone. */
async function describeOptional(
  slot: ExprSlot | undefined,
  options: ExtractSpecOptions | undefined,
): Promise<string> {
  return slot === undefined ? '' : describeSlot(slot, options);
}

/** EXPLICIT annotations only (adoption is demoted): a primitive type name, a
 *  declared refinement, or a borrowed path resolved through
 *  `options.resolveBorrowed`. */
function resolveFieldType(
  field: Pick<ExtractField, 'type'>,
  options: ExtractSpecOptions | undefined,
): FieldType | undefined {
  const segments = borrowedTypeSegments(field.type);
  if (segments === undefined) {
    return (
      parseFieldTypeName(field.type)
      ?? (field.type !== undefined ? options?.resolveDeclaredType?.(field.type) : undefined)
    );
  }
  if (segments.length !== 3) return undefined; // checker reports MOV_BORROW_MALFORMED
  return options?.resolveBorrowed?.([segments[0], segments[1], segments[2]]);
}

async function buildNodeSpec(
  name: string,
  description: string,
  stages: ExtractStage[],
  options: ExtractSpecOptions | undefined,
): Promise<ExtractNodeSpec> {
  return {
    name,
    description,
    exported: [...new Set(stages.flatMap((stage) => stage.fields.map((f) => f.name)))],
    stages: await settledAll(
      stages.map(async (stage) => ({
        through: stage.through ?? [],
        fields: await settledAll(
          stage.fields.map(async (f) => {
            const type = resolveFieldType(f, options);
            return {
              name: f.name,
              description: await describeSlot(f.description, options),
              ...(type !== undefined ? { type } : {}),
              ...(f.nullable ? { nullable: f.nullable } : {}),
            };
          }),
        ),
        children: await settledAll(
          stage.children.map(async (c) =>
            c.declared === undefined
              ? buildNodeSpec(c.name, await describeSlot(c.description, options), c.stages, options)
              : buildDeclaredNodeSpec(c, options),
          ),
        ),
      })),
    ),
  };
}

/**
 * `node entry: <Entry> "…" through […] { … }` — the spec the inline block that
 * spells the declaration out would build: the declaration is the first stage
 * (its fields, their types, its nested nodes, all its words), the `through`
 * stages follow, and a use-site description replaces the declaration's own.
 */
async function buildDeclaredNodeSpec(
  node: DeclaredExtractNode,
  options: ExtractSpecOptions | undefined,
): Promise<ExtractNodeSpec> {
  const declared = options?.resolveDeclaredNode?.(node.declared.type);
  if (declared === undefined) {
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `'${node.declared.type}' is not a node declaration in scope, so '${node.name}' has no shape to extract (the checker should have caught this)`,
    );
  }
  const shape = await buildDeclarationSpec(node.name, declared, options);
  const following = await buildNodeSpec(node.name, '', node.stages, options);
  return {
    name: node.name,
    description:
      node.description !== undefined ? await describeSlot(node.description, options) : shape.description,
    exported: [...new Set([...shape.exported, ...following.exported])],
    stages: [...shape.stages, ...following.stages],
  };
}

/**
 * A declaration as the single-stage spec its inline spelling builds. With a
 * base, that spelling is the base's members first, then its own (the checker's
 * `inheritDeclaration`), and the record's words are its own or else the
 * base's — but each part is built with the resolvers of the declaration that
 * WROTE it, so an inherited word interpolates in its own file.
 */
export async function buildDeclarationSpec(
  name: string,
  declared: DeclaredNodeShape,
  options: ExtractSpecOptions | undefined,
): Promise<ExtractNodeSpec> {
  const own = await buildShapeNodeSpec(name, declared.root, {
    ...options,
    resolveDeclaredType: declared.resolveDeclaredType,
    resolveDescription: declared.resolveDescription,
  });
  if (declared.base === undefined) return own;
  const base = await buildDeclarationSpec(name, declared.base, options);
  return {
    name,
    description: declared.root.description !== undefined ? own.description : base.description,
    exported: [...base.exported, ...own.exported],
    stages: [
      {
        through: [],
        fields: [...base.stages[0].fields, ...own.stages[0].fields],
        children: [...base.stages[0].children, ...own.stages[0].children],
      },
    ],
  };
}

/** One node of a declaration, as the single-stage spec its inline spelling
 *  would build. */
async function buildShapeNodeSpec(
  name: string,
  shape: ShapeNode,
  options: ExtractSpecOptions,
): Promise<ExtractNodeSpec> {
  return {
    name,
    description: await describeOptional(shape.description, options),
    exported: shape.fields.map((f) => f.name),
    stages: [
      {
        through: [],
        fields: await settledAll(
          shape.fields.map(async (f) => {
            const type = resolveFieldType(f, options);
            return {
              name: f.name,
              description: await describeOptional(f.description, options),
              ...(type !== undefined ? { type } : {}),
              ...(f.nullable ? { nullable: f.nullable } : {}),
            };
          }),
        ),
        children: await settledAll(
          shape.children.map((c) => buildShapeNodeSpec(c.name, c, options)),
        ),
      },
    ],
  };
}

// ── Runtime dependencies ────────────────────────────────────────────────────

/** One `through` plugin invocation's contribution back to the context. */
export interface TransformInvocationResult {
  text?: string;
  data?: Record<string, unknown>;
  /**
   * Each thing the plugin fetched, as its own record — the link, a name, the
   * file, the text — in the order it fetched them. A stored document is
   * already the file value a write can carry (never the storage id it was
   * emitted as), and a fetch that stored nothing has no `file` at all.
   *
   * Two readers: a plain call to a `records`-output plugin binds exactly this
   * list, and a `through` stage turns every record carrying a file into a FILE
   * resource on the extracted record's `_resources`.
   */
  records?: Array<Record<string, unknown>>;
  /** What the plugin says became of the invocation, in its own words. Carried
   *  to the trace and nowhere else — an outcome is not enrichment, so a
   *  plugin that reports one and attaches nothing still counts as empty. */
  outcome?: string;
}

/** The plugins a run's catalog snapshot describes, by name. */
export type PluginSpecs = Readonly<Record<string, PluginSpec>>;

/** A plugin by either spelling: movement identifiers can't carry dashes, so a
 *  program writes `vc_url_retrieval` for a plugin registered as
 *  `vc-url-retrieval`; the snapshot keys the underscore spelling. */
export function pluginSpecNamed(plugins: PluginSpecs, plugin: string): PluginSpec | undefined {
  const spelled = plugin.replace(/-/g, '_');
  return Object.hasOwn(plugins, spelled) ? plugins[spelled] : undefined;
}

/** One plugin invocation, as the engine asks for it. */
export interface TransformInvokeInput {
  plugin: string;
  /** The author's named arguments, resolved per entity. */
  config: Record<string, unknown>;
  /** The entity's extracted fields so far (working fields included). */
  extractedContext: Record<string, unknown>;
}

/** The plugin invoker an extraction calls — inside a run, the host's
 *  invoker under the run's budget (`run_context.ts` `pricedCalls`), which
 *  refuses a priced plugin once the run has spent its cap and charges what
 *  every invocation spent. */
export interface MovementTransformInvoker {
  invoke(input: TransformInvokeInput): Promise<TransformInvocationResult>;
}

/** Ancestor fields handed to a nested node's plugin, nested under the
 *  ancestor node's name so a consumer can tell them apart from the node's
 *  own fields *structurally* — a company's fields arrive under `company`,
 *  distinct from the person's own top-level `name`, without relying on the
 *  ancestor node's name being known. An ancestor with no fields contributes
 *  nothing. Deeper ancestors accumulate as sibling keys. */
function namespaceContext(
  nodeName: string,
  context: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(context).length === 0) return {};
  return { [nodeName.replace(/\W+/g, '_')]: { ...context } };
}

/**
 * The FILE resources a plugin's records carry — one per record whose `file` is
 * a file value, shaped exactly as a source file's resource is (`file`, `name`,
 * `type`), plus the `url` it was fetched from. To the language the two are the
 * same thing: a file the record was extracted from, walked off `_resources`.
 */
function pluginFileResources(
  result: TransformInvocationResult,
  languageVersion: LanguageVersion,
): Resource[] {
  // Version 1's `_resources` held the `from [ … ]` sources alone.
  if (before(languageVersion, 2)) return [];
  const resources: Resource[] = [];
  for (const record of result.records ?? []) {
    const file = record.file;
    if (!isFileRef(file)) continue;
    const name = typeof record.name === 'string' ? record.name : file.name;
    const url = typeof record.url === 'string' ? record.url : null;
    const externalId = fileHandle(file);
    resources.push({
      ...(externalId !== undefined ? { externalId } : {}),
      type: 'FILE',
      ...(name !== undefined ? { name } : {}),
      url,
      fileRef: file,
      ...(file.contentType !== undefined ? { contentType: file.contentType } : {}),
      data: {
        file,
        ...(name !== undefined ? { name } : {}),
        ...(url !== null ? { url } : {}),
        type: 'FILE',
        ...(file.contentType !== undefined ? { contentType: file.contentType } : {}),
      },
    });
  }
  return resources;
}

/** What the trace sample reads off an extracted tree: the keyword's emissions
 *  and the call's records both fit it. */
export interface TracedTree {
  nodeName: string;
  fields: Record<string, unknown>;
  children: Map<string, TracedTree[]>;
}

/** How much of an extract's output a run keeps for inspection. The trace
 *  rides `trigger_run.steps` (jsonb), so the sample is bounded per alias
 *  and per value — and whatever the cap drops is counted, never dropped
 *  silently. */
const TRACE_ENTITY_CAP = 20;
const TRACE_VALUE_CHARS = 200;

/**
 * Hang the extract's emitted entities off the trace, so a reader can open
 * "3 companies" and see WHICH three — and, the case this exists for, that
 * one of them came back with a null name. Attaches the whole tree (the
 * root's own fields plus every child alias) to the LAST extraction entry
 * of this extract: an extract reads as one step, and only after its final
 * region has run is the tree complete.
 */
export function recordExtractedEntities(
  trace: MovementTraceEntry[],
  from: number,
  root: TracedTree,
): void {
  let target: Extract<MovementTraceEntry, { kind: 'extraction' }> | undefined;
  for (let i = trace.length - 1; i >= from; i--) {
    const entry = trace[i];
    // A per-entity stage skipped for want of anything new to read describes a
    // call that never happened — often the LAST entry of a staged extract. The
    // tree belongs to the last call that did happen.
    if (entry.kind === 'extraction' && entry.skipped !== 'no_enrichment') {
      target = entry;
      break;
    }
  }
  // A skipped extract never called out — its "root" is the engine's
  // synthetic all-null stand-in, not something that was read.
  if (!target || target.skipped) return;
  const entities: Record<string, TracedEntity[]> = {};
  const truncatedCount: Record<string, number> = {};
  collectTracedEntities(root, entities, truncatedCount);
  if (Object.keys(entities).length > 0) target.entities = entities;
  if (Object.keys(truncatedCount).length > 0) target.truncatedCount = truncatedCount;
}

/** Depth-first over the emission tree, bucketing entities by node alias.
 *  A fieldless node (a pure container) contributes nothing to show. */
function collectTracedEntities(
  emission: TracedTree,
  into: Record<string, TracedEntity[]>,
  truncated: Record<string, number>,
): void {
  const fields = Object.entries(emission.fields);
  if (fields.length > 0) {
    const alias = emission.nodeName;
    const bucket = (into[alias] ??= []);
    if (bucket.length < TRACE_ENTITY_CAP) {
      bucket.push({
        fields: Object.fromEntries(fields.map(([name, value]) => [name, tracedValue(value)])),
      });
    } else {
      truncated[alias] = (truncated[alias] ?? 0) + 1;
    }
  }
  for (const children of emission.children.values()) {
    for (const child of children) collectTracedEntities(child, into, truncated);
  }
}

/** An extracted value as the trace shows it — absent stays `null` (an
 *  unfilled field must read as unfilled), everything else becomes a
 *  bounded string. */
function tracedValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return text.length > TRACE_VALUE_CHARS ? `${text.slice(0, TRACE_VALUE_CHARS)}…` : text;
}

// ── Trace caps ──────────────────────────────────────────────────────────────
//
// Everything below rides `trigger_run.steps` (jsonb) with no cap on the column,
// so each observation caps itself the way the emitted-entity sample does
// (`TRACE_ENTITY_CAP` / `TRACE_VALUE_CHARS` in run.ts). A 41k-character input
// must not turn into a 41k-character row.

/** Prompt parts kept per call; the rest are counted, not listed. */
const TRACE_INPUT_PARTS = 12;
/** How much of a misbehaving reply is kept — enough to read the shape the
 *  model chose and the first entity or two, not the whole body. */
const TRACE_REPLY_CHARS = 1000;
/** Reply digests kept per RUN. A fan-out extracts once per entity, so a
 *  systematically-confused model would otherwise attach one digest per
 *  entity; the first few say the same thing as the hundredth. */
export const TRACE_REPLY_DIGESTS = 5;
/** Validation issues quoted when the retry fires. */
const TRACE_ISSUE_LINES = 8;
/** Matches `TRACE_VALUE_CHARS` — a traced URL is a traced value. */
const TRACE_URL_CHARS = 200;

/**
 * What the model replied, capped, for a call that misbehaved. `keys` is the
 * load-bearing half: a reply that answered under `nombre` instead of the site
 * id reads downstream as "extracted nothing", and nothing short of the keys it
 * DID answer under can tell those two apart.
 *
 * Attached only on an anomaly. A healthy reply is third-party content the run
 * record has no business storing, and the emitted entities already describe it.
 *
 * The sample is the HEAD of the body — the shape the model chose and the first
 * entity or two — except when the rejection named a place: a validation failure
 * at `entry.45.sourced_by` is unreadable from the head of a fifty-entity reply,
 * so the offending entity takes the sample's place (`focus`).
 */
export function replyDigest(
  reply: LlmCallResult | undefined,
  why: Array<'no_entities' | 'dropped_records' | 'retried' | 'failed'>,
  focus?: OffendingEntity,
): { why: typeof why; keys: string[]; sample: string; path?: string } | undefined {
  if (!reply || why.length === 0) return undefined;
  const parsed = reply.parsedJson;
  const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed) : [];
  const body = focus ? safeStringify(focus.entity) : (reply.rawText ?? safeStringify(parsed));
  return {
    why,
    keys: keys.slice(0, TRACE_INPUT_PARTS),
    sample: body.length > TRACE_REPLY_CHARS ? `${body.slice(0, TRACE_REPLY_CHARS)}…` : body,
    ...(focus ? { path: focus.at } : {}),
  };
}

/** The record a rejection pointed at, and where in the reply it sat. */
interface OffendingEntity {
  at: string;
  entity: Record<string, unknown>;
}

/**
 * The ENTITY a validation issue landed inside, found by walking the issue's own
 * path into the reply.
 *
 * "Entity" is read off the path rather than off the schema: an extraction reply
 * is lists of records, so the deepest object reached through an ARRAY INDEX is
 * the record the complaint is about — `entry.45` for a complaint about
 * `entry.45.sourced_by.evidence`. The walk stops early wherever the path leads
 * nowhere (the missing-key case), keeping the last record it did reach.
 */
function offendingEntity(
  reply: unknown,
  path: ReadonlyArray<PropertyKey>,
): OffendingEntity | undefined {
  let node: unknown = reply;
  let found: OffendingEntity | undefined;
  const walked: PropertyKey[] = [];
  for (const step of path) {
    const next = Array.isArray(node)
      ? node[Number(step)]
      : isPlainRecord(node)
        ? node[String(step)]
        : undefined;
    if (next === undefined) break;
    node = next;
    walked.push(step);
    if (typeof step === 'number' && isPlainRecord(node)) {
      found = { at: walked.map(String).join('.'), entity: node };
    }
  }
  return found;
}

/**
 * Where one branch of the walk records what it did.
 *
 * The planner runs independent branches at once, but the trace is READ as a
 * story in walk order — the question it answers is "which of these two sibling
 * calls read the short prompt", and that is unanswerable if their entries are
 * shuffled together by whichever fetch happened to land first. So a branch
 * writes into a slice of its own and its parent splices the slices back in
 * DECLARATION order once the fan is done: the sequence a reader sees is the
 * serial walk's, whatever overlapped. The cost is that a fan's entries appear
 * all at once at the end of the fan rather than as they happen, which a live
 * reader of an in-flight run's trace will notice.
 *
 * The reply-digest budget is the RUN's, so it rides a counter shared down the
 * whole tree rather than being counted back off a slice that only ever holds
 * part of the story.
 */
class TraceSink {
  private constructor(
    /** The run's trace, or absent when the run keeps none. */
    private readonly entries: MovementTraceEntry[] | undefined,
    private readonly digests: { kept: number },
  ) {}

  /** The sink the whole extract records into — the run's own trace, with the
   *  digests EARLIER statements already kept counted against the budget. */
  static root(trace: MovementTraceEntry[] | undefined): TraceSink {
    let kept = 0;
    for (const entry of trace ?? []) {
      if (entry.kind === 'extraction' && entry.reply) kept++;
    }
    return new TraceSink(trace, { kept });
  }

  push(entry: MovementTraceEntry): void {
    if (!this.entries) return;
    if (entry.kind === 'extraction' && entry.reply) this.digests.kept++;
    this.entries.push(entry);
  }

  /** A slice for one branch of a fan, spliced back by `absorb`. */
  branch(): TraceSink {
    return new TraceSink(this.entries && [], this.digests);
  }

  /** Splice finished branches in, in the order they were written. Called even
   *  when the fan raised: a run that failed mid-fan is exactly when what the
   *  branches got through is worth reading. */
  absorb(branches: TraceSink[]): void {
    if (!this.entries) return;
    for (const branch of branches) this.entries.push(...(branch.entries ?? []));
  }

  /** Whether this run has already kept its share of reply digests. */
  digestBudgetSpent(): boolean {
    return this.entries === undefined || this.digests.kept >= TRACE_REPLY_DIGESTS;
  }
}

/**
 * How much of the walk runs at once, per fan. What the planner overlaps is
 * independent by construction — a stage's plugins do not read each other, and
 * sibling entities each read only their own fields — so the ceiling that
 * matters is the one OUTSIDE: the scrape queue takes ten fetches in flight,
 * the search API has a daily quota, and the model client holds its own
 * eight-wide gate. Four is what keeps a message naming twenty people from
 * turning one run into a burst against all three at once.
 *
 * The cap is per FAN, not per run: a fan of entities each running a fan of
 * plugins can have more than four things in the air. That is deliberate — one
 * global gate would have a parent queueing behind its own children — and the
 * external limits above are what actually bound the total.
 */
export const STAGE_FAN_OUT = 4;


// The `resolveFileText` seam's own vocabulary lives beside the trace shape it
// feeds (./expression.ts) — `READ(file)` reads files through the same seam, so
// neither caller owns the types. Re-exported here because this module is where
// the seam was introduced and where its importers still name it.
export {
  isFileUnreadable,
  type FileTextResolution,
  type FileTextResult,
  type FileUnreadable,
} from './expression';

export interface ExtractRuntime {
  llm: LlmClient;
  transformInvoker: MovementTransformInvoker;
  /** The plugins the run's catalog snapshot describes: what a stage feeds a
   *  plugin from the extract source (its `fedArgs`) and which arguments it
   *  must be handed (its `requiredArgs`). */
  plugins: PluginSpecs;
  /** Evaluates an expression slot in the interpreter's current scope —
   *  `from` data and non-field plugin arguments resolve through this.
   *  Returns the value WITH its trail (E4): the `from` slots' origins
   *  become the extraction sites' data sources. */
  evalSlot: (slot: ExprSlot) => Promise<{ value: unknown; provenance: Provenance }>;
  /**
   * Materialise a source `FileRef` (an attachment) to its extracted TEXT —
   * the knowledge-pipeline parity path: resolve the owner adapter's bytes,
   * run the OCR/text extractor (scanned PDFs included), and dedup-store via
   * RawText. An unsupported type, unreachable bytes, a failed extractor or an
   * empty extraction come back as a `FileUnreadable` reason rather than a bare
   * absence: the file contributes no prompt segment either way, but the run can
   * then say WHICH file it could not read and why. Absent on the runtime →
   * files fall through to the legacy stringifying behaviour (no engine in the
   * path can resolve them). */
  resolveFileText?: (ref: FileRef) => Promise<FileTextResolution>;
  /** The run's observability trace — extraction calls record their
   *  input size and per-alias yields (and the silent empty-source skip,
   *  which otherwise looks identical to "extracted nothing"). */
  trace?: MovementTraceEntry[];
  /** The run this extraction is a statement of: its pin, its cancel gate,
   *  its id for log lines. Absent ⇒ outside a run (a script, a test): the
   *  current version, nothing to cancel. */
  run?: RunFacts;
}

// ── Materialisation ─────────────────────────────────────────────────────────

interface Segment {
  classification: string;
  content: string;
}

/**
 * How much of ONE source file's text may reach the extraction prompt. Fifty
 * thousand characters is the figure `fetch_url` already bounds a fetched page
 * at, and it takes a twenty-page deck whole; past it a single lookbook crowds
 * every other source out of the prompt — and is re-sent on EVERY staged call of
 * the extract, so the cost is per call, not per run. Read per call so a
 * deployment can raise it without a deploy.
 */
function maxFileChars(): number {
  const fromEnv = Number(process.env.EXTRACTION_FILE_CHARS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 50_000;
}

/** A source file's text as the PROMPT sees it. `chars` is how much of the
 *  file's own text went in; the marker the model reads is extra. */
export interface BoundedFileText {
  content: string;
  chars: number;
  truncatedFrom?: number;
}

/** Bound one file's text for the prompt, visibly: the model is TOLD it was
 *  handed a prefix, so it answers about what it read instead of treating a
 *  sentence cut mid-word as the end of the document. The stored copy
 *  (`rawTextId`) and the carry-forward FILE resource keep the whole text —
 *  only the prompt is bounded. */
export function boundFileText(input: { text: string; ref: FileRef; run?: RunFacts }): BoundedFileText {
  const { text, ref } = input;
  const ceiling = maxFileChars();
  if (text.length <= ceiling) return { content: text, chars: text.length };
  logger.warn('[movement:extract] truncating a source file for the prompt', {
    name: ref.name,
    chars: ceiling,
    of: text.length,
    ...runLogFields(input.run),
  });
  return {
    content: `${text.slice(0, ceiling)}\n[… truncated: first ${ceiling} of ${text.length} characters]`,
    chars: ceiling,
    truncatedFrom: text.length,
  };
}

/** A resolved source `FileRef`'s Layer-5 contribution: the FILE `Resource`
 *  (always — carry-forward provenance) plus, when OCR yielded text, the
 *  extraction `text` (the segment the AI extracts from + its evidence origin).
 *  `traced` is the same resolution as the run's trace tells it: what the file
 *  contributed, or why it contributed nothing. */
interface FileResolution {
  resource: Resource;
  text?: { segment: Segment; origin: ProvenanceOrigin };
  traced: ExtractionTraceFile;
}

/** One site of a planned LLM call: a (node, stage) plus the nested
 *  sites batched into the same call (through-free descendants). */
interface CallSite {
  siteId: string;
  spec: ExtractNodeSpec;
  stageIndex: number;
  /** Exactly-one-entity semantics (the root; per-entity continuations). */
  single: boolean;
  /** The interned provenance ref every origin of this call shares —
   *  `dataSources` is stamped when the call is issued (the region is
   *  built immediately before its one call). */
  ref: ExtractSiteRef;
  children: CallSite[];
}

/** What one region's LLM call turned out to be, filled in as it happens.
 *  A pure observation channel: nothing here changes what the call does, and
 *  it exists so a call that ended by THROWING can still be described — the
 *  raise is the only moment the unanswered reply is still in hand. */
interface CallTelemetry {
  model: TierModel;
  /** Wall clock across every attempt, so a retried call reads as the two
   *  calls it actually was. */
  durationMs?: number;
  /** The most recent attempt's reply — the first, or the retry's if it ran. */
  lastReply?: LlmCallResult;
  /** The validation issues that triggered the retry; absent = no retry. */
  retried?: string[];
}

/** Mutable per-entity state while phases run. `context` accumulates
 *  every stage's fields (working included); export filters at the end. */
interface WorkingEmission {
  spec: ExtractNodeSpec;
  stageIndex: number;
  context: Record<string, unknown>;
  /** Per-field extraction origins, accumulated alongside `context`. */
  provenance: Record<string, ProvenanceOrigin>;
  /** The entity's site-level origin (absent for the no-emission root
   *  fallback). */
  origin?: ProvenanceOrigin;
  /** The files this entity's own `through` stages fetched, as FILE resources.
   *  They join the extract's source resources on this record and every record
   *  beneath it (see `exportEmission`). */
  resources?: Resource[];
  children: Map<string, WorkingEmission[]>;
}

/** What one branch of the fence walk carries. The source segments and the
 *  bundle-level provenance belong to the extract and are the same for every
 *  entity in it; the ancestor fields and the trace slice are this branch's
 *  own. */
interface FenceWalk {
  segments: Segment[];
  baseSources: ProvenanceOrigin[];
  ancestorContext: Record<string, unknown>;
  trace: TraceSink;
}

/** Outside a run (a script, a test calling the extraction directly) no host
 *  mints ids: resources are numbered within the process instead. */
let mintedOutsideARun = 0;
const OUTSIDE_A_RUN_IDS: IdMint = {
  mint: async (count) => Array.from({ length: count }, () => `local-${++mintedOutsideARun}`),
};

export async function materializeExtract(input: {
  extract: ExtractExpression;
  /** The resolved spec (`buildExtractSpec`, annotations resolved live). */
  spec: ExtractNodeSpec;
  runtime: ExtractRuntime;
}): Promise<ExtractEmission> {
  const m = new Materializer(input.runtime);
  return m.run(input.extract, input.spec);
}

class Materializer {
  private siteCounter = 0;
  /** The extract's source text — what `from [...]` resolved to. Auto-fed to a
   *  plugin's `auto` params (e.g. vc_url_retrieval's `text`), so the author
   *  writes `through [vc_url_retrieval]` with no argument. */
  private sourceText = '';
  /** The extraction's tier, as its author wrote it. Statement-level: every
   *  call this materialiser makes, at every stage, asks for the same thing. */
  private tier: string | undefined;
  /** Per-extract file-text memo, keyed by the file's owner handle (or name):
   *  the same attachment listed twice is resolved once. A `null` entry records
   *  an unsupported/empty file so it isn't retried. */
  private readonly fileTextCache = new Map<string, FileResolution | null>();
  /** Every source file this extract's `from [ … ]` resolved to, as the trace
   *  tells it. It rides every call's shape for the reason `inputs` does: which
   *  call read the attachment — and which read nothing because nothing could
   *  read it — is only answerable if each entry says so itself. */
  private sourceFiles: ExtractionTraceFile[] = [];

  constructor(private readonly runtime: ExtractRuntime) {}

  private get languageVersion(): LanguageVersion {
    return languageVersionOf(this.runtime.run);
  }

  /** Each resource with no id, given one: in a run, by the host
   *  (`ids.mint`), all of them in one request. */
  private stamp(resources: readonly Resource[]): Promise<Resource[]> {
    return stampResourceIds(resources, (count) => (this.runtime.run?.ids ?? OUTSIDE_A_RUN_IDS).mint(count));
  }

  private async stampOne(resource: Resource): Promise<Resource> {
    const [stamped] = await this.stamp([resource]);
    return stamped ?? resource;
  }

  /** The files a stage's plugins fetched, joined onto the record they ran for. */
  private async addResources(
    emission: WorkingEmission,
    enrichments: Array<{ plugin: string; result: TransformInvocationResult }>,
  ): Promise<void> {
    const fetched = enrichments.flatMap(({ result }) => pluginFileResources(result, this.languageVersion));
    if (fetched.length === 0) return;
    emission.resources = [...(emission.resources ?? []), ...(await this.stamp(fetched))];
  }

  async run(extract: ExtractExpression, spec: ExtractNodeSpec): Promise<ExtractEmission> {
    this.tier = extract.tier;
    const trace = TraceSink.root(this.runtime.trace);
    const fromData = await this.resolveFromData(extract.from);
    this.sourceFiles = fromData.files;
    let segments = fromData.segments;
    this.sourceText = fromData.segments.map((s) => s.content).join('\n\n');
    // The data sources every call of this extract sees — the `from`
    // slots' own origins, extended per stage with the `through`
    // enrichments in context (provenance precision falls out of the
    // staging semantics).
    const baseSources = [...fromData.sources];

    // The root's first-stage `through` is the `from [...] through [...]`
    // DATA pipeline — it runs once, on the bundle, before any extraction
    // (the knowledge pipeline's pre-extraction transforms).
    // The plugins of one pipeline are independent of each other — none reads
    // what another brought back — so they go off together and are READ in the
    // order they were written, which is the order their content joins the
    // source text and the order their origins join the provenance.
    const fromPipeline = spec.stages[0]?.through ?? [];
    const fromBranches = fromPipeline.map(() => trace.branch());
    // The files the bundle-level stage fetched belong to the extract exactly as
    // its `from` sources do: every record it produces carries them.
    const pipelineResources: Resource[] = [];
    try {
      const results = await mapConcurrent(fromPipeline, STAGE_FAN_OUT, async (plugin, i) => {
        // The same boundary the per-entity pipeline keeps (see `runPipeline`):
        // a bundle-level fetch is as long as any other, and an operator's
        // cancel must not wait for the whole fan before it means anything.
        await throwIfCancelled(this.runtime.run);
        return this.invokePlugin(plugin, {}, spec.name, fromBranches[i]);
      });
      fromPipeline.forEach((plugin, i) => {
        const result = results[i];
        // A root-stage plugin has no extracted fields to draw a required
        // argument from, so an empty one skips here for the same reason it
        // skips per entity: nothing to work on, so nothing runs.
        if (result === SKIPPED) return;
        segments = segments.concat(transformResultSegments(plugin.plugin, result));
        baseSources.push({ kind: 'enrichment', plugin: plugin.plugin });
        pipelineResources.push(...pluginFileResources(result, this.languageVersion));
      });
      pipelineResources.splice(0, pipelineResources.length, ...(await this.stamp(pipelineResources)));
    } finally {
      trace.absorb(fromBranches);
    }

    const region = this.buildRegion(spec, 0, true, { skipOwnThrough: true });
    const emissions = await this.extractRegion(region, segments, undefined, baseSources, trace);
    const root: WorkingEmission =
      emissions[0] ??
      ({
        spec,
        stageIndex: 0,
        context: {},
        provenance: {},
        children: new Map(),
      } satisfies WorkingEmission);
    await this.resolveFences(root, { segments, baseSources, ancestorContext: {}, trace });
    return exportEmission(root, {
      inherited: [...fromData.resources, ...pipelineResources],
      languageVersion: this.languageVersion,
    });
  }

  // ── `from` data → segments ──

  private async resolveFromData(slots: ExprSlot[]): Promise<{
    segments: Segment[];
    sources: ProvenanceOrigin[];
    resources: Resource[];
    files: ExtractionTraceFile[];
  }> {
    const segments: Segment[] = [];
    const sources: ProvenanceOrigin[] = [];
    // The source content as resources (Layer 5 provenance) — one FILE resource
    // per source `FileRef` (descriptor kept), one TEXT resource per text
    // datum. This is what an extracted node attaches to `WriteInput.resources`
    // and what `extractedNode-[:_resources]->` walks.
    const resources: Resource[] = [];
    // Every source file, readable or not — a file that yielded nothing still
    // has to appear on the run, or the extraction reads as "no source at all".
    const files: ExtractionTraceFile[] = [];
    const seen = new Set<ProvenanceOrigin>();
    // FILE resources dedupe on their stable engine-stamped id (the file-text
    // memo returns the same resource by identity for a repeated attachment).
    const seenResourceIds = new Set<string>();
    for (const slot of slots) {
      const { value, provenance } = await this.runtime.evalSlot(slot);
      for (const origin of provenance.origins) {
        if (seen.has(origin)) continue;
        seen.add(origin);
        sources.push(origin);
      }
      const flat = value == null ? [] : Array.isArray(value) ? value : [value];
      for (const datum of flat) {
        if (datum == null) continue;
        if (isFileRef(datum)) {
          // No resolver in the path → legacy fall-through (stringify). With a
          // resolver, a source file ALWAYS becomes a FILE resource (carry-forward
          // provenance — a file qualifies by being a source, not by yielding
          // text); its extraction TEXT segment + `file` evidence origin are added
          // ONLY when OCR yields non-empty text.
          if (this.runtime.resolveFileText) {
            const file = await this.fileSegment(datum);
            if (!file) continue; // unsupported (no FileRef bytes) — skip cleanly
            // The FILE resource is the source artifact — deduped on its stable
            // engine-stamped id (the memo returns the same resource by identity,
            // so the same attachment listed twice contributes ONE resource).
            if (file.resource.id !== undefined && !seenResourceIds.has(file.resource.id)) {
              seenResourceIds.add(file.resource.id);
              resources.push(file.resource);
              files.push(file.traced);
            }
            // The extraction text is OCR-gated: only a non-empty result yields a
            // segment + evidence origin (deduped by origin identity).
            if (file.text && !seen.has(file.text.origin)) {
              seen.add(file.text.origin);
              segments.push(file.text.segment);
              sources.push(file.text.origin);
            }
            continue;
          }
        }
        segments.push(segmentForDatum(datum));
        const textResource = textResourceForDatum(datum);
        if (textResource) resources.push(textResource);
      }
    }
    return { segments, sources, resources: await this.stamp(resources), files };
  }

  /**
   * Resolve a source `FileRef` to its Layer-5 contribution. The FILE `Resource`
   * (carrying the SAME `FileRef` — the descriptor kept so a
   * downstream write carries the file forward) is built ALWAYS: a source file
   * qualifies as provenance by being a source, not by yielding text. The
   * extraction `text` (a `FILE` segment + a `file` evidence origin, the thing the
   * AI extracts FROM) is built ONLY when OCR yields non-empty text — a scanned
   * image with no extractable text contributes a carry-forward resource but no
   * extraction segment/evidence. Memoised per owner handle: the same attachment
   * listed twice resolves once. Returns `undefined` only when there is no
   * resolver or the type carries no FileRef bytes — the caller then skips it.
   */
  private async fileSegment(ref: FileRef): Promise<FileResolution | undefined> {
    if (!this.runtime.resolveFileText) return undefined;
    const handle = fileHandle(ref);
    const cacheKey = handle ?? ref.name;
    if (cacheKey !== undefined) {
      const cached = this.fileTextCache.get(cacheKey);
      if (cached !== undefined) return cached ?? undefined;
    }
    const result = await this.runtime.resolveFileText(ref);
    const read = isFileUnreadable(result) ? undefined : result;
    const bounded =
      read && read.text.trim().length > 0 ? boundFileText({ text: read.text, ref, run: this.runtime.run }) : undefined;
    const text =
      read && bounded
        ? {
            segment: { classification: 'FILE', content: bounded.content } satisfies Segment,
            origin: {
              kind: 'file',
              ...(read.rawTextId !== undefined ? { rawTextId: read.rawTextId } : {}),
              ...(handle !== undefined ? { handle } : {}),
              ...(ref.name !== undefined ? { name: ref.name } : {}),
              ...(ref.contentType !== undefined ? { contentType: ref.contentType } : {}),
            } satisfies ProvenanceOrigin,
          }
        : undefined;
    const named = {
      ...(ref.name !== undefined ? { name: ref.name } : {}),
      ...(ref.contentType !== undefined ? { contentType: ref.contentType } : {}),
    };
    const resolution: FileResolution = {
      resource: await this.stampOne(fileResourceForRef(ref, read)),
      ...(text !== undefined ? { text } : {}),
      traced: isFileUnreadable(result)
        ? {
            ...named,
            unreadable: result.unreadable,
            ...(result.detail !== undefined ? { detail: result.detail } : {}),
          }
        : bounded
          ? {
              ...named,
              chars: bounded.chars,
              ...(bounded.truncatedFrom !== undefined
                ? { truncatedFrom: bounded.truncatedFrom }
                : {}),
            }
          : { ...named, unreadable: 'no_text' },
    };
    if (cacheKey !== undefined) this.fileTextCache.set(cacheKey, resolution);
    return resolution;
  }

  // ── Phase planning ──
  //
  // A region is the largest through-free subtree rooted at (spec,
  // stage): the stage's own fields plus, recursively, every child whose
  // first stage is unfenced. Fenced edges (a node's next stage; a child
  // whose stage 0 declares a pipeline) become per-entity continuations.

  private buildRegion(
    spec: ExtractNodeSpec,
    stageIndex: number,
    single: boolean,
    options?: { skipOwnThrough?: boolean },
  ): CallSite {
    const stage = spec.stages[stageIndex];
    if (!options?.skipOwnThrough && stageIndex === 0 && stage.through.length > 0) {
      // Handled by the caller (fenced child); defensive.
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `internal: region rooted at a fenced stage of '${spec.name}'`,
      );
    }
    const siteId = `x:${sanitizeSiteName(spec.name)}#${++this.siteCounter}`;
    return {
      siteId,
      spec,
      stageIndex,
      single,
      // One interned ref per call site — every emission's field origins
      // share it by reference. `dataSources` is filled when the call is
      // issued (`extractRegion`), once the stage's enrichments are known.
      ref: {
        siteId,
        node: spec.name,
        description: spec.description,
        stage: stageIndex,
        dataSources: [],
      },
      children: stage.children
        .filter((c) => (c.stages[0]?.through ?? []).length === 0)
        .map((c) => this.buildRegion(c, 0, false)),
    };
  }

  /** Stamp the call's data-source context onto every site ref the
   *  region batches — through-free descendants extract in the same
   *  call, so they share the same context. */
  private stampDataSources(site: CallSite, sources: ProvenanceOrigin[]): void {
    site.ref.dataSources = sources;
    for (const child of site.children) this.stampDataSources(child, sources);
  }

  private fencedChildren(spec: ExtractNodeSpec, stageIndex: number): ExtractNodeSpec[] {
    return spec.stages[stageIndex].children.filter((c) => (c.stages[0]?.through ?? []).length > 0);
  }

  // ── One LLM call per region ──

  private async extractRegion(
    region: CallSite,
    segments: Segment[],
    entity:
      | {
          spec: ExtractNodeSpec;
          context: Record<string, unknown>;
          enrichments: Array<{ plugin: string; result: TransformInvocationResult }>;
        }
      | undefined,
    sources: ProvenanceOrigin[],
    trace: TraceSink,
  ): Promise<WorkingEmission[]> {
    this.stampDataSources(region, sources);
    const { text: userMessage, parts } = renderUserMessage(segments, entity);
    // The input shape rides EVERY entry of this call, healthy or not: which
    // of two sibling calls read the short prompt is only answerable if the
    // healthy one recorded its shape too.
    const shape = {
      node: region.spec.name,
      inputChars: userMessage.length,
      ...(parts.length > 0 ? { inputs: parts.slice(0, TRACE_INPUT_PARTS) } : {}),
      ...(parts.length > TRACE_INPUT_PARTS
        ? { inputsTruncated: parts.length - TRACE_INPUT_PARTS }
        : {}),
      ...(this.sourceFiles.length > 0
        ? { files: this.sourceFiles.slice(0, TRACE_INPUT_PARTS) }
        : {}),
      ...(this.sourceFiles.length > TRACE_INPUT_PARTS
        ? { filesTruncated: this.sourceFiles.length - TRACE_INPUT_PARTS }
        : {}),
    };
    if (userMessage.trim().length === 0) {
      // The silent skip that hides empty source fields — record it so
      // the run can say "extraction saw no text" instead of nothing.
      trace.push({
        kind: 'extraction',
        ...shape,
        skipped: 'empty_source',
        emissions: { [region.spec.name]: 0 },
      });
      return [];
    }

    const coercions = new CoercionTracker();
    const schema = responseSchemaFor(region, coercions);
    const system = buildSystemPrompt(region);
    // The extraction's tier, resolved once per call: it is the whole
    // extraction's, so every stage and every fence asks for the same thing.
    // With no tier the density heuristic still picks the model, exactly as it
    // did before tiers existed.
    const settings = extractionCallSettings({ tier: this.tier, densityModel: selectModel(countSites(region)) });
    const telemetry: CallTelemetry = { model: settings.model };
    let raw: unknown;
    try {
      raw = await this.callWithRetry({
        system,
        userMessage,
        label: 'movement_extraction',
        settings,
        schema,
        region,
        coercions,
        telemetry,
      });
    } catch (error) {
      // The reply never answered the question, twice — and what that costs
      // depends on what the call was for.
      //
      // A PER-ENTITY call is an increment on an entity that already stands: a
      // `through` refinement of it, or a fenced child of it. Losing the
      // increment costs that entity some fields; failing the run costs every
      // entity the extraction already got right, and a production run makes
      // 40-85 of these, so a per-call drift of a percent makes losing the run
      // the expected outcome. The entity is kept as its previous stage left it.
      //
      // Only a SHAPE rejection is absorbed. A cancel, a truncated body or a
      // network failure means here exactly what it means anywhere else, and the
      // ROOT call has no previous stage to stand on — both stay fatal. Either
      // way the run has to say WHICH call failed and what came back instead, or
      // the next reader is back to archaeology.
      const kept = error instanceof z.ZodError ? entity?.enrichments : undefined;
      const raised = this.failedCall(region, shape, telemetry, error, trace, kept);
      if (kept) return [];
      throw raised;
    }

    const rawRecord = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const entities = Array.isArray(rawRecord[region.siteId])
      ? (rawRecord[region.siteId] as unknown[])
      : [];
    const projected = entities
      .filter((e): e is Record<string, unknown> => e != null && typeof e === 'object')
      .map((e) => projectEmission(e, region));
    const empty: Record<string, number> = {};
    countEmptyEmissions(projected, empty);
    const dropped: Record<string, number> = {};
    const kept = dropEmptyEmissions(projected, dropped);
    const coerced = coercions.snapshot();
    const evidenceCoerced = coercions.evidenceSnapshot();
    const envelopeRepaired = coercions.envelopeSnapshot();
    const why: Array<'no_entities' | 'dropped_records' | 'retried'> = [];
    if (entities.length === 0) why.push('no_entities');
    if (Object.keys(dropped).length > 0) why.push('dropped_records');
    if (telemetry.retried) why.push('retried');
    trace.push({
      kind: 'extraction',
      ...shape,
      emissions: { [region.spec.name]: entities.length },
      ...this.outcome(telemetry, { why, trace, shape }),
      ...(Object.keys(empty).length > 0 ? { empty } : {}),
      ...(Object.keys(dropped).length > 0 ? { dropped } : {}),
      ...(coerced ? { coerced } : {}),
      ...(evidenceCoerced ? { evidenceCoerced } : {}),
      ...(envelopeRepaired ? { envelopeRepaired } : {}),
    });
    return kept;
  }

  /** The half of an extraction trace entry that describes the CALL rather
   *  than its yield — and, when the call misbehaved and the run's digest
   *  budget still has room, what the model actually replied. */
  private outcome(
    telemetry: CallTelemetry,
    opts: {
      why: Array<'no_entities' | 'dropped_records' | 'retried' | 'failed'>;
      trace: TraceSink;
      /** What this call READ — named in the continuation warning, because a
       *  continued answer is a statement about the size of its input. */
      shape: { node: string; inputChars: number };
      focus?: OffendingEntity;
    },
  ): Partial<Extract<MovementTraceEntry, { kind: 'extraction' }>> {
    const digest = opts.trace.digestBudgetSpent()
      ? undefined
      : replyDigest(telemetry.lastReply, opts.why, opts.focus);
    const continuations = telemetry.lastReply?.continuations ?? 0;
    if (continuations > 0) this.warnContinued(continuations, opts.shape);
    return {
      model: telemetry.model,
      ...(telemetry.lastReply?.effortSteppedDown
        ? { effortSteppedDown: telemetry.lastReply.effortSteppedDown }
        : {}),
      // A continued answer is the one boundary fact that used to leave NO mark
      // on the run: the stitched text parses, every field the model never
      // reached is optional, and the records at the end of the input go
      // missing in silence. It is on the entry so that a reader who asks why
      // the last fifteen items of a transcript are not there can be answered.
      ...(continuations > 0 ? { continued: true as const, continuations } : {}),
      ...(telemetry.durationMs !== undefined ? { durationMs: telemetry.durationMs } : {}),
      ...(telemetry.retried ? { retried: telemetry.retried } : {}),
      ...(digest ? { reply: digest } : {}),
    };
  }

  /** The run's own account of a continued answer. The trace reaches whoever
   *  opens the firing; this reaches whoever is reading the logs when an
   *  extraction starts losing the end of what it read. */
  private warnContinued(
    continuations: number,
    shape: { node: string; inputChars: number },
  ): void {
    logger.warn(
      '[movement:extract] the answer ran past its output ceiling and was continued — records near the end of the input may be missing; cut the input into pieces',
      {
        node: shape.node,
        inputChars: shape.inputChars,
        continuations,
        ...runLogFields(this.runtime.run),
      },
    );
  }

  /**
   * Record the failing call on the trace (the digest is the whole point — the
   * entry is the only place the unanswered reply survives), then name it in
   * the error the run fails with.
   *
   * ONLY the schema rejection is renamed. Everything else a call can die of —
   * a cancel, a truncated body, the network — already describes itself, and
   * relabelling one of those as "the model answered wrongly" would send the
   * next reader after the wrong thing entirely.
   *
   * The error is returned rather than thrown because the caller decides
   * whether it is raised: a per-entity call keeps its entity and drops the
   * error on the floor (`kept`), and only the root call fails the run.
   */
  private failedCall(
    region: CallSite,
    shape: { node: string; inputChars: number },
    telemetry: CallTelemetry,
    cause: unknown,
    trace: TraceSink,
    /** Present when the caller is KEEPING the entity this call was refining
     *  rather than failing the run: the stage's enrichments, which were folded
     *  into the failed call's prompt and go over the side with it. */
    kept?: Array<{ plugin: string; result: TransformInvocationResult }>,
  ): unknown {
    if (!(cause instanceof z.ZodError)) return cause;
    // The head of a fifty-entity reply says nothing about a complaint against
    // the forty-fifth, and the head is all the trace used to keep.
    const focus = offendingEntity(telemetry.lastReply?.parsedJson, cause.issues[0]?.path ?? []);
    trace.push({
      kind: 'extraction',
      ...shape,
      emissions: { [region.spec.name]: 0 },
      failed: 'invalid_reply',
      ...(kept ? { fallback: 'kept_previous_stage' as const } : {}),
      // What this stage fetched for the entity and never got to use: the
      // enrichment is what the failed call was FOR, so a reader who sees a
      // seven-minute plugin above this entry has to be told it bought nothing.
      ...(kept && kept.length > 0
        ? { plugins: kept.map((e) => ({ plugin: e.plugin, outcome: 'dropped' as const })) }
        : {}),
      ...this.outcome(telemetry, { why: ['failed'], trace, shape, focus }),
    });
    if (kept) {
      logger.warn(
        '[movement:extract] a per-entity call was answered with something the guide does not describe — keeping the entity as its previous stage left it',
        {
          node: region.spec.name,
          site: region.siteId,
          stage: region.stageIndex,
          droppedEnrichments: kept.map((e) => e.plugin),
          ...runLogFields(this.runtime.run),
        },
      );
      return cause;
    }
    const answered = telemetry.lastReply?.parsedJson;
    const keys = answered && typeof answered === 'object' ? Object.keys(answered) : [];
    // Two different failures reach here, and naming the wrong one sends the
    // next reader after the wrong thing: the reply never used the answer key at
    // all, or it used the key and then wrote something inside it the guide does
    // not describe (an entity answered under keys nothing declared, say).
    const detail = keys.includes(region.siteId)
      ? `The reply answered under \`${region.siteId}\`, but ${firstIssue(cause)}. `
      : keys.length > 0
        ? `The reply came back under ${quoteKeys(keys)}, not \`${region.siteId}\`. `
        : 'The reply carried nothing the schema could read. ';
    return new MovementEngineError(
      'MOVENG_RUNTIME',
      `The extraction of \`${region.spec.name}\` (${region.siteId}) was answered with something the guide does not describe, twice. ` +
        detail +
        (focus
          ? `The run's trace holds the entity at \`${focus.at}\`.`
          : `The run's trace holds the first ${TRACE_REPLY_CHARS} characters of it.`),
      cause,
    );
  }

  private async callWithRetry(opts: {
    system: string;
    userMessage: string;
    label: string;
    /** What the extraction's tier asks the platform for — the same on the
     *  retry, which is the same question asked again. */
    settings: ExtractionCallSettings;
    schema: z.ZodTypeAny;
    /** What the call is asking about — the retry needs its answer key and its
     *  field names to be able to show the envelope it wants back. */
    region: CallSite;
    coercions: CoercionTracker;
    /** Filled in as the call proceeds, so the caller can describe an attempt
     *  that ended by throwing as readily as one that returned. */
    telemetry: CallTelemetry;
  }): Promise<unknown> {
    // The extraction's OWN call boundary. The Anthropic client seam checks too
    // — it has to, because `AI()` reaches an LLM without coming through here —
    // but that seam belongs to whichever client is wired, and the recursion
    // this method drives (one call per region, then one per entity per stage)
    // is the extraction's to gate. Both share the one debounced read.
    await throwIfCancelled(this.runtime.run);
    const elapsed = await stopwatch(this.runtime.run?.clock);
    const first = await this.runtime.llm.call({
      system: opts.system,
      userMessage: opts.userMessage,
      label: opts.label,
      ...opts.settings,
    });
    opts.telemetry.lastReply = first;
    opts.telemetry.durationMs = await elapsed();
    // The schema tree (and its closures) is built once and reused across
    // both attempts — reset so a successful retry doesn't inherit the first
    // attempt's coercion diagnostics.
    opts.coercions.reset();
    const parsed = opts.schema.safeParse(first.parsedJson);
    if (parsed.success) return parsed.data;

    // Same validate-then-retry-once loop as the TG batcher's phases.
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    const issues = lines.join('\n');
    // The issues are what the retry was ASKED to fix — the most direct
    // statement there is of how the first reply missed.
    opts.telemetry.retried = lines.slice(0, TRACE_ISSUE_LINES);
    const retry = await this.runtime.llm.call({
      system: opts.system,
      userMessage: `${opts.userMessage}\n\n---\n\nYour previous response had validation errors:\n${issues}\n\n${retryInstruction(opts.region, parsed.error.issues)}`,
      label: `${opts.label}_retry`,
      ...opts.settings,
    });
    opts.telemetry.lastReply = retry;
    opts.telemetry.durationMs = await elapsed();
    opts.coercions.reset();
    return opts.schema.parse(retry.parsedJson);
  }

  // ── Fences: per-entity pipelines + continuation calls ──

  private async resolveFences(emission: WorkingEmission, walk: FenceWalk): Promise<void> {
    const { spec } = emission;
    const { segments, baseSources, ancestorContext, trace } = walk;

    // The node's own next stage (fenced behind its `through`). The plugin
    // sees the node's own fields bare, plus its ancestors' fields (a
    // person nested in a company gets `company_name`, so an enrichment
    // like linkedin can search by person + company).
    while (emission.stageIndex + 1 < spec.stages.length) {
      const nextIndex = emission.stageIndex + 1;
      const nextStage = spec.stages[nextIndex];
      const enrichments = await this.runPipeline(
        nextStage.through,
        { ...ancestorContext, ...emission.context },
        spec.name,
        trace,
      );
      // A fetched file is this record's source whether or not the stage goes on
      // to read anything — a deck with no readable text still carries forward.
      await this.addResources(emission, enrichments);
      // A stage fenced behind plugins that all came back with nothing has
      // nothing new for this entity to be read from: the prompt would carry
      // the same source text and the same fields the previous stage already
      // extracted from, so the model correctly answers with nothing (50 of
      // one production run's 53 continuation calls were exactly this). The
      // stage's fields join the entity absent — which is what the call
      // produced anyway — and the stages after it still run on their own
      // merits. A stage that declares NO plugins is untouched: plugin-less
      // field staging is a legitimate shape, and it must never read as
      // "every plugin contributed nothing".
      if (nextStage.through.length > 0 && !hasEnrichmentContent(enrichments)) {
        this.notePointlessStage(nextStage.through, enrichments, spec.name, trace);
        emission.stageIndex = nextIndex;
        await this.resolveFencedChildren(emission, nextIndex, walk);
        continue;
      }
      const region = this.buildRegion(spec, nextIndex, true, { skipOwnThrough: true });
      const continued = await this.extractRegion(
        region,
        segments,
        { spec, context: emission.context, enrichments },
        stageSources(baseSources, enrichments),
        trace,
      );
      const next = continued[0];
      if (next) {
        emission.context = { ...emission.context, ...next.context };
        emission.provenance = { ...emission.provenance, ...next.provenance };
        for (const [name, children] of next.children) emission.children.set(name, children);
      }
      emission.stageIndex = nextIndex;

      // Fenced children declared in the just-extracted stage.
      await this.resolveFencedChildren(emission, nextIndex, walk);
    }

    // Fenced children of the stages already extracted in-region.
    for (let s = 0; s <= emission.stageIndex; s++) {
      await this.resolveFencedChildren(emission, s, walk);
    }

    // Recurse into every child emission, extending the ancestor context
    // with this node's own fields (namespaced by node name).
    //
    // Sibling entities share nothing but the source text — each one's stages
    // read its OWN fields and its own enrichments — so the walk over them is a
    // fan, not a queue. The chain inside each entity stays sequential: that is
    // the ordering the staging semantics actually depend on.
    const childAncestors = {
      ...ancestorContext,
      ...namespaceContext(spec.name, emission.context),
    };
    const children = [...emission.children.values()].flat();
    const branches = children.map(() => trace.branch());
    try {
      await mapConcurrent(children, STAGE_FAN_OUT, (child, i) =>
        this.resolveFences(child, {
          segments,
          baseSources,
          ancestorContext: childAncestors,
          trace: branches[i],
        }),
      );
    } finally {
      trace.absorb(branches);
    }
  }

  private async resolveFencedChildren(
    emission: WorkingEmission,
    stageIndex: number,
    walk: FenceWalk,
  ): Promise<void> {
    // A fenced child's stage-0 plugin runs before the child has any fields
    // of its own, so it sees the ancestor chain (this parent's fields
    // namespaced, plus the parent's own ancestors).
    const childAncestors = {
      ...walk.ancestorContext,
      ...namespaceContext(emission.spec.name, emission.context),
    };
    // Each fenced child is a different node of the tree, reading the same
    // parent — nothing one of them extracts is visible to another — so they
    // go off together. They are ATTACHED in declaration order once the fan is
    // done, so the map's key order is the author's, not the fetches'.
    const specs = this.fencedChildren(emission.spec, stageIndex).filter(
      (child) => !emission.children.has(child.name),
    );
    const branches = specs.map(() => walk.trace.branch());
    try {
      const extracted = await mapConcurrent(specs, STAGE_FAN_OUT, async (child, i) => {
        const enrichments = await this.runPipeline(
          child.stages[0].through,
          childAncestors,
          child.name,
          branches[i],
        );
        const region = this.buildRegion(child, 0, false, { skipOwnThrough: true });
        const children = await this.extractRegion(
          region,
          walk.segments,
          { spec: emission.spec, context: emission.context, enrichments },
          stageSources(walk.baseSources, enrichments),
          branches[i],
        );
        // The child's stage ran once for all of its records, so each carries
        // what it fetched.
        for (const extracted of children) await this.addResources(extracted, enrichments);
        return children;
      });
      specs.forEach((child, i) => emission.children.set(child.name, extracted[i]));
    } finally {
      walk.trace.absorb(branches);
    }
  }

  /** Record the call that wasn't made, with what each of the stage's plugins
   *  did for this entity — a reader has to be able to tell a stage skipped as
   *  pointless from one that never ran at all. `inputChars: 0` is the literal
   *  truth: nothing was read. */
  private notePointlessStage(
    pipeline: PluginCall[],
    enrichments: Array<{ plugin: string; result: TransformInvocationResult }>,
    node: string,
    trace: TraceSink,
  ): void {
    const ran = new Set(enrichments.map((e) => e.plugin));
    logger.info('[movement:extract] stage has no enrichment for this entity — skipping the call', {
      node,
      plugins: pipeline.map((p) => p.plugin),
      ...runLogFields(this.runtime.run),
    });
    trace.push({
      kind: 'extraction',
      node,
      inputChars: 0,
      skipped: 'no_enrichment',
      plugins: pipeline.map((p) => ({
        plugin: p.plugin,
        outcome: ran.has(p.plugin) ? ('empty' as const) : ('skipped' as const),
      })),
      emissions: { [node]: 0 },
    });
  }

  /** One stage's plugins, run together and answered in the order they were
   *  written: nothing in a pipeline reads what another of its plugins brought
   *  back, so the only thing the order decides is how the enrichments render
   *  and how they read on the trace — and that stays the author's. */
  private async runPipeline(
    pipeline: PluginCall[],
    context: Record<string, unknown>,
    node: string,
    trace: TraceSink,
  ): Promise<Array<{ plugin: string; result: TransformInvocationResult }>> {
    const branches = pipeline.map(() => trace.branch());
    try {
      const results = await mapConcurrent(pipeline, STAGE_FAN_OUT, async (plugin, i) => {
        // A retrieval plugin is the longest thing a statement does — a per-URL
        // fetch has a seven-minute backstop, and this pipeline runs once per
        // entity per stage. Checking before each launch is what keeps a cancel
        // from waiting on the whole fan of fetches: the ones already in flight
        // run to their own backstop, and nothing new starts. The check sits
        // OUTSIDE `invokePlugin`, whose invoker swallows everything the plugin
        // throws as "no enrichment" — the signal must not be able to land in
        // there.
        await throwIfCancelled(this.runtime.run);
        return this.invokePlugin(plugin, context, node, branches[i]);
      });
      return pipeline.flatMap((plugin, i) => {
        const result = results[i];
        return result === SKIPPED ? [] : [{ plugin: plugin.plugin, result }];
      });
    } finally {
      trace.absorb(branches);
    }
  }

  /** Plugin arguments: a bare name resolves against the entity's
   *  extracted fields first (the checker's prior-stage rule); anything
   *  else evaluates as an ordinary movement expression.
   *
   *  A required argument that resolves to nothing — this company's website
   *  field came back empty — SKIPS the invocation for this entity. There is
   *  nothing for the plugin to work on, so the honest outcome is no
   *  enrichment rather than a run over a blank, and the entity's remaining
   *  fields are extracted from what it already has. */
  private async invokePlugin(
    plugin: PluginCall,
    context: Record<string, unknown>,
    node: string,
    trace: TraceSink,
  ): Promise<TransformInvocationResult | typeof SKIPPED> {
    const config: Record<string, unknown> = {};
    for (const arg of plugin.args) {
      const raw = arg.value.raw.trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw) && raw in context) {
        config[arg.name] = context[raw];
      } else {
        config[arg.name] = (await this.runtime.evalSlot(arg.value)).value;
      }
    }
    // Engine-injected `auto` params (e.g. vc_url_retrieval's `text`): fed
    // from the extract source text, not author-supplied. Done last so the
    // author can't override them.
    const spec = pluginSpecNamed(this.runtime.plugins, plugin.plugin);
    for (const fed of spec?.fedArgs ?? []) config[fed.name] = this.sourceText;

    // The URL the invocation was pointed at — the one argument worth naming
    // on the trace, because a fetch is what a slow run is usually waiting on
    // and its per-URL backstop is seven minutes.
    const url = typeof config.url === 'string' ? tracedUrl(config.url) : undefined;

    for (const param of spec?.requiredArgs ?? []) {
      if (!isBlank(config[param])) continue;
      logger.info('[movement:transform] required argument is empty — skipping this entity', {
        plugin: plugin.plugin,
        param,
        written: plugin.args.some((a) => a.name === param),
        ...runLogFields(this.runtime.run),
      });
      trace.push({
        kind: 'plugin',
        plugin: plugin.plugin,
        node,
        durationMs: 0,
        skippedParam: param,
      });
      return SKIPPED;
    }

    const elapsed = await stopwatch(this.runtime.run?.clock);
    const result = await this.runtime.transformInvoker.invoke({
      plugin: plugin.plugin,
      config,
      extractedContext: { ...context },
    });
    const durationMs = await elapsed();
    const fields = Object.keys(result.data ?? {});
    trace.push({
      kind: 'plugin',
      plugin: plugin.plugin,
      node,
      ...(url !== undefined ? { url } : {}),
      durationMs,
      ...(result.text ? { chars: result.text.length } : {}),
      ...(fields.length > 0 ? { fields } : {}),
      ...(result.outcome ? { outcome: result.outcome } : {}),
    });
    return result;
  }
}

/** The rejection's first complaint, in the failure message's voice: where in
 *  the reply it was, and what was wrong there. */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'the schema could not read what was inside';
  const at = issue.path.length > 0 ? `at \`${issue.path.join('.')}\`, ` : '';
  return `${at}${issue.message}`;
}

/** A URL as the trace carries it — bounded like every other traced value. */
export function tracedUrl(url: string): string {
  return url.length > TRACE_URL_CHARS ? `${url.slice(0, TRACE_URL_CHARS)}…` : url;
}

/** No invocation happened for this entity — distinct from an invocation that
 *  ran and found nothing, which still gets an (empty) enrichment entry. */
const SKIPPED = Symbol('plugin-skipped');

function isBlank(value: unknown): boolean {
  if (value == null) return true;
  return typeof value === 'string' && value.trim() === '';
}

// ── Response parsing ────────────────────────────────────────────────────────

/** Would the continuation prompt carry an ENRICHMENT block at all? Mirrors
 *  `renderUserMessage`'s own test exactly — a plugin that skipped this entity
 *  never reaches `enrichments`, and one that ran without text or data renders
 *  nothing — so this answers the only question that matters: is there
 *  anything here the previous stage's call didn't already see? */
function hasEnrichmentContent(
  enrichments: Array<{ plugin: string; result: TransformInvocationResult }>,
): boolean {
  return enrichments.some(
    ({ result }) => Boolean(result.text) || Object.keys(result.data ?? {}).length > 0,
  );
}

/** A fenced stage's data sources: the bundle-level base plus this
 *  stage's `through` enrichments — what the continuation call saw. */
function stageSources(
  baseSources: ProvenanceOrigin[],
  enrichments: Array<{ plugin: string; result: TransformInvocationResult }>,
): ProvenanceOrigin[] {
  if (enrichments.length === 0) return baseSources;
  return [
    ...baseSources,
    ...enrichments.map((e): ProvenanceOrigin => ({ kind: 'enrichment', plugin: e.plugin })),
  ];
}

/** Walks a batch's emission tree (a through-free region covers the root
 *  plus every unfenced descendant in one call), tallying — per node name —
 *  entities whose own declared fields are all null. Judged per-node: a
 *  child's values never rescue (or count against) its parent's tally.
 *  Counted BEFORE `dropEmptyEmissions` runs, so the trace still says how many
 *  records the model answered with nothing in them. */
function countEmptyEmissions(emissions: WorkingEmission[], into: Record<string, number>): void {
  for (const emission of emissions) {
    if (isEmptyRecord(emission)) {
      into[emission.spec.name] = (into[emission.spec.name] ?? 0) + 1;
    }
    for (const children of emission.children.values()) {
      countEmptyEmissions(children, into);
    }
  }
}

/** A record the model answered with nothing in it: every field it declares at
 *  this stage came back absent. A node that declares NO scalar fields is
 *  structural — it exists to carry its children, so it is never "empty". */
function isEmptyRecord(emission: WorkingEmission): boolean {
  const fields = emission.spec.stages[emission.stageIndex].fields;
  return fields.length > 0 && fields.every((f) => emission.context[f.name] == null);
}

/**
 * The handbook's promise, kept by the engine rather than asked of the model:
 * "a record with no value in any of its fields is dropped rather than emitted
 * all-null". The system prompt asks for the same thing, but a prompt is a
 * request — a model that answers with one empty entity (or with keys nobody
 * declared, which `.passthrough()` accepts and every field then projects to
 * null) used to hand the program a real position built from no facts: a write
 * with every field null, an iteration of a fan-out over nothing, and — behind
 * a `through` fence — a plugin invocation and a whole second model call spent
 * asking about an entity that carries none.
 *
 * A parent survives on its CHILDREN's evidence: dropping a fieldless-but-
 * populated parent would take real records with it, so the emptiness has to be
 * judged bottom-up.
 */
function dropEmptyEmissions(
  emissions: WorkingEmission[],
  /** Tallies what was actually dropped, per node name. Distinct from the
   *  `empty` tally: a fieldless parent that survived on its children's
   *  evidence is empty but not dropped, and a reader who cannot tell those
   *  apart cannot tell a working extract from a broken one. */
  dropped: Record<string, number>,
): WorkingEmission[] {
  const kept: WorkingEmission[] = [];
  for (const emission of emissions) {
    let carriesChildren = false;
    for (const [name, children] of emission.children) {
      const survivors = dropEmptyEmissions(children, dropped);
      emission.children.set(name, survivors);
      carriesChildren ||= survivors.length > 0;
    }
    if (carriesChildren || !isEmptyRecord(emission)) kept.push(emission);
    else dropped[emission.spec.name] = (dropped[emission.spec.name] ?? 0) + 1;
  }
  return kept;
}

/**
 * A field the extraction did not produce is ABSENT — never an empty-string
 * sentinel. A model with nothing to say answers `""` (or whitespace) about as
 * often as it answers `null`, and the two are the same fact; only one of them
 * is visible to the null plane, so an author's `EXISTS` / `ISNULL` / `== null`
 * guard silently fails on the other. Collapsed here, at the ONE place a
 * response value becomes a field value, so no guard has to know the
 * difference and no `COALESCE(x, "")` is needed to make them agree.
 *
 * A blank entry drops out of a list for the same reason, and a list left with
 * nothing is itself absent — an unproduced list is not "a list of nothing".
 */
export function absentIfBlank(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (Array.isArray(value)) {
    const kept = value.map(absentIfBlank).filter((v) => v !== null);
    return kept.length > 0 ? kept : null;
  }
  return value;
}

function projectEmission(raw: Record<string, unknown>, site: CallSite): WorkingEmission {
  const context: Record<string, unknown> = {};
  const provenance: Record<string, ProvenanceOrigin> = {};
  for (const field of site.spec.stages[site.stageIndex].fields) {
    const wrapped = raw[field.name] as
      | { evidence?: string | null; value?: unknown }
      | null
      | undefined;
    // `json` is exempt: its shape is the author's own and nothing validates
    // it, so the engine does not reach inside a structure it doesn't own.
    context[field.name] =
      field.type === 'json' ? (wrapped?.value ?? null) : absentIfBlank(wrapped?.value);
    // The response's `{ evidence, value }` wrapping, kept (E4): the
    // field's origin is the interned call site + the authored
    // description + the LLM's verbatim quote.
    provenance[field.name] = {
      kind: 'extraction',
      site: site.ref,
      field: field.name,
      description: field.description,
      ...(wrapped?.evidence ? { quote: wrapped.evidence } : {}),
    };
  }
  const children = new Map<string, WorkingEmission[]>();
  for (const child of site.children) {
    const rawChildren = raw[child.spec.name];
    const arr = Array.isArray(rawChildren) ? rawChildren : rawChildren == null ? [] : [rawChildren];
    children.set(
      child.spec.name,
      arr
        .filter((e): e is Record<string, unknown> => e != null && typeof e === 'object')
        .map((e) => projectEmission(e, child)),
    );
  }
  return {
    spec: site.spec,
    stageIndex: site.stageIndex,
    context,
    provenance,
    origin: { kind: 'extraction', site: site.ref },
    children,
  };
}

/**
 * The fields a program reads as PRESENT text: those declared plain text — the
 * inline `name: "…"` shortcut, or `<text>`, whether inline or from a node
 * declaration (`node entry: <Entry>`, whose spec is the inline block's) — by
 * the stage that last declares them (a later stage re-declaring a field
 * transforms it, type included). A field annotated `<text | null>` is not: its
 * author asked for the absence. The checker's half of this rule is
 * `readsAsPresentText`.
 *
 * Text has a value that means "nothing found", `""`, so the program is handed
 * that and never has to discharge an absence it would only print or write
 * (the checker types these reads `text`, not `text | absent`). A typed field —
 * a number, a date, a choice from a set — has no such value and stays absent.
 *
 * Applied only here, where a result leaves for the program: inside the
 * extraction a blank is still absent, so an all-blank record is still dropped
 * and still counted empty.
 */
function presentTextFields(spec: ExtractNodeSpec, languageVersion: LanguageVersion): Set<string> {
  // Version 1 hands an unfound text over absent, like every other field.
  if (before(languageVersion, 2)) return new Set();
  const declared = new Map<string, ExtractFieldSpec>();
  for (const stage of spec.stages) {
    for (const field of stage.fields) declared.set(field.name, field);
  }
  const text = new Set<string>();
  for (const [name, field] of declared) {
    if (field.nullable === true) continue;
    if (field.type === undefined || field.type === 'text') text.add(name);
  }
  return text;
}

/** The source content (`from [...]` resources) is shared by every emission of
 *  one `extract` — it rides the root and every descendant unchanged. A record
 *  whose own stage fetched files adds them, for itself and everything beneath
 *  it, since those records were read in the light of what it fetched. */
function exportEmission(
  working: WorkingEmission,
  exported: { inherited: Resource[]; languageVersion: LanguageVersion },
): ExtractEmission {
  const { inherited, languageVersion } = exported;
  const resources =
    working.resources !== undefined ? [...inherited, ...working.resources] : inherited;
  const fields: Record<string, unknown> = {};
  const provenance: Record<string, ProvenanceOrigin> = {};
  const textFields = presentTextFields(working.spec, languageVersion);
  for (const name of working.spec.exported) {
    const value = working.context[name] ?? null;
    fields[name] = value === null && textFields.has(name) ? '' : value;
    const origin = working.provenance[name];
    if (origin) provenance[name] = origin;
  }
  const children = new Map<string, ExtractEmission[]>();
  for (const [name, list] of working.children) {
    children.set(
      name,
      list.map((c) => exportEmission(c, { inherited: resources, languageVersion })),
    );
  }
  return {
    nodeName: working.spec.name,
    fields,
    provenance,
    ...(working.origin !== undefined ? { origin: working.origin } : {}),
    resources,
    children,
  };
}

// ── Schema synthesis (nested) ───────────────────────────────────────────────

/**
 * A node's records, read as the model may actually have written them.
 *
 * The guide asks for a BARE ARRAY under the node's key and reserves the
 * `{ evidence, value }` pair for a leaf FIELD. A model that has just written
 * that pair fifty times over applies it to the list as well (production, Project
 * A 2026-09-01: an entire correctly-extracted list arrived under
 * `{ evidence: "the whole list…", value: [ … ] }`), and `.passthrough()` then
 * read the envelope as ONE record carrying two keys nothing declared — every
 * declared field null, and a good extraction dropped. The records inside are
 * right; only the packaging is wrong, so the packaging is what comes off.
 *
 * The node's own DECLARED keys break the tie, because the envelope is
 * recognised by shape: a node that declares a field called `value` is answered
 * with an object keyed `value`, and that object is its record, not an envelope.
 *
 * The envelope's own `evidence` is dropped. It describes the LIST, and the
 * emission model has nowhere to put a quote that belongs to no field and no
 * single record — inventing a per-record citation out of it would be a worse
 * lie than losing it.
 */
function recordListReader(site: CallSite): (value: unknown) => unknown {
  const declared = declaredKeys(site);
  const ambiguous = declared.has('value') || declared.has('evidence');
  return (value) => {
    const records = !ambiguous && isEvidenceEnvelope(value) ? value.value : value;
    return Array.isArray(records) || records == null ? records : [records];
  };
}

/** Every key one of this node's records may carry — the stage's own fields
 *  plus each child node's alias. It is what `entitySchemaFor` builds its shape
 *  from, and so also what recognises a record by shape when the model wrote
 *  the packaging around it wrongly. */
function declaredKeys(site: CallSite): Set<string> {
  return new Set([
    ...site.spec.stages[site.stageIndex].fields.map((f) => f.name),
    ...site.children.map((c) => c.spec.name),
  ]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The per-field response wrapping, applied where it does not belong: an
 *  object carrying `value` and nothing but an optional `evidence` beside it. */
function isEvidenceEnvelope(value: unknown): value is { evidence?: unknown; value: unknown } {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.includes('value') && keys.every((k) => k === 'value' || k === 'evidence');
}

/** Where a structured citation keeps its quote when a model writes one —
 *  read in this order, first non-blank string wins. */
const EVIDENCE_QUOTE_KEYS = ['quote', 'text', 'evidence'];

/** How deep the lone-string search goes. A citation is a shallow thing; past
 *  this the "exactly one string" reading stops being about a quote at all. */
const EVIDENCE_SALVAGE_DEPTH = 4;

/**
 * The quote inside a citation the model did not write as a string.
 *
 * There is one only when it is unambiguous: an obvious key (`quote`, `text`,
 * `evidence`), or a single string anywhere in the structure. Two strings, none,
 * or a number leave the field without a citation — picking one of two, or
 * rendering a number as a quote, would be a worse provenance record than none.
 */
function salvagedQuote(evidence: unknown): string | null {
  if (typeof evidence === 'string') return evidence;
  if (isPlainRecord(evidence)) {
    for (const key of EVIDENCE_QUOTE_KEYS) {
      const named = evidence[key];
      if (typeof named === 'string' && named.trim() !== '') return named;
    }
  }
  const found: string[] = [];
  collectStringLeaves(evidence, EVIDENCE_SALVAGE_DEPTH, found);
  return found.length === 1 ? found[0] : null;
}

function collectStringLeaves(value: unknown, depth: number, into: string[]): void {
  if (into.length > 1) return;
  if (typeof value === 'string') {
    if (value.trim() !== '') into.push(value);
    return;
  }
  if (depth === 0) return;
  const children = Array.isArray(value) ? value : isPlainRecord(value) ? Object.values(value) : [];
  for (const child of children) collectStringLeaves(child, depth - 1, into);
}

/**
 * The evidence half of a field's answer, read as a model may actually write it.
 *
 * Evidence is PROVENANCE — a quote standing behind the value — so a reply that
 * omits it, or writes it as a small structure, has still answered the question
 * that was asked. Failing the call over the citation throws the answer away
 * with it: in production a ~50-entity extraction died on
 * `entry.49.flag_reason.evidence` being absent and then, on the retry, on
 * `entry.45.sourced_by.evidence` being an object — twelve minutes of work lost
 * to the packaging of two quotes out of some seven hundred.
 *
 * So the evidence half is normalised here and the VALUE half is left exactly as
 * strict as it was: a value of the wrong type is a wrong answer, and that still
 * earns the retry.
 *
 * Only an object that already carries `value` is touched, because that is the
 * shape this wrapper is FOR. A `json` field answered with a bare structure of
 * the author's own is not an envelope, and must keep failing as it did rather
 * than being read as a citation-less empty.
 */
function normaliseFieldEvidence(raw: unknown, ctx?: FieldCoercions): unknown {
  if (!isPlainRecord(raw) || !('value' in raw)) return raw;
  const { evidence } = raw;
  if (typeof evidence === 'string' || evidence === null) return raw;
  // A citation the model never wrote is not a coercion: nothing was normalised
  // away, so there is nothing for the run to explain.
  if (evidence === undefined) return { ...raw, evidence: null };
  ctx?.sink.recordEvidence(ctx.key, evidence);
  return { ...raw, evidence: salvagedQuote(evidence) };
}

function wrapFieldEvidence(valueSchema: z.ZodTypeAny, ctx?: FieldCoercions): z.ZodTypeAny {
  return z.preprocess(
    (raw) => normaliseFieldEvidence(raw, ctx),
    z.object({ evidence: z.string().nullable(), value: valueSchema }).nullable().optional(),
  );
}

/** Where one field's coercions are recorded, and under what key. */
export interface FieldCoercions {
  key: string;
  sink: CoercionTracker;
}

/**
 * Accumulates what a parse normalised away, so a run can explain it instead of
 * the change happening in silence. Two things, kept apart because they are not
 * the same loss:
 *
 * - a CLOSED-enum coercion that discarded a value — a non-member nulled (single
 *   select) or dropped from a multiselect array (`open` enums never record
 *   here: a novel value there is legal, not a loss);
 * - a field's EVIDENCE rewritten to a quote or to nothing, which loses a
 *   citation while the value itself comes through untouched;
 * - the reply's ENVELOPE rebuilt around content that was right but sitting in
 *   the wrong place — one per call, since a call has one envelope.
 *
 * The first two are keyed per `<node>.<field>`, since the same field name
 * recurs across node types.
 *
 * Reset before every parse attempt (`callWithRetry`'s validate-then-retry
 * loop): the schema tree — and its captured closures — is built ONCE per
 * region call and reused for both the first and the retry parse, so without
 * a reset a succeeding retry would inherit the failed attempt's diagnostics.
 */
export class CoercionTracker {
  private byField: Record<string, string[]> = {};
  private evidenceByField: Record<string, string[]> = {};
  private envelope: string | undefined;

  record(fieldKey: string, rawValue: unknown): void {
    pushCoercion(this.byField, fieldKey, String(rawValue));
  }

  /** The citation as WRITTEN — an object renders as its JSON, since
   *  `[object Object]` would say nothing about what came back. */
  recordEvidence(fieldKey: string, rawEvidence: unknown): void {
    pushCoercion(this.evidenceByField, fieldKey, safeStringify(rawEvidence));
  }

  /** How the reply was packaged before the envelope was rebuilt around it —
   *  what the run says instead of "the model answered correctly". */
  recordEnvelope(shape: string): void {
    this.envelope = shape;
  }

  reset(): void {
    this.byField = {};
    this.evidenceByField = {};
    this.envelope = undefined;
  }

  snapshot(): Record<string, string[]> | undefined {
    return Object.keys(this.byField).length > 0 ? this.byField : undefined;
  }

  evidenceSnapshot(): Record<string, string[]> | undefined {
    return Object.keys(this.evidenceByField).length > 0 ? this.evidenceByField : undefined;
  }

  envelopeSnapshot(): string | undefined {
    return this.envelope;
  }
}

function pushCoercion(into: Record<string, string[]>, key: string, rendered: string): void {
  const truncated = rendered.length > 80 ? `${rendered.slice(0, 80)}…` : rendered;
  (into[key] ??= []).push(truncated);
}

export function zodForFieldType(type: FieldType | undefined, ctx?: FieldCoercions): z.ZodTypeAny {
  if (type === undefined) return z.unknown();
  const variant = variantOf(type);
  switch (variant.kind) {
    case 'text':
    case 'date':
    case 'datetime':
    case 'file':
      return z.string().nullable();
    case 'number':
      return z.number().nullable();
    case 'boolean':
      return z.boolean().nullable();
    case 'json':
      // A structured value — whatever shape the description asks for. Nothing
      // describes it, so nothing validates it either; it rides through to the
      // json field verbatim.
      return z.unknown();
    case 'absent':
      // The `null` literal's type. Checker-only (no field is ever declared
      // it), so this never reaches an extraction schema; listed to keep the
      // switch total.
      return z.null();
    // `maybeAbsent` is a checker-only type (a race receipt read); it never
    // reaches extraction, but keep the switch total against its present shape.
    case 'maybeAbsent':
      return zodForFieldType(variant.of, ctx);
    case 'list':
      return zodForListOfFieldType(variant.of, ctx);
    // A TUPLE never reaches an extraction: nothing declares one on an adapter
    // surface and no annotation names one — it is the shape a combinator's
    // receipt has, inside the program. Describe it as opaque rather than guess.
    case 'tuple':
    // A DICT is the same story as a tuple: a value the PROGRAM builds
    // (`GROUPBY`, a `{ k: v }` literal), never a shape an annotation asks a
    // model for. Opaque rather than guessed at.
    case 'dict':
    // A RECORD is a place in a graph, not something a model can answer with:
    // no annotation names one and no adapter surface declares one, so this is
    // unreachable — a field whose type is a record was refused where it was
    // written. Opaque, like the other two program-only shapes.
    case 'record':
      return z.unknown().nullable();
    // A UNION is what a list literal's disagreeing members widen to, inside the
    // program — never an annotation. Any of its members, should one arrive.
    case 'union': {
      const [first, second, ...rest] = variant.of.map(member => zodForFieldType(member, ctx));
      return first !== undefined && second !== undefined ? z.union([first, second, ...rest]) : z.unknown().nullable();
    }
    case 'enum':
      return zodForEnumFieldType(variant, ctx);
    default:
      return neverAsAny(variant);
  }
}

/** A multiselect (list of enum) coerces each entry to its canonical option.
 *  Open (known-values) fields KEEP an unmatched string entry as-is — the
 *  adapter's live listing just hadn't seen it. Closed fields DROP it (one
 *  near-miss must not fail the whole extraction — mirrors the Attio
 *  select/status write path's `matchOption`) and record the loss. */
function zodForListOfFieldType(element: FieldType, ctx?: FieldCoercions): z.ZodTypeAny {
  if (!isEnumType(element) || element.options.length === 0) {
    return z.array(zodForFieldType(element, ctx)).nullable();
  }
  const { options, open } = element;
  return z
    .array(z.unknown())
    .nullable()
    .transform((values) =>
      values === null
        ? null
        : values.flatMap((v): string[] => {
            // A blank entry is nothing extracted, not a discarded value —
            // it drops out without being reported as a loss.
            if (typeof v === 'string' && v.trim() === '') return [];
            const matched = matchOption(v, options);
            if (matched !== undefined) return [matched];
            if (open) return typeof v === 'string' ? [v] : [];
            if (v != null) ctx?.sink.record(ctx.key, v);
            return [];
          }),
    );
}

function zodForEnumFieldType(type: EnumType, ctx?: FieldCoercions): z.ZodTypeAny {
  if (type.options.length === 0) return z.string().nullable();
  // A single select coerces to its canonical option. Open (known-values)
  // fields keep a genuine non-member as its raw string — other values remain
  // legal, per `enum.open`. Closed fields drop to null (tolerant, not
  // strict, so it never throws) and record the loss for (3).
  const { options, open } = type;
  return z.unknown().transform((value) => {
    // A blank answer is nothing extracted, not a non-member: absent, and no
    // coercion diagnostic (nothing was discarded).
    if (typeof value === 'string' && value.trim() === '') return null;
    const matched = matchOption(value, options);
    if (matched !== undefined) return matched;
    if (open) return typeof value === 'string' ? value : null;
    if (value != null) ctx?.sink.record(ctx.key, value);
    return null;
  });
}

/**
 * One entity of a node's list. Unknown keys pass through (a model that adds a
 * key nobody asked for has still answered the question), but a record made
 * ENTIRELY of keys nothing declared has not: every declared field then projects
 * to null, which reads downstream as the model finding nothing and lands as a
 * silent drop. That is a SHAPE failure wearing an empty record's clothes, so it
 * takes the road every other shape failure takes — retried once with the keys
 * named, then raised with the reply on the trace.
 *
 * A record whose DECLARED keys are simply valueless is the other thing entirely:
 * a genuine empty, dropped quietly, exactly as the handbook promises.
 */
function entitySchemaFor(site: CallSite, sink?: CoercionTracker): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of site.spec.stages[site.stageIndex].fields) {
    const ctx = sink ? { key: `${site.spec.name}.${field.name}`, sink } : undefined;
    shape[field.name] = wrapFieldEvidence(zodForFieldType(field.type, ctx), ctx);
  }
  for (const child of site.children) {
    shape[child.spec.name] = z
      .preprocess(recordListReader(child), z.array(entitySchemaFor(child, sink)))
      .optional()
      .nullable();
  }
  const declared = Object.keys(shape);
  const object = z.object(shape).passthrough();
  // A structural node declares nothing at this stage — every key is unknown to
  // it by construction, so it has no shape to be wrong about.
  if (declared.length === 0) return object;
  return object.superRefine((record, ctx) => {
    const keys = Object.keys(record);
    if (keys.length === 0 || keys.some((k) => declared.includes(k))) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `this entity was answered under ${quoteKeys(keys)} — none of which it declares. ` +
        `Its fields are ${quoteKeys(declared)}; answer under those names.`,
    });
  });
}

/** How many of a record's keys an error message is willing to list. */
const NAMED_KEYS = 6;

function quoteKeys(keys: string[]): string {
  const named = keys.slice(0, NAMED_KEYS).map((k) => `\`${k}\``);
  return keys.length > NAMED_KEYS ? `${named.join(', ')}, …` : named.join(', ');
}

/**
 * The answer key is REQUIRED. An optional one made "I did not answer the
 * question" — `{}`, or a reply keyed on something the prompt never named —
 * validate cleanly and read downstream as "extracted nothing", so a model that
 * ignored the request produced a silent empty run instead of the schema
 * failure it is. Required, it takes the ordinary road: retried once with the
 * issue named, then raised. An extraction that genuinely found nothing still
 * says so the way it always did, with an empty array under the key.
 */
function responseSchemaFor(region: CallSite, sink?: CoercionTracker): z.ZodTypeAny {
  return z.preprocess(
    envelopeReader(region, sink),
    z
      .object({
        [region.siteId]: z.preprocess(
          recordListReader(region),
          z.array(entitySchemaFor(region, sink)),
        ),
      })
      .passthrough(),
  );
}

/**
 * The region's records, found when the reply put them somewhere other than
 * under the answer key.
 *
 * Seen in production: a per-entity refinement answered with
 * the field map BARE at the top level — `{ name: { evidence, value }, … }`
 * where the guide asked for `{ "x:entry#26": [ … ] }` — and, asked again,
 * with an ARRAY of those maps. Both replies were content-correct; only the
 * packaging was missing. A production run makes 40-85 per-entity calls, so a
 * per-call drift of a percent makes losing the run the expected outcome.
 *
 * Recognition is STRUCTURAL, never by label: a value is one of this region's
 * records when every key it carries is a key the region declares — the same
 * reading `entitySchemaFor` applies to a record found in the right place. That
 * makes the rule the same for the root call and for a per-entity refinement,
 * and makes it safe in both: what the salvage moves is where the content sits,
 * and the content still faces the full entity schema afterwards, so a wrong
 * answer is still a wrong answer.
 *
 * An EMPTY object or list is deliberately not recognised. "Nothing at all" is
 * exactly the reply that has to keep failing — wrapping it would turn a model
 * that ignored the question into a silent empty extraction, which is the thing
 * the required answer key exists to prevent.
 */
function envelopeReader(region: CallSite, sink?: CoercionTracker): (value: unknown) => unknown {
  const declared = declaredKeys(region);
  return (reply) => {
    // A structural region declares nothing at this stage, so it has no shape
    // to recognise a record by — and nothing to salvage from.
    if (declared.size === 0) return reply;
    if (isPlainRecord(reply) && Object.keys(reply).includes(region.siteId)) return reply;
    const bare = regionRecords(reply, declared);
    if (bare) {
      sink?.recordEnvelope(Array.isArray(reply) ? 'a bare list of records' : 'a bare record');
      return { [region.siteId]: bare };
    }
    if (isPlainRecord(reply)) {
      const keys = Object.keys(reply);
      // The model labelled the answer itself — `{ "entry": [ … ] }` for a call
      // whose key is `x:entry#26`. Exactly one key: with two, which of them is
      // the answer would be a guess.
      const labelled = keys.length === 1 && !declared.has(keys[0]) ? keys[0] : undefined;
      const records = labelled === undefined ? undefined : regionRecords(reply[labelled], declared);
      if (labelled !== undefined && records) {
        sink?.recordEnvelope(`keyed \`${labelled}\``);
        return { [region.siteId]: records };
      }
    }
    return reply;
  };
}

/** A region's record, or a list of them, read by shape — `undefined` when the
 *  value is neither. */
function regionRecords(value: unknown, declared: Set<string>): unknown[] | undefined {
  if (isDeclaredRecord(value, declared)) return [value];
  if (Array.isArray(value) && value.length > 0 && value.every((e) => isDeclaredRecord(e, declared)))
    return value;
  return undefined;
}

function isDeclaredRecord(value: unknown, declared: Set<string>): boolean {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => declared.has(k));
}

/**
 * What the retry asks for, which is not the same question in both cases.
 *
 * A complaint about a VALUE names a place in a reply the model can see, and
 * fixing it there is the whole instruction. A complaint at the TOP of the reply
 * — nothing under the answer key, or the answer key holding something that is
 * not a list — is about the packaging, and a model that has just missed the
 * envelope is not helped by being told again which values are invalid. So it is
 * shown the envelope instead, written out with this region's own key and its
 * own field names.
 */
function retryInstruction(region: CallSite, issues: z.ZodIssue[]): string {
  const packaging = issues.some(
    (i) => i.path.length === 0 || (i.path.length === 1 && i.path[0] === region.siteId),
  );
  return packaging
    ? `The SHAPE of your response was wrong: the entire answer belongs under one key, \`${region.siteId}\`, whose value is a JSON array of records. Keep the values you already extracted and return them in exactly this envelope:\n${envelopeExample(region)}`
    : 'Please fix ONLY the invalid values and return the complete corrected JSON.';
}

/** The envelope a region is asking for, written out — a field is the
 *  `{ evidence, value }` pair, a child node a bare array of its own records. */
function envelopeExample(region: CallSite): string {
  const fields = region.spec.stages[region.stageIndex].fields.map(
    (f) => `"${f.name}": {"evidence": string|null, "value": …}`,
  );
  const children = region.children.map((c) => `"${c.spec.name}": [ … ]`);
  return `{"${region.siteId}": [ { ${[...fields, ...children].join(', ')} } ] }`;
}

function countSites(site: CallSite): number {
  return 1 + site.children.reduce((acc, c) => acc + countSites(c), 0);
}

// ── Prompt assembly (the TG batcher's conventions, nested) ─────────────────

export function describeGuideType(type: FieldType | undefined): string {
  if (type === undefined) return 'text';
  const variant = variantOf(type);
  switch (variant.kind) {
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'json':
    case 'absent':
      return variant.kind;
    case 'list':
      return `list of ${describeGuideType(variant.of)}`;
    // `maybeAbsent` is a checker-only type (a race receipt read) and never
    // reaches extraction guides; describe its present shape defensively
    // rather than crash.
    case 'maybeAbsent':
      return describeGuideType(variant.of);
    case 'tuple':
      return 'a list of values';
    case 'dict':
      return 'a set of named values';
    // Unreachable for the same reason `zodForFieldType`'s record case is — a
    // model is never asked for a record. Described rather than crashed on.
    case 'record':
      return 'a record';
    // Program-only, like a tuple; described rather than crashed on.
    case 'union':
      return variant.of.map(describeGuideType).join(' or ');
    case 'enum':
      // `open` (known-values, not a closed enum): the model must learn other
      // values are legal too, so this reads distinguishably from a closed enum.
      return variant.open
        ? `text, known values: ${variant.options.join(' | ')}`
        : `enum: ${variant.options.join(' | ')}`;
    default:
      return neverAsAny(variant);
  }
}

/** `: <words>` after a name in the guide — nothing when there are no words
 *  (an undescribed declared field is extracted by its name alone). */
export function described(description: string): string {
  return description === '' ? '' : `: ${description}`;
}

function guideSection(site: CallSite, parent: CallSite | undefined): string[] {
  const cardinality = site.single
    ? ' (exactly one entity)'
    : ' (emit each matching entity as an array element — zero, one, or many objects depending on the description)';
  const head = parent
    ? `**${site.siteId}** (an array under the key \`${site.spec.name}\` inside each **${parent.siteId}** entity)${described(site.spec.description)}${cardinality}`
    : `**${site.siteId}**${described(site.spec.description)}${cardinality}`;
  const fieldLines = site.spec.stages[site.stageIndex].fields.map(
    (f) => `    - \`${f.name}\` (${describeGuideType(f.type)})${described(f.description)}`,
  );
  const sections = [
    `${head}\n${fieldLines.length ? fieldLines.join('\n') : '    (no scalar fields — structural only)'}`,
  ];
  for (const child of site.children) sections.push(...guideSection(child, site));
  return sections;
}

function buildSystemPrompt(region: CallSite): string {
  return [
    'You are an information-extraction system.',
    '',
    '## Entity Guide',
    guideSection(region, undefined).join('\n\n'),
    '',
    '## Task',
    'Extract structured data from the input message. For each field, return `{ evidence, value }` — the typed value, plus a quote of the source passage that supports it. Use null for missing values.',
    '',
    `The response is a JSON object with one key — \`${region.siteId}\` — whose value is a bare JSON array of entity objects. Nested entities are emitted as bare arrays under their declared keys inside their parent entity.`,
    '',
    '## Rules',
    '- Give every field an `evidence` quote of the closest supporting source passage you can find.',
    // The production failure the tolerant unwrap now catches: the model applied
    // the per-field wrapping to a node's whole list. Belt and braces, both
    // pointing the same way — the prompt stops asking for the wrong shape, the
    // parser survives it anyway.
    '- The `{ evidence, value }` wrapping belongs to a FIELD and to nothing else. A list of entities is a bare array and an entity is a bare object: never give either one an `evidence` of its own, and never wrap either one in a `{ evidence, value }` pair.',
    '- Every key inside an entity is a field name the guide declares for that entity. Do not rename a field, translate it, or answer under a key of your own.',
    "- The field's description is authoritative. When it asks you to compose, normalize, reformat, or prefix a value — joining a brand name with a product name shown elsewhere, say — produce that composed value and quote the passage(s) it was built from.",
    '- Never return null merely because the finished value does not appear verbatim in the source.',
    '- Use null only when the source genuinely lacks the information. Do not invent values that have no support in the source.',
    '- A missing value is null. Never stand one in with an empty string, whitespace, or a placeholder like "none", "N/A" or "unknown".',
    '- Entities of the same type must have unique names.',
    '- Where the guide permits zero entities, omit an entity entirely rather than emitting it with every field null — unless its description explicitly allows empty or placeholder entities.',
  ].join('\n');
}

/** The prompt a call sees, plus the SHAPE of it — one labelled part per
 *  source segment / entity block / enrichment. The shape is what the trace
 *  keeps: "this call read 6.2k, its sibling read 1.2k" is the first useful
 *  fact about a call that came back with nothing, and the total alone can
 *  never say it. */
function renderUserMessage(
  segments: Segment[],
  entity:
    | {
        spec: ExtractNodeSpec;
        context: Record<string, unknown>;
        enrichments: Array<{ plugin: string; result: TransformInvocationResult }>;
      }
    | undefined,
): { text: string; parts: Array<{ classification: string; chars: number }> } {
  const rendered: string[] = [];
  const parts: Array<{ classification: string; chars: number }> = [];
  const push = (classification: string, body: string) => {
    rendered.push(body);
    parts.push({ classification, chars: body.length });
  };
  for (const seg of segments) push(seg.classification, `## ${seg.classification}\n${seg.content}`);
  if (entity) {
    push(
      'CURRENT ENTITY',
      [
        '## CURRENT ENTITY',
        `You are extracting the remaining fields of one already-identified entity${described(entity.spec.description)}`,
        '```json',
        JSON.stringify(entity.context, null, 2),
        '```',
      ].join('\n'),
    );
    for (const { plugin, result } of entity.enrichments) {
      const lines = [`## ENRICHMENT via \`${plugin}\``];
      if (result.text) lines.push(result.text);
      if (result.data && Object.keys(result.data).length > 0) {
        lines.push('```json', JSON.stringify(result.data, null, 2), '```');
      }
      if (lines.length > 1) push(`ENRICHMENT via ${plugin}`, lines.join('\n'));
    }
  }
  return { text: rendered.join('\n\n'), parts };
}

function transformResultSegments(plugin: string, result: TransformInvocationResult): Segment[] {
  const segments: Segment[] = [];
  if (result.text) segments.push({ classification: 'FRAGMENT', content: result.text });
  if (result.data && Object.keys(result.data).length > 0) {
    segments.push({ classification: 'FRAGMENT', content: safeStringify(result.data) });
  }
  return segments;
}

function segmentForDatum(datum: unknown): Segment {
  if (typeof datum === 'string') return { classification: 'TEXT', content: datum };
  if (typeof datum === 'object' && datum !== null) {
    const r = datum as { content?: unknown; type?: unknown };
    if (typeof r.content === 'string') {
      return {
        classification: typeof r.type === 'string' ? r.type : 'TEXT',
        content: r.content,
      };
    }
  }
  return { classification: 'FRAGMENT', content: safeStringify(datum) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ── Source content → resources (Layer 5 provenance) ──────────────────────────
//
// The `from [...]` data, captured as the source resources that fed extraction.
// A FILE resource preserves the source `FileRef` (the descriptor of its bytes)
// so the file can be carried forward to an output write; a TEXT resource carries
// the text body inline. Mirrors the adapter resource currency
// (`adapter.ts:Resource`) so `persistKgResources` / the file-write path consume
// them unchanged.

/** The source `FileRef` → a FILE `Resource` carrying the SAME `FileRef`.
 *  Its `content` is the file's WHOLE text, never the prompt's bounded copy: a
 *  resource is what a carry-forward write and the stored provenance read, so
 *  cutting it there would silently write a fragment of the document into a
 *  record. The ceiling is a prompt-cost bound and belongs only to the prompt.
 *  `data.file` exposes the file a write reads (`r.\`file\`` → the FileRef
 *  → the target redeems it on the host for its upload). Built for EVERY source file regardless of OCR; the
 *  extracted `text`, when present, rides `content` (and `rawTextId` in metadata)
 *  so the resource is self-describing — a file with no OCR text still carries
 *  forward, just without inline text. */
function fileResourceForRef(ref: FileRef, text: FileTextResult | undefined): Resource {
  const externalId = fileHandle(ref);
  return {
    ...(externalId !== undefined ? { externalId } : {}),
    type: 'FILE',
    ...(ref.name !== undefined ? { name: ref.name } : {}),
    url: null,
    fileRef: ref,
    ...(ref.contentType !== undefined ? { contentType: ref.contentType } : {}),
    ...(text && text.text.trim().length > 0 ? { content: text.text } : {}),
    data: {
      file: ref,
      ...(ref.name !== undefined ? { name: ref.name } : {}),
      type: 'FILE',
      ...(ref.contentType !== undefined ? { contentType: ref.contentType } : {}),
    },
    ...(text?.rawTextId !== undefined ? { metadata: { rawTextId: text.rawTextId } } : {}),
  };
}

/** A non-file `from` datum → a TEXT `Resource` (the text the extraction read).
 *  Returns `undefined` for non-string/structureless data — those still feed the
 *  prompt as segments, but aren't a discrete provenance resource. */
function textResourceForDatum(datum: unknown): Resource | undefined {
  const segment = segmentForDatum(datum);
  if (segment.content.trim().length === 0) return undefined;
  return {
    type: 'TEXT',
    content: segment.content,
    data: { content: segment.content, type: 'TEXT' },
  };
}

function sanitizeSiteName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}
