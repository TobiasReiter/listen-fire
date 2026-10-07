// Movement engine — the extraction CALL, `extract(content, Shape, config)`.
//
// Content in, a list of `Shape` records out: run-local records (the graph
// literal's `nodePosition`), one per thing the content names, each nested node
// an edge of records of its own. One model call per extraction, however deep
// the shape.
//
// `extractOne(content, Shape, config)` is the same call asking for the single
// record the content describes: the record, or absent when there is none. Only
// the last block (what to extract, how to answer) and the reply's packaging
// differ, so it shares the cached content with an `extract` over the same
// content.
//
// This is a SECOND engine path beside the keyword's (`extraction.ts`), and the
// keyword's is untouched by it. What the two share is single-call machinery
// only — the declaration's spec builder, the field validators, the file-text
// seam and its bound — and both reach the model through the host's clients,
// which own the output budget and the truncation rule
// (`translation_graph/movement/llm_clients.ts`). The PROMPT is this file's own,
// laid out for the prompt cache:
//
//   1. one system prompt, identical for every call — no shape in it;
//   2. each content item as its own user block, in the author's order;
//   3. the shape and the instructions LAST.
//
// So a later call over the same leading content — the per-entity calls of a
// `MAP` that put the shared content first — reads that content from the cache
// the first call wrote, whatever shape it asks for. The engine remembers the
// content prefixes this run has sent (`ExtractCallPrefixes`) and puts a cache
// breakpoint at the end of the longest one this call shares, and one at the end
// of all the content.

import { createHash } from 'node:crypto';

import type { ExtractCallFinds } from 'movement-lang';
import { z } from 'zod';

import { neverAsAny } from '../../lib/utils/types';
import type { LlmCallResult } from '../translation_graph/engine/batched_extraction';
import type { FileRef } from '../translation_graph/adapter';
import { fileHandle, isFileRef } from '../translation_graph/adapter';
import type { Effort, ExtractionCallSettings, TierModel } from './ai_tiers';
import {
  absentIfBlank,
  boundFileText,
  CoercionTracker,
  describeGuideType,
  described,
  recordExtractedEntities,
  replyDigest,
  TRACE_REPLY_DIGESTS,
  zodForFieldType,
  type ExtractFieldSpec,
  type ExtractNodeSpec,
  type TracedTree,
} from './extraction';
import {
  bindingOf,
  isFileUnreadable,
  MovementEngineError,
  type Binding,
  type ExtractionTraceFile,
  type FileTextResolution,
  type LocalLandingShape,
  type MovementTraceEntry,
} from './expression';
import { fromOrigin, NO_PROVENANCE, type ExtractSiteRef, type Provenance, type ProvenanceOrigin } from './provenance';
import { throwIfCancelled, type RunFacts } from './run_context';

// ── The model seam ──────────────────────────────────────────────────────────

/** One block of the user turn. `cacheBreakpoint` ends the cacheable prefix
 *  here; a provider without explicit breakpoints keeps the order and drops
 *  the marker. */
export interface ExtractCallBlock {
  text: string;
  cacheBreakpoint?: true;
}

export interface ExtractCallLlmInput {
  system: string;
  blocks: ExtractCallBlock[];
  label: string;
  model: TierModel;
  effort?: Effort;
  maxTokens?: number;
}

/** Tokens one call spent, as the provider counts them. */
export interface ExtractCallUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ExtractCallLlmResult extends LlmCallResult {
  usage?: ExtractCallUsage;
}

/** The extraction call's model client — the keyword's `LlmClient` takes one
 *  undivided user message, and this layout is blocks. Tests inject a stub. */
export interface ExtractCallLlmClient {
  call(input: ExtractCallLlmInput): Promise<ExtractCallLlmResult>;
}

// ── The run's memory: prefixes sent, files read ─────────────────────────────

/**
 * The content prefixes this run has already sent, per model and effort (a
 * cached prefix is only ever read back by a request to the same model with
 * the same thinking settings).
 *
 * A prefix is identified by a CHAIN of hashes — each item's hash folded into
 * the one before — so "the first k items of this call were the first k items
 * of an earlier one" is one set lookup per k, and nothing compares texts.
 */
