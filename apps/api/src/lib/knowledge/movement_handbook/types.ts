import type { EngineClaim } from 'movement-engine/lib/handbook_section';

/** The hand-written chapters — a closed set, so a new one has to be
 *  registered before it can be referenced. */
export type ChapterId =
  | 'foundations'
  | 'anatomy'
  | 'expressions'
  | 'writes'
  | 'traversal'
  | 'extraction'
  | 'branching'
  | 'listeners'
  | 'reviews'
  | 'patterns'
  | 'use-cases'
  | 'runs'
  | 'reference'
  | 'builtins';

/** A chapter contributed by an adapter's manifest, namespaced by its slug so
 *  it can never collide with (or masquerade as) a hand-written chapter. */
export type SystemChapterId = `system:${string}`;

/** A chapter contributed by a plugin's manifest, namespaced by the name a
 *  program imports it under. A separate namespace from `system:`, because a
 *  plugin is a function an extraction calls, not a system to connect. */
export type PluginChapterId = `plugin:${string}`;

export type HandbookChapterId = ChapterId | SystemChapterId | PluginChapterId;

export type { EngineClaim };

export interface Chapter {
  id: HandbookChapterId;
  title: string;
  /** Full chapter body in formal-doc register:
   *  synopsis · the moves · worked example · common mistakes.
   *  Consumer-neutral: the same body serves the authoring agent and the
   *  editor's reference panel, so no tool names or agent-loop mechanics. */
  content: string;
  /** The chapter's engine-status claims, kept lockstep with the engine's
   *  own gate — see EngineClaim. */
  engineClaims?: EngineClaim[];
}

/** An index entry: a situation phrased as the author's likely intent,
 *  routing to a chapter (and optionally a fetchable section within it).
 *
 *  A hand-written chapter is still exhaustively checked — a typo in one is a
 *  type error — while a `system:…` chapter is reachable too, so the entry for
 *  "buttons in a chat message" can point at the system that actually carries
 *  the payload rather than only at the general chapter. */
export interface IntentEntry {
  intent: string;
  chapter: HandbookChapterId;
  section?: string;
}

/** The book: chapters, plus the routes into them. The model, the cardinal
 *  rule, and the conventions are not separate fields — they are the
 *  `foundations` chapter, which is also what the front matter is built from,
 *  so there is exactly one copy of each. */
export interface Handbook {
  intentIndex: IntentEntry[];
  /** The hand-written chapters plus every adapter-declared section. */
  chapters: Record<HandbookChapterId, Chapter>;
}
