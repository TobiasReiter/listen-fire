// Lexical addressing for the durable-suspend engine (async-interaction §4.3).
//
// An ADDRESS names a frame — and especially a parked `ask` leaf — stably across
// re-parse (P11 pins the version, so statement indices don't move) and across
// fan-out iterations. It is a path of steps from the movement-body root:
//
//   stmt i   — the i-th statement of the current sequence (LEXICAL; stable by P11)
//   iter j   — descend into a fan-out body, iteration j (DYNAMIC; positional)
//   branch k — a parallel branch / if-arm k
//   call k   — the k-th call this statement made, in the order it made them: a
//              called movement / function / closure's body (its statements
//              follow as `stmt` steps), or a collection op (its members follow
//              as `iter` steps). DYNAMIC within the statement, LEXICAL across
//              statements; a statement re-run on resume makes its calls in the
//              same order, which is what lets the k-th be found again.
//
// The address does quintuple duty (§4.3): it identifies the AST node, disambiguates
// fan-out instances, encodes the tree BY PREFIX (so a join is a prefix query and a
// shared ancestor scope is a shared prefix), and is the `UNIQUE(run_id, address)`
// idempotency key for parking + delivery (§5.5). It is stored as the canonical TEXT
// `address` column (chunk-1 decision): `s1.i0.s0.b0.s0`.
//
// This module is PURE (no interpreter, no DB) — the keystone built and tested first.

export type AddressStepKind = 'stmt' | 'iter' | 'branch' | 'call';

export interface AddressStep {
  kind: AddressStepKind;
  index: number;
}

/** A root-to-leaf path. The empty path is the movement-body root. */
export type Address = readonly AddressStep[];

export const ROOT_ADDRESS: Address = [];

const KIND_LETTER: Record<AddressStepKind, string> = { stmt: 's', iter: 'i', branch: 'b', call: 'c' };
const LETTER_KIND: Record<string, AddressStepKind> = { s: 'stmt', i: 'iter', b: 'branch', c: 'call' };

// ── Construction (the interpreter appends steps as it descends) ──

function step(kind: AddressStepKind, index: number): AddressStep {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`address ${kind} index must be a non-negative integer, got ${index}`);
  }
  return { kind, index };
}

export function childStmt(address: Address, index: number): Address {
  return [...address, step('stmt', index)];
}

export function childIter(address: Address, index: number): Address {
  return [...address, step('iter', index)];
}

export function childBranch(address: Address, index: number): Address {
  return [...address, step('branch', index)];
}

export function childCall(address: Address, index: number): Address {
  return [...address, step('call', index)];
}

/** The enclosing frame's address (drops the last step). Root has no parent → null. */
export function parentAddress(address: Address): Address | null {
  return address.length === 0 ? null : address.slice(0, -1);
}

// ── Encoding (the DB text column) ──

export function encodeAddress(address: Address): string {
  return address.map((s) => `${KIND_LETTER[s.kind]}${s.index}`).join('.');
}

export function parseAddress(text: string): Address {
  if (text === '') return ROOT_ADDRESS;
  return text.split('.').map((token) => {
    const kind = LETTER_KIND[token[0]];
    const index = Number(token.slice(1));
    if (kind === undefined || token.length < 2 || !/^\d+$/.test(token.slice(1))) {
      throw new Error(`malformed address token '${token}' in '${text}'`);
    }
    return { kind, index };
  });
}

// ── Comparison + the prefix algebra (joins + scope-sharing, §4.3) ──

export function stepsEqual(a: AddressStep, b: AddressStep): boolean {
  return a.kind === b.kind && a.index === b.index;
}

export function addressEquals(a: Address, b: Address): boolean {
  return a.length === b.length && a.every((s, i) => stepsEqual(s, b[i]));
}

/**
 * Is `ancestor` a prefix of `descendant` (ancestor-or-self)? This is the join
 * test — "every parked leaf under frame P" is `isAncestorOrSelf(P, leaf)` — and
 * the scope-sharing test (two leaves share the scope at their common prefix).
 */
export function isAncestorOrSelf(ancestor: Address, descendant: Address): boolean {
  return ancestor.length <= descendant.length && ancestor.every((s, i) => stepsEqual(s, descendant[i]));
}

export function isStrictAncestor(ancestor: Address, descendant: Address): boolean {
  return ancestor.length < descendant.length && isAncestorOrSelf(ancestor, descendant);
}

/**
 * The address of a leaf's NEAREST enclosing JOIN frame (§5.4) — the
 * parallel/fan-out STATEMENT whose child branch this leaf lives under. It is the
 * prefix up to (but not including) the leaf's LAST `iter`/`branch` step: that
 * step names a child branch of the join, and the join is the statement owning it.
 * A leaf with no `iter`/`branch` step (a single ask in a linear body) has NO
 * enclosing join → null (it completes directly, no pending-count).
 *
 * Examples: `s1.i0.s0` → `s1` (the fan-out); `s0.b1.s0` → `s0` (the parallel);
 * `s1.i0.s0.b0.s0` → `s1.i0.s0` (the inner parallel inside the fan-out body);
 * `s0` → null.
 */
export function enclosingJoinAddress(leaf: Address): Address | null {
  for (let i = leaf.length - 1; i >= 0; i--) {
    if (leaf[i].kind === 'iter' || leaf[i].kind === 'branch') {
      return leaf.slice(0, i);
    }
  }
  return null;
}

/** The longest common prefix of two addresses — their nearest shared frame
 *  (the scope serialised once for both, §4.6). */
export function commonPrefix(a: Address, b: Address): Address {
  const out: AddressStep[] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (!stepsEqual(a[i], b[i])) break;
    out.push(a[i]);
  }
  return out;
}
