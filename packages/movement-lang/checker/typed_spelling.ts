// Language version 5's namespace functions chosen by what a value IS
// (plans/naming-rethink-2026-10-14/5_design.md §2.2): a list's length is
// `count(xs)`, text's `Text.length(t)`; a list holds a value by
// `List.includes(xs, v)`, text by `Text.includes(t, v)`; a list's presence is
// `count(xs) > 0`, a value's `x != null`. The spelling rewrite
// (crates/movement-parser/src/surface) cannot see a type, so its fix for an
// old spelling is the one whose tree is the old one's (`Text.length`,
// `Text.includes`, `!= null`); here the checker, which can, rewrites that fix
// where the operand is a list, and refuses a v5 call given the wrong kind.
// The Rust twin is crates/movement-checker/src/families/typed_spelling.rs.

import { children } from '../parser/expression/lower';
import type { At, Hop, MExpr, Name } from '../parser/expression/tree';

export type ValueKind = 'list' | 'text' | undefined;

export interface TypedSpelling {
  /** `respell`: the parser's MOV_V5_SPELLING finding at `at` takes this
   *  message and fix. `misuse`: a v5 call given the wrong kind of value. */
  kind: 'respell' | 'misuse';
  at: At;
  message: string;
  text: string;
  /** The fix keeps the meaning: from 5 `count` counts every item, as `LENGTH`
   *  of a list did and as `EXISTS` of one asked (any item at all). */
  safe?: true;
}

/** Every typed respelling in `tree` (outside walk brackets), `kindOf` giving
 *  what an operand is where the checker can tell. */
export function typedSpellings(tree: MExpr, raw: string, kindOf: (e: MExpr) => ValueKind): TypedSpelling[] {
  const out: TypedSpelling[] = [];
  const text = (at: At): string => raw.slice(at.start, at.end);
  const visit = (e: MExpr, inWalk: boolean): void => {
    if (e.kind === 'path') {
      if (e.root !== undefined) visit(e.root, inWalk);
      for (const hop of e.hops) {
        if (hop.where !== undefined) visit(hop.where, true);
        if (hop.config !== undefined) visit(hop.config, inWalk);
        if (hop.orderBy !== undefined) visit(hop.orderBy.key, true);
      }
      return;
    }
    if (e.kind === 'where') {
      visit(e.source, inWalk);
      visit(e.predicate, true);
      return;
    }
    for (const child of children(e)) visit(child, inWalk);
    if (!inWalk) out.push(...here(e));
  };
  const here = (e: MExpr): TypedSpelling[] => {
    if (e.kind === 'call' && e.callee.kind === 'name' && e.args.length === 1) {
      const canonical = e.callee.name.text.toUpperCase();
      const arg = e.args[0].value;
      const written = text(e.callee.at);
      if (canonical === 'LENGTH' && kindOf(arg) === 'list') {
        const fix = `count(${text(arg.at)})`;
        return written === 'Text.length'
          ? [{ kind: 'misuse', at: e.at, message: "`Text.length` takes text; a list's length is `count(xs)`", text: fix }]
          : [{ kind: 'respell', at: e.at, message: `\`${written}\` of a list is written \`count(xs)\` from language version 5`, text: fix, safe: true }];
      }
      if (canonical === 'EXISTS' && arg.kind !== 'path' && arg.kind !== 'where' && kindOf(arg) === 'list') {
        const fix = `count(${text(arg.at)}) > 0`;
        return [
          {
            kind: 'respell',
            at: e.at,
            message: `\`${written}\` of a list is written \`count(xs) > 0\` from language version 5`,
            text: whole(raw, e.at) ? fix : `(${fix})`,
            safe: true,
          },
        ];
      }
      return [];
    }
    if (e.kind === 'binary' && e.op === 'contains' && kindOf(e.left) === 'list') {
      const fix = `List.includes(${text(e.left.at)}, ${text(e.right.at)})`;
      return text(e.at).startsWith('Text.includes')
        ? [{ kind: 'misuse', at: e.at, message: "`Text.includes` takes text; a list holds a value by `List.includes(xs, v)`", text: fix }]
        : [{ kind: 'respell', at: e.at, message: '`CONTAINS` on a list is written `List.includes(xs, v)` from language version 5', text: fix }];
    }
    if (e.kind === 'binary' && e.op === 'in' && text(e.at).startsWith('List.includes') && kindOf(e.right) === 'text') {
      const fix = `Text.includes(${text(e.right.at)}, ${text(e.left.at)})`;
      return [{ kind: 'misuse', at: e.at, message: '`List.includes` takes a list; text holds text by `Text.includes(t, v)`', text: fix }];
    }
    return [];
  };
  visit(tree, false);
  return out;
}

/** `at` is the whole text, or the whole of its sole parentheses (an `if`
 *  condition): a rewrite there needs none of its own (the parser's rule). */
function whole(raw: string, at: At): boolean {
  const before = raw.slice(0, at.start).trim();
  const after = raw.slice(at.end).trim();
  return (before === '' && after === '') || (before === '(' && after === ')');
}

// ── A walk's fields through its alias (design §2.5) ──
//
// From version 5 a hop's WHERE and ORDER BY read its record's fields through
// the hop's alias (`c.Name`); a bare name there is a variable from outside the
// walk, as it is everywhere else. The parser reads `c.Name` into the bare
// field the canonical tree has always held (keeping the alias read's extent),
// so a name the source writes bare that the scope does not bind is the old
// spelling of a field: refused, its fix the alias read, with an alias added
// to a hop that has none. A postfix `walk WHERE p` moves into the last hop.

