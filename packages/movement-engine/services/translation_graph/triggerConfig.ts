// Config blocks — the declarative, host-rendered configuration UI an
// adapter publishes. A `ConfigBlock` is a closed, kind-discriminated union;
// the host (editor, listener-readonly view, chat) walks the list and renders
// each block by its `kind` with ZERO per-adapter UI hardcoding. This is the
// single declaration surface for an adapter's config UI — the generalisation
// of the former `TriggerConfigField[]` from "a flat list of value fields for
// the trigger role" to "an ordered list of blocks (some collect values, some
// present text, some dispatch actions)".
//
// We WIDEN one pipeline, we do not add a fourth mechanism:
//   - declared by the adapter (`AdapterManifest.triggerConfig`),
//   - a discriminated union on `kind`,
//   - carried to the host via tRPC (`views.triggers.getTriggerConfig`),
//   - rendered by a host that branches only on `kind`,
//   - validated server-side from the same declaration (`zodFromConfigBlocks`).
//
// NON-BREAKING: `TriggerConfigField` survives as a type ALIAS of the
// value-block subset (`input`/`slug`/`select`). Every existing declaration and
// reader keeps compiling; `zodFromTriggerConfigFields` keeps its name and
// delegates to `zodFromConfigBlocks`. The block `kind` discriminant stays the
// one the value fields already used (`text`/`slug`/`select`), so old code that
// branches on `field.kind` is untouched; the two new arms add `'section'` and
// `'action'`.
//
// Vocabulary naming note: the design docs sketch a `type` discriminant; we
// keep `kind` so the widening is a pure superset of the existing union (no
// rename churn, the discriminant keeps doing all the branching). `kind` is
// internal vocabulary — never a rendered string (Principle 6).
//
// Kept free of any import from `./adapter` so the interface can import the
// type without a cycle.

import { z } from 'zod';

import { neverAsAny } from '../../lib/utils/types';

/**
 * Plus-address / routing-key charset: lowercase alphanumerics in
 * hyphen-separated runs. Matches the output of the setup agent's
 * `slugifyForActivation`, so a hand-edited slug round-trips through the
 * same inbound-routing lookup an agent-minted one does.
 */
export const TRIGGER_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ── Value blocks ────────────────────────────────────────────────────────────
// Collect a value, carry a `key` — the binding to a config slot. The block IS
// the field IS the value slot (Principle 3): the same object the host renders
// is the one the validator reads and the one that names where the value
// persists (`trigger.config[key]`).

/**
 * Free-text / slug value collection. `input` and `slug` share a field set and
 * differ only in validation — `slug` enforces {@link TRIGGER_SLUG_PATTERN}.
 * They stay one arm (distinguished by the legacy `'text' | 'slug'` kind) so
 * the non-breaking alias is exact; the validator branches on `kind`.
 *
 *   - `text` — free text
 *   - `slug` — text constrained to {@link TRIGGER_SLUG_PATTERN}; may carry
 *              `prefix`/`suffix` the UI shows around the input (the local
 *              part and the domain of the deployment's own inbound address) so
 *              the user reads the whole address while editing
 *              only the variable part
 */
export interface TextBlock {
  kind: 'text' | 'slug';
  /** Key under `trigger.config` this block reads/writes. */
  key: string;
  /** User-facing label. No substrate jargon. */
  label: string;
  help?: string;
  placeholder?: string;
  /** Static text shown immediately before the input (display only). */
  prefix?: string;
  /** Static text shown immediately after the input (display only). */
  suffix?: string;
  required?: boolean;
  min?: number;
  max?: number;
  /**
   * Marks this value as a routing key that must be unique across sibling
   * triggers of the same adapter on the team. The engine enforces it on write
   * (an adapter can't see other triggers); the adapter only declares intent.
   */
  unique?: boolean;
  /**
   * Marks this block as the adapter's INBOUND ROUTING KEY — the config value an
   * inbound event is matched against to find the trigger that owns it. The
   * de-named successor to the former `inboundChannel: 'forwarding-address'`
   * flag: an adapter that declares a routing-key block is one whose events
   * arrive addressed by that key (email's plus-suffix `key`), and the framework
   * routes generically off the declaration — no named "forwarding address"
   * concept in the engine.
   *
   * Drives, all off this one declaration:
   *   - the listen-config vocabulary (`triggerConfigVocabulary` projects the
   *     key into the `listen to <instance> { … }` accepted keys);
   *   - inbound dispatch (`findTriggerByInboundKey` matches an inbound event's
   *     key against `config->><key>`);
   *   - the surfaced inbound ADDRESS, when the block carries `prefix`/`suffix`
   *     (`prefix + value + suffix`, e.g. `<local>+<value>@<domain>`).
   *
   * At most one block per adapter should carry this.
   */
  routingKey?: boolean;
}

/** One-of-a-fixed-set value collection. */
export interface SelectBlock {
  kind: 'select';
  key: string;
  label: string;
  help?: string;
  required?: boolean;
  options: ReadonlyArray<{ value: string; label: string }>;
}

// ── Presentation blocks ─────────────────────────────────────────────────────

/**
 * Presentational — a `title` and/or `text` body, optional `tone`. Carries no
 * `key` and collects nothing. This is what lets a rich config (the
 * forwarding-address UI) read as framing prose plus a field, rather than text
 * subordinated to a single input's `help`. The minimum presentational
 * primitive — no divider/image/link until a real need appears.
 */
