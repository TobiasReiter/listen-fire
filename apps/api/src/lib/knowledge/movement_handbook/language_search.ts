// The language search — one lookup over everything an author might need
// beyond the front page: built-in functions, the ideas the front page
// introduces, recipes, and what each connected system and plugin documents.
//
// Nothing here is a second copy. A built-in's signature is GENERATED from the
// standard-library registry the checker resolves calls against, so a function
// added there is searchable the moment it exists; its worked example, where
// one is written, is read from that function's section of the builtins
// chapter. Recipes and system sections are read from their chapters at call
// time. Only the language's own control forms (`ERROR`, `race`, …), which are
// grammar rather than library, are written here — and their examples are
// probes the checker holds, like the front page's.
//
// Ranking is deliberately plain: shared words between the query and an
// entry's name, purpose and body, weighted in that order. Deterministic, and
// explainable from the entry itself.

import { getMovementHandbook } from './index';

import {
  describeFieldType,
  standardLibrary,
  type Builtin,
  type BuiltinParam,
} from 'movement-lang';

import type { Chapter, EngineClaim } from './types';

import { listChapterSections, sliceChapterSection } from '../../handbook_section';
import { exampleProgram, exampleText, frontEntries, type FrontExample } from './front_page';

export const LANGUAGE_SEARCH_KINDS = ['function', 'concept', 'recipe'] as const;
export type LanguageSearchKind = (typeof LANGUAGE_SEARCH_KINDS)[number];

/** What one result carries — enough to write the call, and where to read more. */
export interface LanguageEntry {
  name: string;
  kind: LanguageSearchKind;
  /** One line: what it is for. */
  purpose: string;
  /** A function's signature, or a concept's or recipe's short text. */
  detail: string;
  example?: string;
  /** A route `readHandbook` serves (`builtins#JOIN`, `front#identity`). */
  anchor?: string;
}

/** The most results one search hands back. */
export const MAX_RESULTS = 5;

// ── The language's control forms ────────────────────────────────────────────

interface ControlForm {
  name: string;
  signature: string;
  purpose: string;
  example: FrontExample;
  anchor: string;
}

/** Grammar, not library: the checker reads these as statements, so they are
 *  not in the standard-library registry and are described here instead. */
export const CONTROL_FORMS: readonly ControlForm[] = [
  {
    name: 'ERROR',
    signature: 'ERROR(reason: text)',
    purpose: 'fail the run, with a reason; there is no throw or try',
    example: { body: 'if m.Subject == "" { ERROR("the email has no subject") }' },
    anchor: 'front#errors-and-return',
  },
  {
    name: 'sleep',
    signature: 'await sleep(duration)  # 30s, 90m, 4h, 2d, 1h30m',
    purpose: 'pause the run for a while; a parked run costs nothing',
    example: { body: 'await sleep(1h)\nwrite crm-[:Companies]-> { unique by (Name), Name: m.Subject }' },
    anchor: 'front#runs',
  },
  {
    name: 'race',
    signature: 'await race([() => { … }, …]) → receipt; AT(r, i) is arm i\'s returned value, null unless it settled first',
    purpose: 'wait for whichever of several things happens first, such as an answer or a timeout',
    example: {
      body: 'q = write asks-[:Check]-> { Prompt: "Log ${m.Subject}?" }\nr = await race([\n  () => {\n    a = await FIRST(q-[:Response]->)\n    return a.Answer\n  },\n  () => { await sleep(2d) },\n])\napproved = AT(r, 0) == TRUE',
    },
    anchor: 'front#runs',
  },
  {
    name: 'parallel',
    signature: 'await parallel([() => { … }, …]) → receipt; AT(r, i) is arm i\'s returned value',
    purpose: 'run several independent pieces of work at once and wait for all of them',
    example: {
      body: 'r = await parallel([\n  () => { return UPPER(m.Subject) },\n  () => { return LOWER(m.Subject) },\n])\nboth = "${AT(r, 0)} / ${AT(r, 1)}"',
    },
    anchor: 'front#runs',
  },
  {
    name: 'callback',
    signature: 'callback({ … } | (value: <T>) => { … }, { once?: boolean, ttl?: duration }) → { id, url }',
    purpose: 'work a person triggers later from a button (its id) or a link (its url)',
    example: {
      body: 'q = write asks-[:Check]-> { Prompt: "Pursue ${m.Subject}?" }\nyes = callback({ write q-[:Response]-> { Answer: TRUE } })\nlinks = "${q.Url} or ${yes.url}"',
    },
    anchor: 'reviews#in-chat-answers',
  },
  {
    name: 'until',
    signature: 'await until(() => { … return condition }, every: duration)',
    purpose: 're-check a condition on a cadence and resume the run once it holds',
    example: {
      body: 'co = write crm-[:Companies]-> { unique by (Name), Name: m.Subject }\nawait until(() => {\n  refresh co\n  return co.Description != ""\n}, every: 1h)',
    },
    anchor: 'reviews#timeout-and-escalation',
  },
];

