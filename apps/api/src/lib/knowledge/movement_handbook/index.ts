// The automations handbook — chapters teaching the automation
// language AS AN AUTHOR. Mirrors the tg_handbook registry pattern:
// consumer-neutral chapter bodies (the same text serves the authoring
// agent's reference tool and, later, the editor's "?" panel) behind a
// thin index/lookup surface.
//
// Language spec: plans/2026-06-10-data-movement-language/3_syntax_sketch.md
// (surface), 1_principles.md (model), 6_engine.md (listen/run semantics).

import type {
  Handbook,
  ChapterId,
  Chapter,
  HandbookChapterId,
  IntentEntry,
  PluginChapterId,
  SystemChapterId,
} from './types';
import type { AdapterManifest } from '../../../services/translation_graph/adapter';
import type { PluginManifest } from '../../../services/translation_graph/engine/transforms/registry';

import { chapterRoute, sliceChapterSection } from '../../handbook_section';
import { listAdapterManifests } from '../../../services/translation_graph/adapters/registry';
import { foundations } from './chapters/foundations';
import { anatomy } from './chapters/anatomy';
import { expressions } from './chapters/expressions';
import { writes } from './chapters/writes';
import { traversal } from './chapters/traversal';
import { extraction } from './chapters/extraction';
import { branching } from './chapters/branching';
import { listeners } from './chapters/listeners';
import { asks as reviews } from './chapters/asks';
import { patterns } from './chapters/patterns';
import { useCases } from './chapters/use_cases';
import { runs } from './chapters/runs';
import { reference } from './chapters/reference';
import { builtins } from './chapters/builtins';

/**
 * `foundations#conventions` is a route the index serves and a section every
 * other chapter leans on instead of restating. It is addressed by heading, so
 * renaming the heading would silently unmake the route — checked at import,
 * where a rename fails loudly rather than at whichever fetch first misses.
 */
(function assertConventionsStaysFetchable() {
  const slice = sliceChapterSection(foundations.content, 'conventions');
  if (!slice.ok) {
    throw new Error(`foundations chapter no longer carries a conventions section: ${slice.error}`);
  }
})();