export class ExtractCallPrefixes {
  private readonly sent = new Map<string, Set<string>>();

  /**
   * Where this call's breakpoints go — the content items whose blocks end in
   * one — and how many leading items an earlier call already sent. Then
   * remembers this call's own prefixes, so the next call can find them.
   *
   * At most two: the end of the longest prefix already sent (the cache an
   * earlier call wrote, read here — and written at that boundary if the
   * earlier call's breakpoint sat further on), and the end of all the content
   * (what the next call over the same content reads).
   */
  plan(cacheKey: string, items: readonly string[]): { breakpoints: number[]; sharedItems: number } {
    const sent = this.sent.get(cacheKey) ?? new Set<string>();
    this.sent.set(cacheKey, sent);
    const chain: string[] = [];
    let previous = '';
    for (const item of items) {
      previous = sha256(`${previous}\u0000${sha256(item)}`);
      chain.push(previous);
    }
    let sharedItems = 0;
    for (let k = chain.length; k > 0; k--) {
      if (sent.has(chain[k - 1])) {
        sharedItems = k;
        break;
      }
    }
    const breakpoints: number[] = [];
    if (sharedItems > 0 && sharedItems < items.length) breakpoints.push(sharedItems - 1);
    if (items.length > 0) breakpoints.push(items.length - 1);
    for (const link of chain) sent.add(link);
    return { breakpoints, sharedItems };
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** One content file as the prompt reads it: its bounded text, or why there is
 *  none — the same seam and the same bound as the keyword's file sources. */
interface ContentFile {
  text?: string;
  origin?: ProvenanceOrigin;
  traced: ExtractionTraceFile;
}

/** Everything the extraction calls of one run share. */
export class ExtractCallRunState {
  readonly prefixes = new ExtractCallPrefixes();
  /** File text by the file's handle: a file in the content of every member of
   *  a `MAP` is read once, and renders identically each time — a block that
   *  rendered differently would miss the cache. */
  readonly files = new Map<string, Promise<ContentFile>>();
}

export interface ExtractCallRuntime {
  llm: ExtractCallLlmClient;
  resolveFileText?: (ref: FileRef) => Promise<FileTextResolution>;
  trace?: MovementTraceEntry[];
  state: ExtractCallRunState;
  /** The run this call is in — its cancel gate and its id for log lines.
   *  Absent ⇒ outside a run: nothing to cancel. */
  run?: RunFacts;
}

// ── The prompt ──────────────────────────────────────────────────────────────

/** Identical for every extraction call there is — the shape comes last, so
 *  nothing here varies. */
export const EXTRACT_CALL_SYSTEM_PROMPT = [
  'You are an information-extraction system.',
  '',
  'You are given content as numbered items, one block per item, in the order its author listed them. The last block says what to extract from that content and how to answer.',
  '',
  'Read every content item. Extract only what the content supports, and cite the item each value came from.',
].join('\n');

/** The answer key for each call — fixed per call, because the shape block is
 *  the only thing that should differ between two calls over the same
 *  content. `extract` answers a list of records; `extractOne` one record, or
 *  null. */
const ANSWER_KEY: Record<ExtractCallFinds, string> = { each: 'records', one: 'record' };

function guideLines(spec: ExtractNodeSpec, parent: string | undefined, depth: number, finds: ExtractCallFinds): string[] {
  const indent = '  '.repeat(depth);
  const root = (): string => {
    switch (finds) {
      case 'each':
        return `${indent}**${spec.name}**${described(spec.description)} — emit each one as an element of the \`${ANSWER_KEY.each}\` array (zero, one, or many, as the description says)`;
      case 'one':
        return `${indent}**${spec.name}**${described(spec.description)} — the one record, as the object under \`${ANSWER_KEY.one}\``;
      default:
        return neverAsAny(finds);
    }
  };
  const head = parent === undefined
    ? root()
    : `${indent}**${spec.name}** (an array under the key \`${spec.name}\` inside each **${parent}**)${described(spec.description)}`;
  const stage = spec.stages[0];
  const fields = (stage?.fields ?? []).map(
    (f) => `${indent}    - \`${f.name}\` (${describeGuideType(f.type)})${described(f.description)}`,
  );
  return [
    head,
    ...(fields.length > 0 ? fields : [`${indent}    (no fields — structural only)`]),
    ...(stage?.children ?? []).flatMap((child) => guideLines(child, spec.name, depth + 1, finds)),
  ];
}

/** What the call asks for, said before the shape: `extractOne` asks for the
 *  single thing the content describes — in the shape's own words when it has
 *  them — and says that nothing is an answer. */
function askLines(spec: ExtractNodeSpec, finds: ExtractCallFinds): string[] {
  switch (finds) {
    case 'each':
      return [];
    case 'one': {
      const description = spec.description.trim();
      const ask = description === ''
        ? `Extract the single **${spec.name}** these sources describe, or nothing if they don't.`
        : `Extract ${description} — the single one these sources describe, or nothing if they don't.`;
      return [ask, ''];
    }
    default:
      return neverAsAny(finds);
  }
}

/** How the answer is packaged, for each call. */
function answerLine(finds: ExtractCallFinds): string {
  switch (finds) {
    case 'each':
      return `Return a JSON object with one key, \`${ANSWER_KEY.each}\`, whose value is a bare JSON array of records. A nested node is a bare array of its own records under its key inside its parent record.`;
    case 'one':
      return `Return a JSON object with one key, \`${ANSWER_KEY.one}\`, whose value is the one record as a bare JSON object — or null when these sources describe none. Never an array: this asks for one record. A nested node is a bare array of its own records under its key inside the record.`;
    default:
      return neverAsAny(finds);
  }
}

/** The last block: the shape, then the instructions. */
function shapeBlock(spec: ExtractNodeSpec, items: readonly number[], finds: ExtractCallFinds): string {
  return [
    '## What to extract',
    '',
    ...askLines(spec, finds),
    guideLines(spec, undefined, 0, finds).join('\n'),
    '',
    '## How to answer',
    '',
    answerLine(finds),
    '',
    'Every field is answered as `{ "value": …, "evidence": { "item": <n>, "quote": "…" } }` — the typed value, the number of the content item it came from, and a quote of the passage that supports it. Use null for a value the content does not give.',
    '',
    '## Rules',
    `- \`item\` is the number in the heading of the content block the value came from (${items.map((i) => String(i)).join(', ')}). When a value is composed from several items, cite the one that carries most of it.`,
    '- The `{ value, evidence }` wrapping belongs to a FIELD and to nothing else. A list of records is a bare array and a record is a bare object.',
    '- Every key inside a record is a field or nested node the guide declares for it. Do not rename a field or answer under a key of your own.',
    "- A field's description is authoritative. When it asks you to compose, normalise or reformat a value, produce that value and quote the passage(s) it was built from.",
    '- Use null only when the content genuinely lacks the information. Never stand a missing value in with an empty string or a placeholder like "none", "N/A" or "unknown".',
    emptyRecordRule(finds),
  ].join('\n');
}

/** Where the retry is told the corrected answer goes. */
function correctionLine(finds: ExtractCallFinds): string {
  switch (finds) {
    case 'each':
      return `with every record under \`${ANSWER_KEY.each}\``;
    case 'one':
      return `with the one record (or null) under \`${ANSWER_KEY.one}\``;
    default:
      return neverAsAny(finds);
  }
}

function emptyRecordRule(finds: ExtractCallFinds): string {
  switch (finds) {
    case 'each':
      return '- Records of the same kind must be distinct. Omit a record entirely rather than emitting one with every field null.';
    case 'one':
      return `- Answer \`${ANSWER_KEY.one}\` as null rather than a record with every field null. Records of the same nested kind must be distinct; omit a nested record rather than emitting one with every field null.`;
    default:
      return neverAsAny(finds);
  }
}

// ── The answer ──────────────────────────────────────────────────────────────

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A field's evidence, as the model may actually write it: the citation
 *  object asked for, a bare quote, or nothing. The VALUE half stays strict —
 *  a wrong value earns the retry; a loose citation is provenance, not the
 *  answer. */
function normaliseCallField(raw: unknown): unknown {
  if (!isPlainRecord(raw) || !('value' in raw)) return raw;
  const { evidence } = raw;
  if (evidence === undefined || evidence === null) return { ...raw, evidence: null };
  if (typeof evidence === 'string') return { ...raw, evidence: { quote: evidence } };
  if (!isPlainRecord(evidence)) return { ...raw, evidence: null };
  const item = typeof evidence.item === 'string' && /^\d+$/.test(evidence.item.trim())
    ? Number(evidence.item.trim())
    : evidence.item;
  const quote = [evidence.quote, evidence.text].find((q) => typeof q === 'string');
  return {
    ...raw,
    evidence: {
      ...(typeof item === 'number' && Number.isInteger(item) ? { item } : {}),
      ...(quote !== undefined ? { quote } : {}),
    },
  };
}

const citation = z
  .object({ item: z.number().int().optional(), quote: z.string().optional() })
  .nullable();

function fieldSchema(field: ExtractFieldSpec, key: string, sink: CoercionTracker): z.ZodTypeAny {
  return z.preprocess(
    normaliseCallField,
    z
      .object({ value: zodForFieldType(field.type, { key, sink }), evidence: citation })
      .nullable()
      .optional(),
  );
}

/** A node's records as the model may have packaged them: a bare array, or one
 *  record where an array was asked for. */
function recordList(value: unknown): unknown {
  return Array.isArray(value) || value == null ? value : [value];
}

function recordSchema(spec: ExtractNodeSpec, sink: CoercionTracker): z.ZodTypeAny {
  const stage = spec.stages[0];
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of stage?.fields ?? []) {
    shape[field.name] = fieldSchema(field, `${spec.name}.${field.name}`, sink);
  }
  for (const child of stage?.children ?? []) {
    shape[child.name] = z.preprocess(recordList, z.array(recordSchema(child, sink))).optional().nullable();
  }
  const declared = Object.keys(shape);
  const object = z.object(shape).passthrough();
  if (declared.length === 0) return object;
  // A record made only of keys nothing declared has answered some other
  // question: every declared field would read null and the record would drop
  // in silence. It is a shape failure, and takes the retry.
  return object.superRefine((record, ctx) => {
    const keys = Object.keys(record);
    if (keys.length === 0 || keys.some((k) => declared.includes(k))) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `this record was answered under ${keys.map((k) => `\`${k}\``).join(', ')} — its fields are ${declared.map((k) => `\`${k}\``).join(', ')}`,
    });
  });
}

/** `extractOne`'s record as the model may have packaged it: the object asked
 *  for, or a list holding one (or none). A list of several stays a list, for
 *  the schema to refuse. */
function singleRecord(value: unknown): unknown {
  if (!Array.isArray(value) || value.length > 1) return value;
  return value.length === 0 ? null : value[0];
}

function responseSchema(spec: ExtractNodeSpec, sink: CoercionTracker, finds: ExtractCallFinds): z.ZodTypeAny {
  switch (finds) {
    case 'each':
      return z
        .object({ [ANSWER_KEY.each]: z.preprocess(recordList, z.array(recordSchema(spec, sink))) })
        .passthrough();
    case 'one': {
      // Several records where one was asked for is a malformed reply — the
      // author's claim that there is one is the model's to meet, not the
      // engine's to settle by picking — so it takes the retry, then fails.
      const one = z
        .unknown()
        .superRefine((value, ctx) => {
          if (!Array.isArray(value)) return;
          ctx.addIssue({
            code: 'custom',
            message: `${value.length} records were answered, and this asks for the single one — answer one object, or null`,
          });
        })
        .pipe(recordSchema(spec, sink).nullable());
      return z.object({ [ANSWER_KEY.one]: z.preprocess(singleRecord, one) }).passthrough();
    }
    default:
      return neverAsAny(finds);
  }
}

// ── The records ─────────────────────────────────────────────────────────────

/** What each nested edge of a record carries, so a write into it mints the
 *  shape's nested nodes as a write into a declared edge does. */
function landingShapeOf(spec: ExtractNodeSpec): LocalLandingShape {
  const stage = spec.stages[0];
  return {
    fields: (stage?.fields ?? []).map((f) => f.name),
    edges: Object.fromEntries((stage?.children ?? []).map((c) => [c.name, landingShapeOf(c)])),
  };
}

/** The fields a program reads as PRESENT text — plain text not marked
 *  `| null` — handed over as `""` when nothing was found. The checker's half is
 *  `readsAsPresentText`, as it is for the keyword's records. */
function readsAsPresentText(field: ExtractFieldSpec): boolean {
  return field.nullable !== true && (field.type === undefined || field.type === 'text');
}

type NodePosition = Extract<Binding, { kind: 'nodePosition' }>;

/** What the model answered with nothing in it, per node name, beside what the
 *  engine then dropped — the keyword's `empty` and `dropped`, so the run UI's
 *  tally reads the same on both paths. A fieldless-but-populated parent is
 *  empty yet survives on its children, which is why the two differ. */
interface RecordTallies {
  empty: Record<string, number>;
  dropped: Record<string, number>;
}

function isBlankFields(record: NodePosition, spec: ExtractNodeSpec): boolean {
  const fields = spec.stages[0]?.fields ?? [];
  return (
    fields.length > 0 &&
    fields.every((f) => {
      const value = record.fields[f.name];
      return value === null || value === undefined || value === '';
    })
  );
}

function isEmptyRecord(record: NodePosition, spec: ExtractNodeSpec): boolean {
  const stage = spec.stages[0];
  const fieldsBlank = (stage?.fields ?? []).every((f) => {
    const value = record.fields[f.name];
    return value === null || value === undefined || value === '';
  });
  const edgesEmpty = Object.values(record.edges).every(
    (edge) => edge.kind !== 'landed' || edge.landings.length === 0,
  );
  return fieldsBlank && edgesEmpty;
}

/** A record and its nested records as the trace's entity sample reads them. */
function treeOf(record: NodePosition, spec: ExtractNodeSpec): TracedTree {
  const children = new Map<string, TracedTree[]>();
  for (const child of spec.stages[0]?.children ?? []) {
    const edge = record.edges[child.name];
    if (edge?.kind !== 'landed') continue;
    const landed = edge.landings.filter((l): l is NodePosition => l.kind === 'nodePosition');
    children.set(child.name, landed.map((l) => treeOf(l, child)));
  }
  return { nodeName: spec.name, fields: record.fields, children };
}

function buildRecords(
  raw: unknown,
  spec: ExtractNodeSpec,
  site: ExtractSiteRef,
  items: ReadonlySet<number>,
  tallies: RecordTallies,
): NodePosition[] {
  const list = Array.isArray(raw) ? raw : [];
  const stage = spec.stages[0];
  const records: NodePosition[] = [];
  for (const entry of list) {
    if (!isPlainRecord(entry)) continue;
    const fields: Record<string, unknown> = {};
    const fieldProvenance: Record<string, Provenance> = {};
    for (const field of stage?.fields ?? []) {
      const answer = entry[field.name] as
        | { value?: unknown; evidence?: { item?: number; quote?: string } | null }
        | null
        | undefined;
      const value = field.type === 'json' ? (answer?.value ?? null) : absentIfBlank(answer?.value);
      fields[field.name] = value === null && readsAsPresentText(field) ? '' : value;
      const item = answer?.evidence?.item;
      const quote = answer?.evidence?.quote;
      fieldProvenance[field.name] = fromOrigin({
        kind: 'extraction',
        site,
        field: field.name,
        description: field.description,
        ...(quote !== undefined && quote !== '' ? { quote } : {}),
        // A citation of an item that was never shown is no citation.
        ...(item !== undefined && items.has(item) ? { item } : {}),
      });
    }
    const edges: NodePosition['edges'] = {};
    for (const child of stage?.children ?? []) {
      edges[child.name] = {
        kind: 'landed',
        landings: buildRecords(entry[child.name], child, site, items, tallies),
        landingShape: landingShapeOf(child),
      };
    }
    const record: NodePosition = {
      kind: 'nodePosition',
      fields,
      fieldOrder: (stage?.fields ?? []).map((f) => f.name),
      fieldProvenance,
      edges,
    };
    if (isBlankFields(record, spec)) tallies.empty[spec.name] = (tallies.empty[spec.name] ?? 0) + 1;
    if (isEmptyRecord(record, spec)) {
      tallies.dropped[spec.name] = (tallies.dropped[spec.name] ?? 0) + 1;
      continue;
    }
    records.push(record);
  }
  return records;
}

// ── The content ─────────────────────────────────────────────────────────────

/** One content item, ready to be a block. */
interface ContentItem {
  index: number;
  /** What the trace calls it. */
  classification: string;
  block: string;
  origin?: ProvenanceOrigin;
  file?: ExtractionTraceFile;
}

async function contentFile(ref: FileRef, runtime: ExtractCallRuntime): Promise<ContentFile> {
  const named = {
    ...(ref.name !== undefined ? { name: ref.name } : {}),
    ...(ref.contentType !== undefined ? { contentType: ref.contentType } : {}),
  };
  if (runtime.resolveFileText === undefined) return { traced: { ...named, unreadable: 'bytes_unavailable' } };
  const handle = fileHandle(ref);
  const key = handle ?? ref.name;
  const read = async (): Promise<ContentFile> => {
    const result = await runtime.resolveFileText!(ref);
    if (isFileUnreadable(result)) {
      return {
        traced: {
          ...named,
          unreadable: result.unreadable,
          ...(result.detail !== undefined ? { detail: result.detail } : {}),
        },
      };
    }
    if (result.text.trim() === '') return { traced: { ...named, unreadable: 'no_text' } };
    const bounded = boundFileText({ text: result.text, ref, run: runtime.run });
    return {
      text: bounded.content,
      origin: {
        kind: 'file',
        ...(result.rawTextId !== undefined ? { rawTextId: result.rawTextId } : {}),
        ...(handle !== undefined ? { handle } : {}),
        ...named,
      },
      traced: {
        ...named,
        chars: bounded.chars,
        ...(bounded.truncatedFrom !== undefined ? { truncatedFrom: bounded.truncatedFrom } : {}),
      },
    };
  };
  if (key === undefined) return read();
  const memo = runtime.state.files.get(key) ?? read();
  runtime.state.files.set(key, memo);
  return memo;
}

/**
 * The content list, one block per item, in order. An item's NUMBER is its
 * position in the list, so a citation means the same thing whatever was
 * skipped: an absent item has no block, and a file nothing could read says so
 * in its block rather than vanishing.
 */
async function contentItems(content: unknown, runtime: ExtractCallRuntime): Promise<ContentItem[]> {
  const list = Array.isArray(content) ? content : [content];
  const items: ContentItem[] = [];
  for (const [index, value] of list.entries()) {
    if (value === null || value === undefined) continue;
    if (isFileRef(value)) {
      const file = await contentFile(value, runtime);
      const label = `file${value.name !== undefined ? ` "${value.name}"` : ''}`;
      items.push({
        index,
        classification: `item ${index} (file)`,
        block: `## Content item ${index} (${label})\n${file.text ?? `[this file could not be read: ${'unreadable' in file.traced ? file.traced.unreadable : 'no_text'}]`}`,
        ...(file.origin !== undefined ? { origin: file.origin } : {}),
        file: file.traced,
      });
      continue;
    }
    if (bindingOf(value) !== undefined || isPlainRecord(value) || Array.isArray(value)) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `content item ${index} of 'extract' is a ${Array.isArray(value) ? 'list' : 'record'}, and 'extract' reads text and files — render it as text with TEXT.SERIALISE(value, 'JSON') (the checker should have caught this)`,
      );
    }
    const text = typeof value === 'string' ? value : String(value);
    if (text.trim() === '') continue;
    items.push({ index, classification: `item ${index} (text)`, block: `## Content item ${index} (text)\n${text}` });
  }
  return items;
}