/** The control forms' examples, for the tests that hold every shown example. */
export function controlFormClaims(): EngineClaim[] {
  return CONTROL_FORMS.map((form) => ({
    construct: `language search: ${form.name}`,
    status: 'runs' as const,
    probe: exampleProgram(form.example),
  }));
}

// ── Building the index ──────────────────────────────────────────────────────

function describeParam(param: BuiltinParam): string {
  return `${param.rest ? '…' : ''}${param.name}${param.optional ? '?' : ''}: ${param.type}`;
}

/** `JOIN(collection: any, separator?: text) → text` — generated, never written. */
export function builtinSignature(entry: Builtin): string {
  const returns = entry.returns === 'derived' ? 'follows from its arguments' : describeFieldType(entry.returns);
  return `${entry.name}(${entry.params.map(describeParam).join(', ')}) → ${returns}`;
}

/** A built-in kept only so old automations still read — never offered. */
function isRetired(entry: Builtin): boolean {
  return entry.summary.startsWith('RETIRED');
}

/** The documented built-ins: every registry entry except the retired ones. */
export function searchableBuiltins(): Builtin[] {
  return standardLibrary().filter((entry) => !isRetired(entry));
}

/** Where a built-in that has no section of its own is explained. */
const BUILTIN_HOME: Record<string, string> = {
  EXTRACT: 'front#extraction',
  EXTRACTONE: 'front#extraction',
};

function firstCodeBlock(text: string): string | undefined {
  const m = /```\n?([\s\S]*?)```/.exec(text);
  return m ? m[1].trim() : undefined;
}

function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/^#{2,3} .*$/gm, ' ');
}

/** Prose cut to `words`, at a word boundary. */
function brief(text: string, words: number): string {
  const all = withoutCode(text).split(/\s+/).filter(Boolean);
  return all.length <= words ? all.join(' ') : `${all.slice(0, words).join(' ')} …`;
}

/** A section's prose split into its first sentence — its purpose line — and the rest. */
function splitFirstSentence(text: string): { first: string; rest: string } {
  const prose = withoutCode(text).trim();
  const m = /^[\s\S]*?[.!?](\s|$)/.exec(prose);
  const first = m ? m[0] : prose;
  return { first: brief(first, 25), rest: prose.slice(first.length) };
}

function builtinEntries(builtinsChapter: Chapter | undefined): LanguageEntry[] {
  const sections = new Set(builtinsChapter ? listChapterSections(builtinsChapter.content) : []);
  return searchableBuiltins().map((entry) => {
    const sectioned = sections.has(entry.name);
    const slice =
      sectioned && builtinsChapter ? sliceChapterSection(builtinsChapter.content, entry.name) : undefined;
    const example = slice?.ok ? firstCodeBlock(slice.content) : undefined;
    const anchor = sectioned ? `builtins#${entry.name}` : BUILTIN_HOME[entry.name];
    return {
      name: entry.name,
      kind: 'function' as const,
      purpose: entry.summary,
      detail: builtinSignature(entry),
      ...(example ? { example } : {}),
      ...(anchor ? { anchor } : {}),
    };
  });
}

function controlFormEntries(): LanguageEntry[] {
  return CONTROL_FORMS.map((form) => ({
    name: form.name,
    kind: 'function' as const,
    purpose: form.purpose,
    detail: form.signature,
    example: exampleText(form.example),
    anchor: form.anchor,
  }));
}

function conceptEntries(): LanguageEntry[] {
  return frontEntries().map((entry) => ({
    name: entry.title,
    kind: 'concept' as const,
    purpose: entry.title,
    detail: entry.text,
    ...(entry.example
      ? { example: exampleText(entry.example) }
      : {}),
    anchor: `front#${entry.anchor}`,
  }));
}

