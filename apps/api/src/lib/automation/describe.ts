/**
 * Plain-English description of an automation — drives the headline at
 * the top of `/automations/[id]` and (eventually) row-level one-liners
 * in `/automations` and on the home page.
 *
 * Deterministic, no LLM: given the trigger row, produce a single
 * sentence the user can read without knowing what a "translation
 * graph" is. The headline names only the *source* — what kicks the
 * automation off:
 *
 *   "When an email arrives tagged `dealflow`."
 *   "When a Slack message arrives in #dealflow."
 *
 * The actions/destination deliberately don't appear here: the program
 * tree below the headline ("What happens") already lays those out
 * step by step, so repeating them in the sentence is noise. The
 * headline answers "what starts this?", the tree answers "then what?".
 *
 * If no actions have been defined yet we fall back to a calm "setup in
 * progress" sentence — the trigger exists but isn't wired to anything.
 *
 * Lives under `apps/api/src/lib/automation/` (sibling of `status.ts`)
 * so U3 (home dashboard) can reuse it for the activity feed and the
 * automations-row one-liner without re-deriving from raw JSONB.
 *
 */

import type { TranslationGraphRowBody } from 'movement-engine/services/translation_graph/types';

import { parseRowBodyLenient } from 'movement-engine/services/translation_graph/types';
import { getAdapterManifest } from '../../services/translation_graph/adapters/registry';
import { resolveEventPhrase } from '../../services/translation_graph/vocabulary';

// Input shape — what the view layer needs to hand us. Keeping it
// minimal (vs. taking the raw kysely rows) so unit tests stay easy
// and the caller decides what to pass.
export interface DescribeAutomationInput {
  trigger: {
    kind: string;
    config: unknown;
  };
  /**
   * Bound TG bodies — either already parsed via `parseRowBodyLenient`
   * or raw JSONB as read from the row. We only inspect whether any
   * body has roots (to distinguish a wired automation from an empty
   * placeholder); the sentence itself is source-only.
   */
  tgBodies: Array<TranslationGraphRowBody | unknown>;
}

/**
 * Render the one-sentence headline for an automation.
 *
 * Returns a string ready to drop into a heading; always ends in a
 * period; never throws on malformed inputs (best-effort parse,
 * fall back to the placeholder sentence).
 */
export function describeAutomation(input: DescribeAutomationInput): string {
  const parsedBodies = input.tgBodies
    .map((body) => (isTGRowBody(body) ? body : parseRowBodyLenient(body)))
    .filter((body): body is TranslationGraphRowBody => body !== null);

  const hasContent = parsedBodies.some((body) => body.roots.length > 0);
  if (!hasContent) {
    return 'Setup in progress. The automation is connected but its actions haven’t been defined yet.';
  }

  return `${describeSource(input.trigger.kind, input.trigger.config)}.`;
}

// ── Source ─────────────────────────────────────────────────────────────────

/**
 * "When an email arrives at <address>" / "When a Slack message
 * arrives in <channel>" / etc. The vocabulary here is the user
 * surface — we don't say "trigger" or "adapter".
 *
 * Adapter-owned: resolves the trigger `kind` to its adapter manifest and
 * renders that adapter's declared `vocabulary.eventPhrase` templates
 * (`services/translation_graph/vocabulary.ts`) against the trigger config.
 * This function names no adapter itself — a kind with no registered
 * manifest, or a manifest with no matching phrase, falls through to the one
 * generic composed sentence below.
 *
 */
export function describeSource(kind: string, config: unknown): string {
  // `trigger.kind` is either a legacy uppercase routing kind (`CUSTOM_EMAIL`,
  // `ATTIO`, …) or, for newer adapters, the adapter's own lowercase slug
  // directly (`email`, `whatsapp`, …) — try both so either form resolves.
  const manifest = getAdapterManifest(kind) ?? getAdapterManifest(kind.toLowerCase());
  const phrase = manifest ? resolveEventPhrase(manifest.vocabulary?.eventPhrase, config) : null;
  return phrase ?? LEGACY_KIND_PHRASES[kind.toUpperCase()] ?? `When a ${titleCase(kind)} event arrives`;
}

// Pre-adapter pipeline kinds with no owning manifest (the dealflow pipeline
// routes them, not the adapter registry). They stay centralised on purpose:
// there is no adapter to own the phrasing, and pulling them into movement-lang
// would invent one.
const LEGACY_KIND_PHRASES: Record<string, string> = {
  API: 'When the API is called',
  WEB_QUESTION: 'When data is submitted directly to Listen-Fire',
  CHROME_EXTENSION: 'When the Chrome extension captures content',
};

// ── Misc ───────────────────────────────────────────────────────────────────

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isTGRowBody(value: unknown): value is TranslationGraphRowBody {
  return (
    !!value &&
    typeof value === 'object' &&
    Array.isArray((value as { roots?: unknown }).roots) &&
    'targetSchemaRef' in value
  );
}