export interface WalkField {
  at: At;
  message: string;
  /** Offsets into the text the tree was read from. */
  edits: Array<{ at: At; text: string }>;
  /** A field read through the alias whose name the scope also binds: the
   *  canonical tree reads both as the one bare name, which the engine takes
   *  as the variable (MOV_SHADOWED_NAME, refused until the tree tells them
   *  apart). */
  shadowed?: true;
  /** The fix keeps the meaning: an alias read for a name the scope does not
   *  bind is the field the bare name read. Moving a postfix WHERE into the
   *  hop is not proved to. */
  safe?: true;
}

/** Every bare field in `tree`'s walks, `binds` telling whether the scope
 *  binds a name (then it is an outer variable). */
export function walkFields(tree: MExpr, raw: string, binds: (name: string) => boolean): WalkField[] {
  const out: WalkField[] = [];
  const text = (at: At): string => raw.slice(at.start, at.end);
  const isField = (name: Name, aliases: readonly string[]): boolean => {
    const written = text(name.at);
    const bare = written === name.text || written === `\`${name.text}\``;
    return bare && !aliases.includes(name.text) && name.text.toLowerCase() !== 'edge' && !binds(name.text);
  };
  const aliasOf = (hop: Hop, taken: readonly string[]): { alias: string; insert?: { at: At; text: string } } => {
    if (hop.alias !== undefined) return { alias: hop.alias.text };
    const letter = [...hop.label.text].find((c) => /[A-Za-z]/.test(c));
    const stem = letter === undefined ? 'x' : letter.toLowerCase();
    let alias = stem;
    for (let i = 2; taken.includes(alias) || binds(alias); i++) alias = `${stem}${i}`;
    let open = hop.label.at.start;
    for (let i = hop.at.start; i < hop.label.at.start; i++) {
      if (raw[i] === '[') {
        open = i + 1;
        break;
      }
    }
    return { alias, insert: { at: { start: open, end: open }, text: alias } };
  };
  const visit = (e: MExpr, aliases: readonly string[]): void => {
    const here = e.kind === 'path' ? [...aliases, ...e.hops.flatMap((h) => (h.alias !== undefined ? [h.alias.text] : []))] : aliases;
    if (e.kind === 'path') {
      for (const hop of e.hops) {
        const names: Name[] = [];
        if (hop.where !== undefined) bareNames(hop.where, names);
        if (hop.orderBy !== undefined) bareNames(hop.orderBy.key, names);
        for (const n of names) {
          const written = text(n.at);
          if (written !== n.text && written !== `\`${n.text}\`` && binds(n.text)) {
            out.push({
              at: n.at,
              message: `\`${written}\` reads the field '${n.text}', but a variable named '${n.text}' is in scope, and inside a hop's brackets the run cannot yet tell the two apart: it would read the variable. Rename the variable`,
              edits: [],
              shadowed: true,
            });
          }
        }
        const fields = names.filter((n) => isField(n, here));
        const first = fields[0];
        if (first === undefined) continue;
        const { alias, insert } = aliasOf(hop, here);
        const edits = [...(insert !== undefined ? [insert] : []), ...fields.map((n) => ({ at: n.at, text: `${alias}.${text(n.at)}` }))];
        out.push({
          at: first.at,
          message: `from language version 5 a walk's field is read through the hop's alias: \`${alias}.${text(first.at)}\` (a bare name inside the brackets is a variable from outside the walk)`,
          edits,
          safe: true,
        });
      }
    }
    if (e.kind === 'where' && e.source.kind === 'path' && e.source.hops.length > 0) {
      const source = e.source;
      const last = source.hops[source.hops.length - 1];
      const names: Name[] = [];
      bareNames(e.predicate, names);
      const fields = names.filter((n) => isField(n, here));
      const simple = last.where === undefined && last.orderBy === undefined && last.limit === undefined && last.config === undefined;
      const message =
        "from language version 5 a walk's filter is written inside its last hop, its fields through the hop's alias: `-[a:Edge WHERE a.Field …]->`";
      let edits: WalkField['edits'] = [];
      if (simple) {
        const { alias, insert } = aliasOf(last, here);
        const p = e.predicate.at;
        let moved = raw.slice(p.start, p.end);
        for (const n of [...fields].sort((a, b) => b.at.start - a.at.start)) {
          moved = moved.slice(0, n.at.start - p.start) + `${alias}.${text(n.at)}` + moved.slice(n.at.end - p.start);
        }
        const s = source.at;
        const pieces = [{ at: last.label.at.end, text: ` WHERE ${moved}` }, ...(insert !== undefined ? [{ at: insert.at.start, text: insert.text }] : [])];
        let walk = raw.slice(s.start, s.end);
        for (const piece of pieces.sort((a, b) => b.at - a.at)) {
          walk = walk.slice(0, piece.at - s.start) + piece.text + walk.slice(piece.at - s.start);
        }
        edits = [{ at: e.at, text: walk }];
      }
      out.push({ at: e.at, message, edits });
    }
    for (const child of children(e)) visit(child, here);
  };
  visit(tree, []);
  return out;
}

/** The names `e` reads bare, outside any walk nested in it (whose hops are
 *  read on their own) and never a call's callee. */
function bareNames(e: MExpr, out: Name[]): void {
  if (e.kind === 'name') out.push(e.name);
  else if (e.kind === 'path' || e.kind === 'where') return;
  else if (e.kind === 'call') for (const a of e.args) bareNames(a.value, out);
  else for (const c of children(e)) bareNames(c, out);
}
