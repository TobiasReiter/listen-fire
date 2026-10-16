// The exact rewrite a diagnostic offers — the repair, not a description of it.
//
// An authoring agent that is handed the corrected text pastes it and is done;
// one handed a menu of options spends another validate round picking. So the
// commonest refusals carry a fix built from the author's OWN source (their
// expression, their names, the connection they actually have), said twice:
// as edits a tool can apply, and in the message, which is all an agent reading
// text sees. A fix is offered only when it is certain to be the repair — a
// rewrite that doesn't compile is worse than none.

import { spellName, type Span } from '../parser/ast';

/** Replace `span` with `text`. A zero-width span (start = end) inserts. */
export interface SourceEdit {
  span: Span;
  text: string;
}

export interface DiagnosticFix {
  /** Applied together; no two overlap. */
  edits: SourceEdit[];
  /** Safe to apply automatically: the rewrite provably keeps the program's
   *  meaning (an old spelling read into the very tree it was). Only such
   *  fixes move a pin on their own (the deploy check's advance); a person's
   *  upgrade applies them and lists the rest, or applies all when asked. */
  safe?: true;
}

const TOP_OF_FILE: Span = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };

/** A line added at the top of the file — where an import goes. */
export function insertLineAtTop(line: string): SourceEdit {
  return { span: TOP_OF_FILE, text: `${line}\n` };
}

/** `import { <name> } from <namespace>`, the name spelled as source. */
export function importLine(name: string, namespace: 'adapters' | 'credentials' | 'plugins'): string {
  return `import { ${spellName(name)} } from ${namespace}`;
}

/** `source` with `fix` applied — what a tool (or a test) does with one. */
export function applyFix(source: string, fix: DiagnosticFix): string {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
  const offset = (loc: Span['start']): number => (lineStarts[loc.line - 1] ?? source.length) + loc.col - 1;
  // Back to front, so an edit never shifts the offsets of one still to apply.
  const ordered = [...fix.edits].sort((a, b) => offset(b.span.start) - offset(a.span.start));
  let result = source;
  for (const edit of ordered) {
    result = result.slice(0, offset(edit.span.start)) + edit.text + result.slice(offset(edit.span.end));
  }
  return result;
}