const INTENT_INDEX: IntentEntry[] = [
  { intent: 'What an automation is, the cardinal rule, reuse vs copy', chapter: 'foundations' },
  { intent: 'What a language version is; moving to the current one', chapter: 'foundations', section: 'language-versions' },
  { intent: 'Start a new automation from a brief', chapter: 'anatomy' },
  { intent: 'React to inbound email or a live event; name listeners', chapter: 'listeners', section: 'listen' },
  { intent: 'Create or update a record in another system', chapter: 'writes', section: 'writes' },
  { intent: 'Stop repeat events making duplicates', chapter: 'writes', section: 'identity' },
  { intent: 'Say if a record was created or updated', chapter: 'writes', section: 'what-the-write-did' },
  { intent: 'Set a field once, never overwrite', chapter: 'writes', section: 'set-if-empty' },
  { intent: 'Add to a multi-value field', chapter: 'writes', section: 'append-to-a-multi-value-field' },
  { intent: 'Find or update a record, never creating', chapter: 'writes', section: 'looking-up-existing-records' },
  { intent: 'Match a record by its identity', chapter: 'writes', section: 'match' },
  { intent: 'Remove a relationship or delete a record', chapter: 'writes', section: 'removal' },
  { intent: 'Create a child record under its parent', chapter: 'writes', section: 'linked-writes' },
  { intent: 'Post to a channel, or reply', chapter: 'writes', section: 'conversation-writes' },
  { intent: "Slack's message field, files, taps, Block Kit", chapter: 'system:slack' },
  { intent: "Telegram's message field, opening a chat, taps", chapter: 'system:telegram' },
  { intent: "WhatsApp's message field, files, taps", chapter: 'system:whatsapp' },
  { intent: 'A mailbox: run on arriving mail, search, send, reply', chapter: 'system:gmail' },
  { intent: 'Create a record with several parents', chapter: 'writes', section: 'multi-parent-writes' },
  { intent: 'Write a nested object or list', chapter: 'writes', section: 'structured-values' },
  { intent: 'Connect a record to one that already exists', chapter: 'writes', section: 'link' },
  { intent: 'Act per attachment or related record, collecting results', chapter: 'traversal', section: 'blocks' },
  { intent: 'Pull records out of text or documents', chapter: 'extraction', section: 'basics' },
  { intent: 'Dealflow mail and decks', chapter: 'use-cases', section: 'dealflow-extraction' },
  { intent: 'Extract records, write them connected', chapter: 'patterns', section: 'extract-and-connect' },
  { intent: 'Enrich extracted records with plugins, then merge', chapter: 'extraction', section: 'enrichment' },
  { intent: 'Load the links in a message', chapter: 'plugin:vc_url_retrieval' },
  { intent: 'What a person or company does, from a name or link', chapter: 'plugin:research' },
  { intent: 'Find a profile address from a name', chapter: 'plugin:research', section: 'what-comes-back' },
  { intent: 'Attach the source files to a written record', chapter: 'extraction', section: 'attaching-the-source-files' },
  { intent: 'Compute one value with judgement', chapter: 'expressions', section: 'ai' },
  { intent: "Today's date, the acting user, a record's owner", chapter: 'expressions', section: 'meta-fields' },
  { intent: 'Only act when a condition holds', chapter: 'branching', section: 'conditions' },
  { intent: 'Narrow a multi-kind source; stop a run', chapter: 'branching', section: 'narrowing' },
  { intent: 'Compose a message quoting earlier writes', chapter: 'expressions', section: 'interpolation' },
  { intent: 'Approve or decide before a write, then resume', chapter: 'reviews', section: 'delivering-and-awaiting' },
  { intent: 'Default or remind if nobody answers; defer', chapter: 'reviews', section: 'timeout-and-escalation' },
  { intent: 'One question to several places', chapter: 'reviews', section: 'several-at-once' },
  { intent: 'A chat button or link that acts and carries a value', chapter: 'reviews', section: 'in-chat-answers' },
  { intent: 'Intake pasted text or a file, reviewed', chapter: 'patterns', section: 'human-reviewed-intake' },
  { intent: 'Send one event to several systems', chapter: 'patterns', section: 'multi-target' },
  { intent: 'Compose a report as a PDF or text file', chapter: 'patterns', section: 'compose-a-report' },
  { intent: 'Scheduled digest: query, compose, post', chapter: 'patterns', section: 'scheduled-digest' },
  { intent: 'Handle a possibly absent field', chapter: 'expressions', section: 'values-that-may-not-be-there' },
  { intent: 'Group, transform, count or total a list', chapter: 'expressions', section: 'iterating-values' },
  { intent: 'Look a value up by name; build named values', chapter: 'expressions', section: 'keyed-values' },
  { intent: 'A report section per value of a type', chapter: 'patterns', section: 'sections-from-a-type' },
  { intent: 'Reuse one automation from another; return a result', chapter: 'anatomy', section: 'composition' },
  { intent: 'Walk a tree or chain by a function calling itself', chapter: 'anatomy', section: 'recursion' },
  { intent: 'Build a record in memory to pass along', chapter: 'anatomy', section: 'records-you-build' },
  { intent: 'Act on everything the run wrote', chapter: 'anatomy', section: 'collect-what-you-wrote' },
  { intent: 'Run ad hoc: pasted text, files, backfills', chapter: 'system:manual' },
  { intent: 'Run on a schedule', chapter: 'system:cron' },
  { intent: 'Run when another automation fails', chapter: 'system:system' },
  { intent: 'Store records in the graph; run on its changes', chapter: 'system:kg' },
  { intent: 'Query a graph: filter, order, take the top N', chapter: 'traversal', section: 'query-a-graph' },
  { intent: 'Relationship order; why a sort is refused', chapter: 'traversal', section: 'record-order' },
  { intent: 'Rehearse an automation before going live', chapter: 'anatomy', section: 'constructions' },
  { intent: 'See what a run did; trace where a value came from', chapter: 'runs', section: 'run-history' },
  { intent: 'What makes a run expensive, and how to cut it', chapter: 'runs', section: 'what-a-run-costs' },
  { intent: 'Operator spelling; when a name needs backticks', chapter: 'reference', section: 'operators-and-functions' },
  { intent: 'Write modifiers, unique-by forms, query clauses', chapter: 'reference', section: 'writes' },
  { intent: 'Common authoring mistakes', chapter: 'reference', section: 'pitfalls' },
];

const CHAPTERS: Record<ChapterId, Chapter> = {
  foundations,
  anatomy,
  expressions,
  writes,
  traversal,
  extraction,
  branching,
  listeners,
  reviews,
  patterns,
  'use-cases': useCases,
  runs,
  reference,
  builtins,
};

/**
 * The sections adapters declare on their manifests, as chapters.
 *
 * Pure over the manifests it is handed, so the guards that hold the
 * hand-written chapters — the prose contract, the engine-claims lockstep, the
 * checker validation — can be run over an arbitrary manifest rather than only
 * over whatever happens to be registered.
 */