export interface SectionBlock {
  kind: 'section';
  title?: string;
  text?: string;
  /** Styling hint — `'info'` (framing prose) or `'note'` (a quieter aside). */
  tone?: 'info' | 'note';
}

// ── Action blocks ───────────────────────────────────────────────────────────

/**
 * Dispatches to an APP-SHIPPED handler by `kind`, rendering `label` (and an
 * optional `help` line). Carries no value. This IS the former `ConnectAction`
 * (`{ kind, label }`) promoted into the block union: when the host renders an
 * action block it wires the affordance to `runConnectAction(kind, ctx)` — the
 * exact same registry dispatch the editor and chat use today. Declaration is
 * portable (any adapter, local or remote); behaviour is app-shipped (Principle
 * 5), so a remote adapter may only reference a `kind` the app already ships.
 */
export interface ActionBlock {
  kind: 'action';
  /** App-shipped client handler id, e.g. `'google-drive-picker'`. The
   *  framework never interprets this — the host routes it to its handler
   *  registry. */
  actionKind: string;
  /** Button / affordance text shown to the author. No internal jargon. */
  label: string;
  help?: string;
}

/**
 * The closed config-block union. Three families:
 *   - VALUE blocks ({@link TextBlock} `text`/`slug`, {@link SelectBlock}) —
 *     collect a value, carry a `key`;
 *   - PRESENTATION blocks ({@link SectionBlock}) — render text, no `key`;
 *   - ACTION blocks ({@link ActionBlock}) — dispatch to an app handler, no `key`.
 *
 * Discriminated on `kind`; the host's only branching is on `block.kind`. An
 * adapter cannot invent a rendered widget — it composes from this vocabulary.
 */
export type ConfigBlock = TextBlock | SelectBlock | SectionBlock | ActionBlock;

/**
 * The VALUE-block subset of {@link ConfigBlock} — the blocks that carry a
 * `key` and collect a value. This is exactly the former trigger-config field
 * union, so {@link TriggerConfigField} aliases it: every existing declaration
 * and reader (which branch on `kind === 'select'` / `'slug'` / `'text'`) keeps
 * compiling unchanged.
 */
export type ValueBlock = TextBlock | SelectBlock;

/**
 * @deprecated Prefer {@link ValueBlock} / {@link ConfigBlock}. Retained as the
 * non-breaking alias for the value-block subset so the widening is a pure
 * superset — existing `triggerConfigSchema` declarations are already valid
 * value blocks.
 */
export type TriggerConfigField = ValueBlock;

/** Narrow a {@link ConfigBlock} to a value block (carries a `key`). */
export function isValueBlock(block: ConfigBlock): block is ValueBlock {
  return block.kind === 'text' || block.kind === 'slug' || block.kind === 'select';
}

// ── Validation ──────────────────────────────────────────────────────────────

function zodForValueBlock(block: ValueBlock): z.ZodTypeAny {
  if (block.kind === 'select') {
    const values = block.options.map((o) => o.value);
    const base =
      values.length > 0
        ? z.enum(values as [string, ...string[]])
        : z.string();
    return block.required ? base : base.optional();
  }

  let str = z.string();
  if (block.kind === 'slug') {
    str = str.regex(
      TRIGGER_SLUG_PATTERN,
      'Use lowercase letters, numbers, and hyphens only.',
    );
  }
  if (typeof block.min === 'number') {
    str = str.min(block.min, `Must be at least ${block.min} character(s).`);
  }
  if (typeof block.max === 'number') {
    str = str.max(block.max, `Must be at most ${block.max} character(s).`);
  }
  if (block.required) {
    // A required text/slug block rejects empty/whitespace-only input even
    // when no explicit `min` is set.
    return str.min(block.min ?? 1, 'This field is required.');
  }
  return str.optional();
}

/**
 * Build a Zod object validating the editable subset of `trigger.config`
 * described by `blocks`. Walks only VALUE blocks; presentation (`section`) and
 * action (`action`) blocks have no `key` and nothing to validate, so they are
 * skipped exhaustively. Unknown keys are stripped (not rejected), so the same
 * schema can validate a whole `trigger.config` that also carries structural
 * keys the form doesn't manage (e.g. `destination`).
 */
export function zodFromConfigBlocks(
  blocks: readonly ConfigBlock[],
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const block of blocks) {
    switch (block.kind) {
      case 'text':
      case 'slug':
      case 'select':
        shape[block.key] = zodForValueBlock(block);
        break;
      case 'section':
      case 'action':
        // No `key`, nothing to validate.
        break;
      default:
        neverAsAny(block);
    }
  }
  return z.object(shape);
}

/**
 * @deprecated Prefer {@link zodFromConfigBlocks}. Retained so existing callers
 * keep compiling; delegates to the block-walking builder (value blocks are a
 * subset of config blocks, so this is a no-op widening).
 */
export function zodFromTriggerConfigFields(
  fields: readonly TriggerConfigField[],
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  return zodFromConfigBlocks(fields);
}

/** First human-readable message from a Zod error, for surfacing in tRPC. */
export function firstTriggerConfigError(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Invalid configuration.';
}
