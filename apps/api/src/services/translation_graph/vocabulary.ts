// Adapter-blind resolver for `AdapterManifest.vocabulary.eventPhrase` — pure
// string substitution against trigger/listen config, never adapter-specific
// interpretation. This is the ONE place that fills in an adapter's declared
// `{slot}` templates; callers (the automation describer, and eventually the
// movement renderer) never branch on an adapter slug themselves.

import type { AdapterEventPhraseVocabulary, EventPhraseTemplate } from 'movement-engine/public/adapter';

/**
 * Render an adapter's declared event phrasing against its trigger/listen
 * config. Tries the config's own `events` selection (if any) against the
 * matching per-event template lists first, then falls back to `default`.
 * Returns null when the adapter declares no `eventPhrase` vocabulary, or
 * declares some but nothing renders (every candidate's slots stayed
 * unresolved) — callers fall back to a generic composed phrase.
 */
export function resolveEventPhrase(
  eventPhrase: AdapterEventPhraseVocabulary | undefined,
  config: unknown,
): string | null {
  if (!eventPhrase) return null;
  const cfg = config && typeof config === 'object' ? (config as Record<string, unknown>) : {};

  for (const eventName of configuredEvents(cfg)) {
    const rendered = renderFirstMatch(eventPhrase[eventName], cfg);
    if (rendered !== null) return rendered;
  }
  return renderFirstMatch(eventPhrase.default, cfg);
}

/** The `events` selection carried on trigger/listen config, if any — the
 *  same array a `listen to <adapter> { events: […] }` config persists. */
function configuredEvents(cfg: Record<string, unknown>): string[] {
  const events = cfg.events;
  return Array.isArray(events) ? events.filter((e): e is string => typeof e === 'string') : [];
}

/** First template in the ordered list whose `{slot}` tokens all resolve
 *  against `cfg`, or null when none do (or the list is absent/empty). */
function renderFirstMatch(
  templates: readonly EventPhraseTemplate[] | undefined,
  cfg: Record<string, unknown>,
): string | null {
  for (const { template } of templates ?? []) {
    const rendered = fillTemplate(template, cfg);
    if (rendered !== null) return rendered;
  }
  return null;
}

/** Fill `{slot}` tokens from `cfg`; null when any slot has no non-empty
 *  string value (the template is not a match, not a partial render). */
function fillTemplate(template: string, cfg: Record<string, unknown>): string | null {
  let unresolved = false;
  const rendered = template.replace(/\{(\w+)\}/g, (_match, slot: string) => {
    const value = cfg[slot];
    if (typeof value !== 'string' || value.length === 0) {
      unresolved = true;
      return '';
    }
    return value;
  });
  return unresolved ? null : rendered;
}
