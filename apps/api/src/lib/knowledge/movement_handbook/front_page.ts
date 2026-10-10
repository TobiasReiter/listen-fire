// The front page — the one page an authoring agent on the automations
// connector reads. It is not a lesson in the language: an agent already writes
// TypeScript, so the page names only the places that prior pulls the wrong
// way, then the few ideas TypeScript has no word for, then the build loop.
// Everything else (a built-in's signature, a system's behaviour, a recipe) is
// looked up on demand through the language search.
//
// Every example on the page is the probe the tests hand to the real checker
// and the engine's interpretability scan: the shown text and the checked text
// are one string, so the page cannot teach something that does not compile.
//
// Plan: plans/functional-extract-2026-10-02/3_docs_and_evals.md.

import type { EngineClaim } from './types';

/** One addressable entry: `front#<anchor>` reads it alone. */
export interface FrontEntry {
  anchor: string;
  title: string;
  text: string;
  /** Shown under the text, and checked. */
  example?: FrontExample;
}

/**
 * How an example becomes a whole program: a `body` sits inside a function
 * that receives an email; a `program` stands at the top level (declarations,
 * listeners). Either way the shared prelude constructs the systems it names.
 * A `file` is a whole program as shown, imports and all — the one way the page
 * can show the lines every other example takes for granted.
 */
export type FrontExample = { body: string } | { program: string } | { file: string };

/** The text an example shows. */
export function exampleText(example: FrontExample): string {
  if ('body' in example) return example.body;
  if ('program' in example) return example.program;
  return example.file;
}

const PRELUDE = `import { email, attio, slack, ask } from adapters
import { acme, team_chat } from credentials

inbox = email()
crm   = attio(credentials: acme)
chat  = slack(credentials: team_chat)
asks  = ask()
`;

/** Where a TypeScript habit is wrong here. Each claim was tried against the
 *  parser and checker when written; the examples stay checked by the tests. */
export const TS_EXCEPT: readonly FrontEntry[] = [
  {
    anchor: 'statements',
    title: 'Statements',
    text: 'Comments start with `#`; no semicolons. A name is bound once, `name = value`, with no `let` or `const`.',
  },
  {
    anchor: 'operators',
    title: 'Operators',
    text: '`==` and `!=` compare (no `===`). Logic is `AND`, `OR`, `NOT` (no `&&`, `||`). `IF c THEN a ELSE b END` replaces `? :`; statements branch with `if c { … } else { … }`.',
  },
  {
    anchor: 'strings-and-names',
    title: 'Strings and names',
    text: 'Strings are `"…"` or `\'…\'`, interpolating `${…}`. Backticks are not strings: they quote a name with spaces. `+` only adds numbers.',
    example: { body: 'line = "From ${m.From}: ${m.`Plain Body`}"' },
  },
  {
    anchor: 'types',
    title: 'Types',
    text: 'A type wears angle brackets: `<text>`, `<number>`, `<boolean>`, `<date>`, `<file>`, `<Lead>`, `<inbox-[:Email]->>`. A closure parameter needs one unless a built-in supplies it: `(n: <number>) => n * 2`.',
  },
  {
    anchor: 'functions-not-methods',
    title: 'Functions, not methods',
    text: 'No methods and no `[i]`: `UPPER(s)`, `LENGTH(xs)`, `AT(list, 0)`. Function names ignore letter case.',
    example: { body: 'words = length(SPLIT(TRIM(m.Subject), " "))' },
  },
  {
    anchor: 'calls',
    title: 'Calls',
    text: 'Arguments go data first, then one settings record, then a function. Write your own functions the same way.',
  },
  {
    anchor: 'no-loops',
    title: 'No loops',
    text: 'No `for` or `while`. A block after a path runs once per record reached, and collects what it `return`s. `MAP`, `FILTER` and `REDUCE` iterate lists.',
    example: { body: 'names = m-[a:Attachments]-> { return a.Name }\nlisted = JOIN(names, ", ")' },
  },
  {
    anchor: 'maybe-absent',
    title: 'Absent, not undefined',
    text: 'No `undefined`, `??` or `?.`. What might not be there (`FIRST`, `ONLY`, `AT`, `extractOne`, a named `match`) is `T | absent`, refused where a value is required until narrowed: `if x == null { ERROR("…") }`, `EXISTS(x)`, `COALESCE(x, fallback)`, or `Field ?: x` in a write.',
    example: {
      body: 'co = ONLY(crm-[c:Companies WHERE Name == m.Subject]->)\nif co == null { ERROR("no company ${m.Subject}") }\nseen = match crm-[:People]-> { unique by (Email), Email: m.From }\nif seen != null { link seen -[:Company]-> co }',
    },
  },
  {
    anchor: 'errors-and-return',
    title: 'Errors and return',
    text: '`ERROR("reason")` fails the run; no `throw` or `try`. `return` always hands back a value.',
  },
  {
    anchor: 'immutable-values',
    title: 'Only the graph changes',
    text: 'Values never change (no `x.field = …`); build a record with `graph<Shape> { … }`. Systems change only through `write`, `link`, `unlink`, `delete`.',
    example: {
      program: 'node Lead {\n  Name: <text>\n}\nfunction `Lead Of`(m: <inbox-[:Email]->>) {\n  return graph<Lead> { Name: m.From }\n}',
    },
  },
  {
    anchor: 'await',
    title: 'Await',
    text: '`await` starts a statement, never inside an expression: `a = await FIRST(q-[:Response]->)`, then use `a`.',
  },
];