/** One entry per `###` section of a chapter (the whole chapter when it has none). */
function sectionEntries(chapter: Chapter, kind: LanguageSearchKind): LanguageEntry[] {
  const sections = listChapterSections(chapter.content).filter((id) => id.toLowerCase() !== 'pitfalls');
  if (sections.length === 0) {
    const example = firstCodeBlock(chapter.content);
    return [
      {
        name: chapter.id,
        kind,
        purpose: chapter.title,
        detail: brief(chapter.content.replace(/^## .*$/m, ''), 60),
        ...(example ? { example } : {}),
        anchor: chapter.id,
      },
    ];
  }
  return sections.flatMap((section) => {
    const slice = sliceChapterSection(chapter.content, section);
    if (!slice.ok) return [];
    const body = slice.content.replace(/^### .*$/m, '');
    const example = firstCodeBlock(body);
    const { first, rest } = splitFirstSentence(body);
    return [
      {
        name: `${chapter.id}#${slice.section}`,
        kind,
        purpose: first,
        detail: brief(rest, 50),
        ...(example ? { example } : {}),
        anchor: `${chapter.id}#${slice.section}`,
      },
    ];
  });
}

/** The chapters whose sections are whole worked recipes. */
const RECIPE_CHAPTERS = ['patterns', 'use-cases', 'reviews'] as const;

/** The whole index, built from its sources on every call — the manifests are
 *  registered at run time, and a search is cheap next to what it saves. */
export function languageIndex(): LanguageEntry[] {
  const chapters = getMovementHandbook().chapters as Record<string, Chapter | undefined>;
  const recipes = RECIPE_CHAPTERS.flatMap((id) => {
    const chapter = chapters[id];
    return chapter ? sectionEntries(chapter, 'recipe') : [];
  });
  const systems = Object.values(chapters).flatMap((chapter) => {
    if (!chapter) return [];
    if (chapter.id.startsWith('system:')) return sectionEntries(chapter, 'concept');
    if (chapter.id.startsWith('plugin:')) return sectionEntries(chapter, 'function');
    return [];
  });
  return [
    ...builtinEntries(chapters.builtins),
    ...controlFormEntries(),
    ...conceptEntries(),
    ...recipes,
    ...systems,
  ];
}

// ── Ranking ─────────────────────────────────────────────────────────────────

const STOPWORDS = new Set(
  'a an the to of or and in on for with by is it its from into as at be i how do does what my me this that when each can get use using want'.split(' '),
);

/** A word reduced to a rough stem, so "records", "recorded" and "record" meet. */
function stem(word: string): string {
  const cut = word.replace(/(ing|ed|es|s|e)$/, '');
  return cut.length >= 3 ? cut : word;
}

export function searchTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w))
    .map(stem);
}

/** How well `entry` answers `query`: name words count most, then purpose, then body. */
export function scoreEntry(entry: LanguageEntry, query: string): number {
  const wanted = [...new Set(searchTokens(query))];
  if (wanted.length === 0) return 0;
  // A family's namespace (`TEXT.`, `DATE.`) is where a function lives, not
  // what it does, so it counts as body: "join text" means JOIN, not every
  // TEXT.* member.
  const dot = entry.kind === 'function' ? entry.name.lastIndexOf('.') : -1;
  const name = new Set(searchTokens(entry.name.slice(dot + 1)));
  const purpose = new Set(searchTokens(entry.purpose));
  const body = new Set(searchTokens(`${entry.name.slice(0, Math.max(dot, 0))} ${entry.detail} ${entry.example ?? ''}`));
  let score = 0;
  for (const word of wanted) {
    if (name.has(word)) score += 5;
    if (purpose.has(word)) score += 3;
    if (body.has(word)) score += 1;
  }
  const folded = query.trim().toLowerCase();
  if (folded === entry.name.toLowerCase() || folded === entry.name.toLowerCase().split('.').pop()) score += 20;
  return score;
}

export interface LanguageSearchResult {
  query: string;
  results: LanguageEntry[];
  note: string;
}

/** The best few entries for `query`, optionally of one kind. */
export function searchLanguage(input: { query: string; kind?: LanguageSearchKind }): LanguageSearchResult {
  const scored = languageIndex()
    .filter((entry) => input.kind === undefined || entry.kind === input.kind)
    .map((entry, order) => ({ entry, order, score: scoreEntry(entry, input.query) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_RESULTS);
  return {
    query: input.query,
    results: scored.map((s) => s.entry),
    note:
      scored.length > 0
        ? 'readHandbook with a result\'s anchor as the chapter reads it in full.'
        : 'Nothing matched. Try the words a built-in\'s purpose would use ("join text", "first member"), a system\'s name, or a concept ("identity", "absent").',
  };
}