// ── The call ────────────────────────────────────────────────────────────────

const TRACE_INPUT_PARTS = 12;
const TRACE_ISSUE_LINES = 8;

export interface ExtractCallInput {
  /** The content as evaluated: a list of text and files. */
  content: unknown;
  /** The content's own trail — the data sources every field cites. */
  contentProvenance: Provenance;
  /** The shape, as the spec its declaration builds. */
  spec: ExtractNodeSpec;
  /** `each` record the content names (`extract`), or the `one` it describes
   *  (`extractOne`). */
  finds: ExtractCallFinds;
  settings: ExtractionCallSettings;
  /** Unique within the run — the provenance site's id. */
  siteId: string;
  runtime: ExtractCallRuntime;
}

/** What the call hands back: the list of records for `extract`; for
 *  `extractOne` the record, or absent when there is none. */
function answerOf(landings: NodePosition[], finds: ExtractCallFinds): Binding {
  switch (finds) {
    case 'each':
      return { kind: 'positions', landings };
    case 'one':
      return landings[0] ?? { kind: 'value', value: null, provenance: NO_PROVENANCE };
    default:
      return neverAsAny(finds);
  }
}

/** Run one extraction call: the records found — a list of records, or the
 *  one record or absent. A reply that answers some other question is asked
 *  once more, then raised — what a caller does with a failure is the
 *  caller's (`MAP`'s `onError`). */
