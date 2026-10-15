// The prose contract every chapter is held to — hand-written, or contributed
// by an adapter's manifest. ONE implementation, so a rule can never apply to
// the chapters someone remembered to list and quietly skip the generated ones;
// and callable, so a section that breaks the contract can be shown to be
// caught rather than assumed to be.

import type { Chapter } from '../types';

/** Names of the authoring affordances — mechanics of one consumer's loop, so
 *  never in prose two consumers read. */
const AUTHORING_TOOL_NAMES = [
  'getStarted',
  'readHandbook',
  'listConnections',
  'describeConnection',
  'connectSystem',
  'grantAccess',
  'validateAutomation',
  'upgradeAutomation',
  'saveAutomation',
  'listAutomations',
  'getAutomation',
  'runAutomation',
  'checkRun',
  'listReviews',
  'submitReview',
  'searchLanguage',
];

/** Retired constructs from earlier syntax rounds — none may be taught. */
const RETIRED_SURFACE: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /EXTRACT_VALUE/, label: 'EXTRACT_VALUE' },
  { pattern: /#extract/, label: '#extract' },
  { pattern: /\bfor each\b/, label: 'for each' },
];

/**
 * Forms that still run but are not the ones to write. The handbook documents
 * only what is recommended — every word is read on every build — so none of
 * these may appear anywhere in a chapter, code fences included. Each pattern
 * is anchored on the form's own syntax, so the modern spelling beside it never
 * trips it: `node Company {` declares (only `node {` builds), `extract(` is the
 * call (only `extract … from` is the keyword).
 */
const NOT_RECOMMENDED: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern: /\bextract\s+(?:"\w+"\s+|'\w+'\s+)?from\b/,
    label: 'the `extract … from` keyword — write `extract(content, Shape, settings)`',
  },
  {
    pattern: /\blazy\b/i,
    label: 'the `lazy` keyword — wrap the walk in a closure (`files = () => m-[:Attachments]->`, called as `files()`) or write it inline where it is read',
  },
  {
    pattern: /\bthrough\s*\[/,
    label: 'a `through [ … ]` extraction stage — call the plugin, then extract again',
  },
  {
    pattern: /\bnode\s*\{/,
    label: 'the anonymous `node { … }` literal — build with `graph<Shape> { … }`',
  },
  {
    pattern: /\bmovement\s+(?:`[^`\n]+`|[A-Za-z_]\w*)\s*\(/,
    label: 'a `movement` declaration — declare with `function`',
  },
  { pattern: /\bONLY\(\s*extract\(/i, label: '`ONLY(extract(…))` — write `extractOne(…)`' },
  { pattern: /\b(?:parallel|race)\s*\{/, label: 'a `parallel { … }` / `race { … }` block — write `all(f, g)` / `race(f, g)`' },
  { pattern: /\bparallel\s*\(/, label: '`parallel(…)` — write `all(f, g)`' },
  { pattern: /\b(?:race|all)\s*\(\s*\[/, label: 'a combinator over a list — pass the arms as arguments: `race(f, g)`' },
  { pattern: /\bawait\s+(?:race|all)\s*\(/, label: '`await` on a combinator — write `race(f, g)`; the wait is the `await` inside an arm' },
  { pattern: /\b(?:mailgun|resend)\(\)/, label: 'a mail carrier alias — construct `email()`' },
  {
    pattern: /\b(?:not recommended|supported,? but|older (?:form|spelling|literal|keyword|syntax)s?|still supported|legacy)\b/i,
    label: 'a passage about a non-recommended form',
  },
];

/** A call that names its argument (`f(x: …)`) where positional is the form:
 *  a backticked function name, or a bare one this chapter declares with
 *  `function`. A parameter list is not a call (its colon is followed by a
 *  type, `<…>`), and adapter constructions and plugins — whose arguments are
 *  named by design — are neither backticked nor declared in a chapter. */
function namedArgumentCalls(content: string): string[] {
  const named = /\(\s*[A-Za-z_]\w*\s*:(?!\s*<)/.source;
  const found = [...content.matchAll(new RegExp(`\`[^\`\\n]+\`${named}`, 'g'))].map((m) => m[0]);
  const declared = [...content.matchAll(/\bfunction\s+([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]);
  for (const name of new Set(declared)) {
    const call = new RegExp(`(?<!function\\s+)\\b${name}${named}`, 'gi');
    found.push(...[...content.matchAll(call)].map((m) => m[0]));
  }
  return found;
}

const VC_TUNING =
  /\b(founders?|investors?|dealflow|deal ?flow|pre-seed|seed round|funding round|series [abc]\b|term sheets?|cap tables?|portfolio compan|fundrais|venture capital)\b/i;

const INTERNAL_JARGON: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bTG\b/, label: 'TG' },
  { pattern: /\bKG\b/, label: 'KG' },
  { pattern: /schemaRef/, label: 'schemaRef' },
];

/** Prose with code fences and inline code removed — the vocabulary rules are
 *  about what the sentences say, not about the identifiers they quote. */
function proseOnly(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
}

/**
 * Every way `chapter` breaks the contract, named. Empty means it holds.
 *
 * `agentFacing` is for the one page that is served only to an authoring agent
 * (the handbook's front page): it may name the tools of that agent's
 * loop, and is held to everything else.
 */
export function proseViolations(chapter: Chapter, options: { agentFacing?: boolean } = {}): string[] {
  const violations: string[] = [];
  const body = `${chapter.title}\n${chapter.content}`;

  for (const { pattern, label } of RETIRED_SURFACE) {
    if (pattern.test(chapter.content)) violations.push(`teaches the retired \`${label}\``);
  }
  for (const { pattern, label } of NOT_RECOMMENDED) {
    const hit = pattern.exec(chapter.content);
    if (hit) violations.push(`teaches ${label}: "${hit[0]}"`);
  }
  for (const call of namedArgumentCalls(chapter.content)) {
    violations.push(`calls a function with a named argument — pass it positionally: "${call}"`);
  }
  for (const tool of options.agentFacing ? [] : AUTHORING_TOOL_NAMES) {
    if (chapter.content.includes(tool)) violations.push(`leaks the tool name \`${tool}\``);
  }
  for (const { pattern, label } of INTERNAL_JARGON) {
    if (pattern.test(chapter.content)) violations.push(`uses the internal shorthand \`${label}\``);
  }
  // The use-cases chapter is, by design, a per-use-case playbook; the dealflow
  // playbook is dealflow-specific on purpose. Every other chapter — a system's
  // section included — must stay use-case-neutral.
  if (((chapter.content.match(/```/g) ?? []).length % 2) !== 0) {
    violations.push('leaves a code fence unclosed');
  }
  if (chapter.id !== 'use-cases') {
    const vc = VC_TUNING.exec(proseOnly(chapter.content));
    if (vc) violations.push(`is tuned to one use case: "${vc[0]}"`);
  }
  const prose = proseOnly(body);
  if (/\bmovements?\b/i.test(prose)) violations.push('says "movement" outside code');
  if (/\basks?\b/i.test(prose)) violations.push('says "ask" outside code');

  return violations;
}
