// The editor's view of language version 5's surface (plans/naming-rethink-
// 2026-10-14/5_design.md): what completion offers and hover says, read from
// the parser's spelling table (parser/surface.ts) so the editor never keeps a
// second copy of a spelling. Up to version 4 none of this is used.

import { lookupBuiltin, describeBuiltin } from '../checker/standard_library';
import { spellMessage, surfaceTable, type SpellingRow } from '../parser/surface';
import type { MovementCompletionItem, MovementHover } from './service';

const V5 = 5;

/** A row the v5 surface writes as a call: neither an operator form (`== null`,
 *  `[]`) nor a second old name for a function another row already spells. */
function isCall(row: SpellingRow): boolean {
  return !row.oldOnly && /^[A-Za-z][\w.]*$/.test(row.v5);
}

function detailOf(row: SpellingRow): string {
  const builtin = lookupBuiltin(row.canonical);
  if (builtin === undefined) return row.v5;
  return spellMessage(`${describeBuiltin(builtin)} — ${builtin.summary}`, V5);
}

/** The core words (`map(…)`) and the namespaces (`Text.`) an expression
 *  offers outside walk brackets. */
export function v5StandardCompletions(): MovementCompletionItem[] {
  const { spellings, namespaces } = surfaceTable();
  const core = spellings
    .filter((row) => isCall(row) && !row.v5.includes('.'))
    .map((row): MovementCompletionItem => ({ label: `${row.v5}(…)`, insert: `${row.v5}(`, kind: 'function', detail: detailOf(row) }));
  const gateways = namespaces.map((namespace): MovementCompletionItem => ({
    label: `${namespace}.`,
    insert: `${namespace}.`,
    kind: 'function',
    detail: `${namespace}: ${membersOf(namespace).map((row) => row.v5.slice(namespace.length + 1)).join(', ')}`,
  }));
  return [...core, ...gateways];
}

function membersOf(namespace: string): SpellingRow[] {
  return surfaceTable().spellings.filter((row) => isCall(row) && row.v5.startsWith(`${namespace}.`));
}

/** `Text.` → the namespace's members; undefined when `namespace` is none. */
export function v5MemberCompletions(namespace: string): MovementCompletionItem[] | undefined {
  if (!surfaceTable().namespaces.includes(namespace)) return undefined;
  return membersOf(namespace).map((row) => {
    const member = row.v5.slice(namespace.length + 1);
    return { label: member, insert: member, kind: 'function', detail: detailOf(row) };
  });
}

/** Inside walk brackets (`-[c:Companies WHERE …`) the walk keeps its CAPS
 *  words, so the formula engine's own items stand. */
export function insideWalkBrackets(text: string): boolean {
  return (text.match(/-\[/g)?.length ?? 0) > (text.match(/\]-/g)?.length ?? 0);
}

/** The formula engine's items (CAPS functions and words, as versions 1–4 and
 *  walk brackets read them) as an everyday expression from 5 writes them: an
 *  operator word by its symbol; a built-in the table holds is left to
 *  `v5StandardCompletions` (a core word, or its namespace's gateway); what
 *  the v5 surface spells with no call or word at all (`IF`, `x CONTAINS y`)
 *  is left out. */
export function v5EverydayItems(items: MovementCompletionItem[]): MovementCompletionItem[] {
  const { spellings, operators } = surfaceTable();
  const out: MovementCompletionItem[] = [];
  for (const item of items) {
    if (item.kind === 'keyword') {
      const op = operators.find(([old]) => old === item.label);
      if (op !== undefined) out.push({ ...item, label: op[1], insert: op[1] === '!' ? '!' : `${op[1]} ` });
      continue;
    }
    if (item.kind === 'operator') {
      if (['contains', 'exists', 'in'].includes(item.label.toLowerCase())) continue;
      out.push(item.label === '=' ? { ...item, label: '==', insert: '== ' } : item);
      continue;
    }
    if (item.kind === 'function') {
      const name = /^([A-Za-z_][\w.]*)\(/.exec(item.label)?.[1];
      const row = name === undefined ? undefined : spellings.find((s) => !s.newOnly && s.canonical === name);
      if (row === undefined) out.push(item);
      continue;
    }
    out.push(item);
  }
  return out;
}

/** Hover on a built-in written in the v5 surface: `Text.upper`, `map`. */
export function v5StandardHover(source: string, word: { text: string; from: number; to: number }): MovementHover | undefined {
  const dotted = /([A-Za-z_]\w*)\.$/.exec(source.slice(0, word.from));
  const written = dotted !== null ? `${dotted[1]}.${word.text}` : word.text;
  const from = dotted !== null ? word.from - dotted[0].length : word.from;
  // A core word only where it is called: a binding may share its name.
  const called = dotted !== null || source[word.to] === '(';
  const row = called ? surfaceTable().spellings.find((s) => isCall(s) && s.v5 === written) : undefined;
  if (row !== undefined) return { from, to: word.to, contents: [detailOf(row)] };
  if (dotted === null && source[word.to] === '.' && surfaceTable().namespaces.includes(word.text)) {
    const members = membersOf(word.text);
    return {
      from: word.from,
      to: word.to,
      contents: [`${word.text} — always present: ${members.map((m) => m.v5.slice(word.text.length + 1)).join(', ')}`, ...members.map(detailOf)],
    };
  }
  return undefined;
}

/** What hovering a keyword says from version 5, where it differs. */
export const V5_KEYWORD_HOVERS: Record<string, string> = {
  movement: 'movement — written `function` from language version 5',
  function: 'function — a named unit of work over one position; a listener fires it for each event',
  if: "if — branch on a parenthesised condition: `if (x != null) { … }`; an 'is' test narrows the position inside the arm",
};
