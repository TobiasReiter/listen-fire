// The README's port list as the patterns oracle reads it: every reason it
// names, the status each row starts its last column with, and which
// endings a program may have for a reason in that status. Read by the
// generator as it writes patterns.json (patterns_oracle.ts) and by a static
// check of the committed file against the README
// (apps/api/src/services/movement_engine/__test__/patterns_inventory.unit.test.ts),
// so a row marked Closed fails before anyone regenerates.

import { BY_CONTRACT, UNRECORDABLE, type Routes } from './patterns_table';

/** The pattern a reason names: `function:fact` is `function:<id>`. */
export function patternOf(reason: string, patterns: readonly string[]): string | undefined {
  if (patterns.includes(reason)) return reason;
  return patterns.find((p) => {
    const at = p.indexOf('<');
    return at > 0 && reason.startsWith(p.slice(0, at)) && reason.length > at;
  });
}

/** Each reason the README's port list names (its tables' first column,
 *  from "The port list" to its version-4 section), by the status its row
 *  starts its last column with: `Closed` (retired: nothing left to port) or
 *  `Open`. */
export function portListStatus(readme: string): Map<string, 'Closed' | 'Open'> {
  const from = readme.indexOf('### The port list');
  const to = readme.indexOf('### Language version 4: the port list');
  if (from === -1 || to === -1) throw new Error("patterns oracle: the README no longer spells the port list as this reads it");
  const status = new Map<string, 'Closed' | 'Open'>();
  for (const line of readme.slice(from, to).split('\n')) {
    const cell = /^\| ([^|]*)\|/.exec(line)?.[1];
    if (cell === undefined || cell.trim() === 'reason' || /^-+$/.test(cell.trim())) continue;
    const marked = /\*\*(Closed|Open)\*\*/.exec(line.slice(line.lastIndexOf('|', line.length - 2)))?.[1];
    if (marked !== 'Closed' && marked !== 'Open') throw new Error(`patterns oracle: the port list row for ${cell.trim()} says neither Closed nor Open`);
    for (const [, name] of cell.matchAll(/`([^`]+)`/g)) status.set(name!, marked);
  }
  return status;
}

/** Why a program the Rust engine refused or declined is wrong to be: a
 *  reason the port list has retired (marked Closed, or no longer named), or
 *  a contract category reached by a reason outside it. Nothing for a
 *  program that ends otherwise. */
export function retiredReasons(routes: Routes, reasons: readonly string[], status: ReadonlyMap<string, 'Closed' | 'Open'>): string[] {
  const listed = [...status.keys()];
  const statusOf = (reason: string) => {
    const pattern = patternOf(reason, listed);
    return pattern === undefined ? 'unlisted' : status.get(pattern)!;
  };
  switch (routes) {
    case 'refused':
    case 'declined':
      return reasons.filter((reason) => statusOf(reason) !== 'Open').map((reason) => `${routes} for ${reason}, which the port list ${statusOf(reason) === 'Closed' ? 'marks Closed' : 'no longer names'}`);
    case 'by_contract':
      return reasons.filter((reason) => !BY_CONTRACT.includes(reason) || statusOf(reason) !== 'Closed').map((reason) => `by_contract for ${reason}, which is not a Closed contract refusal`);
    case 'unrecordable':
      return reasons.filter((reason) => !UNRECORDABLE.includes(reason)).map((reason) => `unrecordable for ${reason}, which is not the shim's wire refusal`);
    case 'whole':
    case 'unreached':
      return [];
    default:
      return neverRoutes(routes);
  }
}

function neverRoutes(routes: never): never {
  throw new Error(`patterns oracle: no such routes ${String(routes)}`);
}