/** The ideas with no TypeScript analogue — a few lines each, then search. */
export const CONCEPTS: readonly FrontEntry[] = [
  {
    anchor: 'systems',
    title: 'Import, then construct',
    text: 'Import a system from `adapters` and its connection from `credentials`, then construct it once. An email listen needs a `key`, the address mail is sent to.',
    example: {
      file: 'import { email, attio } from adapters\nimport { acme } from credentials\n\ninbox = email()\ncrm = attio(credentials: acme)\n\nfunction `Log Sender`(m: <inbox-[:Email]->>) {\n  write crm-[:People]-> { unique by (Email), Email: m.From, Name: m.From }\n}\n\nlisten to inbox { key: "senders" } fire `Log Sender`',
    },
  },
  {
    anchor: 'graph-and-paths',
    title: 'Systems are graphs; paths are values',
    text: '`crm-[:Companies]->` is a path to its records, and `-[c:Companies WHERE …]->` filters the hop. A `listen` line fires a function with the event\'s record as its one parameter.',
  },
  {
    anchor: 'identity',
    title: 'A write creates or updates, by identity',
    text: '`unique by (…)` names the fields that make it the same record, so a repeat event updates rather than duplicates. Match a strong key first, then a fuzzy name as a second `unique by` line (lines are OR). A line missing its key is skipped; never skip the record. Write related records off the parent\'s handle. `FIRST(co-[:@old]->)` is null if it created the record.',
    example: {
      body: 'co = write crm-[:Companies]-> { unique by (Name), Name: m.Subject }\nwrite co-[:Team]-> {\n  unique by (Email)\n  unique by (FUZZY Name)\n  Email: m.From\n  Name: m.From\n}',
    },
  },
  {
    anchor: 'extraction',
    title: 'Extraction is a function backed by a model',
    text: 'A `node` declaration is a type and a schema; its descriptions are the model\'s instructions. `extract(content, Shape, settings)` returns a list, `extractOne` one record or absent.',
    example: {
      program: 'node Company: "the company this email is about" {\n  Name: <text> "its name"\n}\nfunction `File Company`(m: <inbox-[:Email]->>) {\n  co = extractOne([m.Body, m.Subject], Company, { tier: \'careful\' })\n  if co == null { ERROR("no company") }\n  write crm-[:Companies]-> { unique by (Name), Name: co.Name }\n}',
    },
  },
  {
    anchor: 'runs',
    title: 'Runs: effects, waiting, cost',
    text: 'A run parks at an `await` (an approval, `sleep`) and resumes when it settles; `race` and `parallel` combine waits. A run pauses at its cost cap until resumed.',
    example: {
      body: 'q = write asks-[:Check]-> { Prompt: "Log ${m.Subject}?" }\nr = await race([\n  () => {\n    a = await FIRST(q-[:Response]->)\n    return a.Answer\n  },\n  () => { await sleep(2d) },\n])\napproved = AT(r, 0) == TRUE',
    },
  },
];

