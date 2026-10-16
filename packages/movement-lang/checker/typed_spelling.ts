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
import type { At, MExpr } from '../parser/expression/tree';

export type ValueKind = 'list' | 'text' | undefined;

export interface TypedSpelling {
  /** `respell`: the parser's MOV_V5_SPELLING finding at `at` takes this
   *  message and fix. `misuse`: a v5 call given the wrong kind of value. */
  kind: 'respell' | 'misuse';
  at: At;
  message: string;
  text: string;
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
          : [{ kind: 'respell', at: e.at, message: `\`${written}\` of a list is written \`count(xs)\` from language version 5`, text: fix }];
      }
      if (canonical === 'EXISTS' && arg.kind !== 'path' && arg.kind !== 'where' && kindOf(arg) === 'list') {
        const fix = `count(${text(arg.at)}) > 0`;
        return [
          {
            kind: 'respell',
            at: e.at,
            message: `\`${written}\` of a list is written \`count(xs) > 0\` from language version 5`,
            text: whole(raw, e.at) ? fix : `(${fix})`,
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