export function adapterSectionChapters(manifests: readonly AdapterManifest[]): Chapter[] {
  return manifests.flatMap((manifest) => {
    const section = manifest.handbookSection;
    if (!section) return [];
    const id: SystemChapterId = `system:${manifest.adapterType}`;
    return [
      {
        id,
        title: section.title,
        content: section.content,
        ...(section.engineClaims ? { engineClaims: section.engineClaims } : {}),
      },
    ];
  });
}

/**
 * The sections plugins declare on their manifests, as chapters — the same
 * mechanism as `adapterSectionChapters`, in its own namespace because a plugin
 * is a function an extraction calls, not a system to connect.
 *
 * Keyed by the name a program imports the plugin under, so the route an author
 * is pointed at is spelled the way they write the call.
 */
export function pluginSectionChapters(manifests: readonly PluginManifest[]): Chapter[] {
  return manifests.flatMap((manifest) => {
    const section = manifest.handbookSection;
    if (!section) return [];
    const id: PluginChapterId = `plugin:${manifest.importName}`;
    return [
      {
        id,
        title: section.title,
        content: section.content,
        ...(section.engineClaims ? { engineClaims: section.engineClaims } : {}),
      },
    ];
  });
}

/** The bundled plugin manifests, required lazily: the plugin modules pull in
 *  the model and scraper service chain, which must not load merely because
 *  something imported the handbook. */
function bundledPluginManifests(): PluginManifest[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod =
    require('../../../services/translation_graph/engine/transforms/register-bundled') as typeof import('../../../services/translation_graph/engine/transforms/register-bundled');
  return mod.listPluginManifests();
}

/**
 * Built fresh per call, mirroring `getUsingListenFireHandbook()`: the hand-written
 * chapters, one chapter per adapter that declares a section, and one per
 * plugin that declares a section — so a system's or a plugin's conceptual
 * documentation is owned by the thing itself rather than by a second copy here
 * that drifts.
 */
export function getMovementHandbook(): Handbook {
  const chapters: Record<HandbookChapterId, Chapter> = { ...CHAPTERS };
  for (const section of adapterSectionChapters(listAdapterManifests())) {
    chapters[section.id] = section;
  }
  for (const section of pluginSectionChapters(bundledPluginManifests())) {
    chapters[section.id] = section;
  }
  return {
    intentIndex: INTENT_INDEX,
    chapters,
  };
}

export function renderMovementIndex(): string {
  const handbook = getMovementHandbook();
  const intents = handbook.intentIndex.map((e) => `- ${e.intent} → ${chapterRoute(e)}`).join('\n');
  const chapters = Object.values(handbook.chapters)
    .map((c) => `- ${c.id} — ${c.title}`)
    .join('\n');
  return `## Automation authoring handbook — index\n\nA route is a chapter, or \`chapter#section\` — one section of it, which is what to read when you need one rule.\n\nWhen you need to:\n${intents}\n\nChapters (read the relevant one before authoring):\n${chapters}`;
}

/**
 * A chapter, or one `### ` section of it — the unit the intent index points
 * at, so needing one rule costs one rule rather than a whole chapter.
 */
export function getMovementChapter(
  id: string,
  section?: string,
): { ok: true; content: string; section?: string } | { ok: false; error: string } {
  const chapters = getMovementHandbook().chapters;
  const chapter = (chapters as Record<string, Chapter | undefined>)[id];
  if (!chapter) {
    const available = Object.keys(chapters).join(', ');
    return {
      ok: false,
      error: `No chapter "${id}". Available: ${available}. Ask for the index (no chapter) to see all situations.`,
    };
  }
  if (section === undefined) return { ok: true, content: chapter.content };
  const slice = sliceChapterSection(chapter.content, section);
  if (!slice.ok) return { ok: false, error: `${slice.error} (chapter "${id}")` };
  return { ok: true, content: slice.content, section: slice.section };
}

/**
 * What a consumer is handed before it reads anything else: the model card,
 * then the routes. Foundations IS the front matter — one copy of the model,
 * the cardinal rule, and the conventions, whether it arrives here or as a
 * chapter fetch.
 */
export function buildMovementFrontMatter(): string {
  return `${foundations.content}\n\n${renderMovementIndex()}`;
}

/**
 * The portable authoring DOCTRINE — what an automation is, the cardinal
 * "write along edges, never flat rows" rule, the use-cases-first habit,
 * and factor-don't-copy — as one block, sourced from the readable
 * `foundations` chapter. This is the single source of truth: it feeds
 * both `readHandbook` / the Library page (as the chapter body) and the
 * authoring agent's system prompt (injected verbatim). Editing the
 * chapter updates both.
 *
 * Deploy-static: the chapter content is a module-level constant, so
 * callers can compute this once at module load and inject it into a
 * cached system block without introducing per-request variability.
 */
export function getMovementDoctrine(): string {
  return foundations.content;
}