/** Agent-facing, so it names the tools — the one part of the page that does. */
export const BUILD_LOOP = `### build-loop

getStarted → write → saveAutomation (checks first; saves nothing with errors) → runAutomation → checkRun. No chapters: searchLanguage answers lookups, describeConnection details one system. Batch independent calls in one turn.`;

function renderExample(example: FrontExample): string {
  return `\n\`\`\`\n${exampleText(example)}\n\`\`\``;
}

function renderBullet(entry: FrontEntry): string {
  const example = entry.example ? renderExample(entry.example).replace(/\n/g, '\n  ') : '';
  return `- **${entry.title}.** ${entry.text}${example}`;
}

function renderConcept(entry: FrontEntry): string {
  return `### ${entry.anchor} — ${entry.title}\n\n${entry.text}${entry.example ? `\n${renderExample(entry.example)}` : ''}`;
}

/** The front page, as the automations connector serves it. */
export function renderFrontPage(): string {
  return [
    '## Writing automations: it is TypeScript, except…',
    'An automation is a program run when an event arrives. Write it as TypeScript, except where this page says otherwise.',
    '### ts-except',
    TS_EXCEPT.map(renderBullet).join('\n'),
    ...CONCEPTS.map(renderConcept),
    BUILD_LOOP,
  ].join('\n\n');
}

/** Every anchor the page answers to, entry by entry. */
export function frontEntries(): readonly FrontEntry[] {
  return [...TS_EXCEPT, ...CONCEPTS];
}

/**
 * One entry of the page by its anchor — `front#maybe-absent` — so a diagnostic
 * pointing here costs one entry, not the page. `ts-except` and `build-loop`
 * answer with their whole section.
 */
export function frontSection(anchor: string): { ok: true; content: string } | { ok: false; error: string } {
  const wanted = anchor.trim().toLowerCase();
  if (wanted === 'ts-except') return { ok: true, content: `### ts-except\n\n${TS_EXCEPT.map(renderBullet).join('\n')}` };
  if (wanted === 'build-loop') return { ok: true, content: BUILD_LOOP };
  const bullet = TS_EXCEPT.find((e) => e.anchor === wanted);
  if (bullet) return { ok: true, content: renderBullet(bullet) };
  const concept = CONCEPTS.find((e) => e.anchor === wanted);
  if (concept) return { ok: true, content: renderConcept(concept) };
  const anchors = ['ts-except', ...frontEntries().map((e) => e.anchor), 'build-loop'];
  return { ok: false, error: `No section "${anchor}" on the front page. Sections: ${anchors.join(', ')}.` };
}

/** The whole program an example stands for. */
export function exampleProgram(example: FrontExample): string {
  if ('file' in example) return `${example.file}\n`;
  if ('program' in example) return `${PRELUDE}\n${example.program}\n`;
  const body = example.body
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
  return `${PRELUDE}\nfunction \`Probe\`(m: <inbox-[:Email]->>) {\n${body}\n}\n`;
}

/** The page's examples as claims the handbook's lockstep and checker tests hold. */
export function frontPageClaims(): EngineClaim[] {
  return frontEntries().flatMap((entry) =>
    entry.example
      ? [{ construct: `front page: ${entry.anchor}`, status: 'runs' as const, probe: exampleProgram(entry.example) }]
      : [],
  );
}