export async function runExtractCall(input: ExtractCallInput): Promise<Binding> {
  const { spec, settings, runtime, finds } = input;
  const items = await contentItems(input.content, runtime);
  const files = items.flatMap((item) => (item.file !== undefined ? [item.file] : []));
  const parts = items.map((item) => ({ classification: item.classification, chars: item.block.length }));
  const shape = {
    form: 'call' as const,
    node: spec.name,
    inputChars: parts.reduce((total, part) => total + part.chars, 0),
    ...(parts.length > 0 ? { inputs: parts.slice(0, TRACE_INPUT_PARTS) } : {}),
    ...(parts.length > TRACE_INPUT_PARTS ? { inputsTruncated: parts.length - TRACE_INPUT_PARTS } : {}),
    ...(files.length > 0 ? { files: files.slice(0, TRACE_INPUT_PARTS) } : {}),
    ...(files.length > TRACE_INPUT_PARTS ? { filesTruncated: files.length - TRACE_INPUT_PARTS } : {}),
  };
  if (items.length === 0) {
    // Nothing to read is nothing found — said on the run, not left to look
    // like a model that found nothing.
    runtime.trace?.push({ kind: 'extraction', ...shape, skipped: 'empty_source', emissions: { [spec.name]: 0 } });
    return answerOf([], finds);
  }

  const cacheKey = `${settings.model}|${settings.effort}`;
  const plan = runtime.state.prefixes.plan(cacheKey, items.map((item) => item.block));
  const breakpointAt = new Set(plan.breakpoints);
  const contentBlocks: ExtractCallBlock[] = items.map((item, position) => ({
    text: item.block,
    ...(breakpointAt.has(position) ? { cacheBreakpoint: true as const } : {}),
  }));
  const shown = new Set(items.map((item) => item.index));
  const guide = shapeBlock(spec, items.map((item) => item.index), finds);
  const site: ExtractSiteRef = {
    siteId: input.siteId,
    node: spec.name,
    description: spec.description,
    stage: 0,
    dataSources: [
      ...input.contentProvenance.origins,
      ...items.flatMap((item) => (item.origin !== undefined ? [item.origin] : [])),
    ],
  };

  const sink = new CoercionTracker();
  const schema = responseSchema(spec, sink, finds);
  const usage: ExtractCallUsage[] = [];
  let lastReply: ExtractCallLlmResult | undefined;
  const started = Date.now();
  // The reply is third-party content, so a run keeps only a few digests of it;
  // the budget is counted off the entries already on the run's trace.
  const digestOf = (why: Array<'no_entities' | 'dropped_records' | 'retried' | 'failed'>) => {
    const kept = (runtime.trace ?? []).filter((e) => e.kind === 'extraction' && e.reply).length;
    if (runtime.trace === undefined || kept >= TRACE_REPLY_DIGESTS) return {};
    const reply = replyDigest(lastReply, why);
    return reply ? { reply } : {};
  };
  const ask = async (last: string, label: string): Promise<ExtractCallLlmResult> => {
    await throwIfCancelled(runtime.run);
    const reply = await runtime.llm.call({
      system: EXTRACT_CALL_SYSTEM_PROMPT,
      blocks: [...contentBlocks, { text: last }],
      label,
      model: settings.model,
      effort: settings.effort,
      ...(settings.maxTokens !== undefined ? { maxTokens: settings.maxTokens } : {}),
    });
    if (reply.usage !== undefined) usage.push(reply.usage);
    lastReply = reply;
    return reply;
  };
  const telemetry = (): Pick<Extract<MovementTraceEntry, { kind: 'extraction' }>, 'model' | 'durationMs' | 'cache'> => ({
    model: settings.model,
    durationMs: Date.now() - started,
    cache: {
      breakpoints: plan.breakpoints.map((position) => items[position].index),
      sharedItems: plan.sharedItems,
      ...(usage.length > 0
        ? {
            inputTokens: usage.reduce((t, u) => t + u.inputTokens, 0),
            readTokens: usage.reduce((t, u) => t + u.cacheReadTokens, 0),
            writeTokens: usage.reduce((t, u) => t + u.cacheCreationTokens, 0),
          }
        : {}),
    },
  });

  const first = await ask(guide, 'movement_extract_call');
  sink.reset();
  let parsed = schema.safeParse(first.parsedJson);
  let retried: string[] | undefined;
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    retried = lines.slice(0, TRACE_ISSUE_LINES);
    // The content blocks are the same blocks, so the retry reads them from the
    // cache the first attempt wrote; only the last block says what was wrong.
    const retry = await ask(
      `${guide}\n\n---\n\nYour previous response had validation errors:\n${lines.join('\n')}\n\nReturn the complete corrected JSON, ${correctionLine(finds)}.`,
      'movement_extract_call_retry',
    );
    sink.reset();
    parsed = schema.safeParse(retry.parsedJson);
    if (!parsed.success) {
      runtime.trace?.push({
        kind: 'extraction',
        ...shape,
        emissions: { [spec.name]: 0 },
        failed: 'invalid_reply',
        retried,
        ...digestOf(['failed', 'retried']),
        ...telemetry(),
      });
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `The extraction of \`${spec.name}\` was answered with something its shape does not describe, twice: ${parsed.error.issues[0]?.path.join('.') || 'the reply'} — ${parsed.error.issues[0]?.message ?? 'unreadable'}.`,
        parsed.error,
      );
    }
  }
  const tallies: RecordTallies = { empty: {}, dropped: {} };
  // `extractOne`'s one record (or none) is a list of at most one from here
  // on, so a record with nothing in it drops by the same rule — and leaves
  // the reply on the trace — as one of `extract`'s does.
  const reply = (parsed.data as Record<string, unknown>)[ANSWER_KEY[finds]];
  const records = Array.isArray(reply) ? reply : reply == null ? [] : [reply];
  const answered = records.filter(isPlainRecord).length;
  const landings = buildRecords(records, spec, site, shown, tallies);
  const coerced = sink.snapshot();
  const why: Array<'no_entities' | 'dropped_records' | 'retried'> = [];
  if (answered === 0) why.push('no_entities');
  if (Object.keys(tallies.dropped).length > 0) why.push('dropped_records');
  if (retried !== undefined) why.push('retried');
  const traceMark = runtime.trace?.length ?? 0;
  runtime.trace?.push({
    kind: 'extraction',
    ...shape,
    emissions: { [spec.name]: answered },
    ...(retried !== undefined ? { retried } : {}),
    ...digestOf(why),
    ...(Object.keys(tallies.empty).length > 0 ? { empty: tallies.empty } : {}),
    ...(Object.keys(tallies.dropped).length > 0 ? { dropped: tallies.dropped } : {}),
    ...(coerced ? { coerced } : {}),
    ...telemetry(),
  });
  if (runtime.trace !== undefined) {
    // The keyword's tree has an unnamed root over its top-level records.
    recordExtractedEntities(runtime.trace, traceMark, {
      nodeName: 'extract result',
      fields: {},
      children: new Map([[spec.name, landings.map((record) => treeOf(record, spec))]]),
    });
  }
  return answerOf(landings, finds);
}

/** How many nodes a shape has — the density heuristic's input when no tier is
 *  named, as the keyword counts the sites of one call. */
export function countShapeNodes(spec: ExtractNodeSpec): number {
  return 1 + (spec.stages[0]?.children ?? []).reduce((total, child) => total + countShapeNodes(child), 0);
}
