// Lexical address model (async-interaction §4.3) — pure, no interpreter/DB.
// The golden fixtures are §4.3's Example-2 four parked asks (a fan-out over two
// deals, each a parallel of two asks).

import {
  Address,
  ROOT_ADDRESS,
  addressEquals,
  childBranch,
  childCall,
  childIter,
  childStmt,
  commonPrefix,
  enclosingJoinAddress,
  encodeAddress,
  isAncestorOrSelf,
  isStrictAncestor,
  parentAddress,
  parseAddress,
} from '../address';

// stmt1 · iter j · stmt0 · branch k · stmt0  (the fan-out body's parallel's ask)
const leaf = (iter: number, branch: number): Address =>
  childStmt(childBranch(childStmt(childIter(childStmt(ROOT_ADDRESS, 1), iter), 0), branch), 0);

const ACME_CALL = leaf(0, 0); // s1.i0.s0.b0.s0
const ACME_CAP = leaf(0, 1); // s1.i0.s0.b1.s0
const BETA_CALL = leaf(1, 0); // s1.i1.s0.b0.s0

describe('lexical address (§4.3)', () => {
  it('encodes the Example-2 addresses to the canonical text form', () => {
    expect(encodeAddress(ACME_CALL)).toBe('s1.i0.s0.b0.s0');
    expect(encodeAddress(ACME_CAP)).toBe('s1.i0.s0.b1.s0');
    expect(encodeAddress(BETA_CALL)).toBe('s1.i1.s0.b0.s0');
    expect(encodeAddress(ROOT_ADDRESS)).toBe('');
  });

  it('round-trips encode → parse', () => {
    for (const a of [ACME_CALL, ACME_CAP, BETA_CALL, ROOT_ADDRESS]) {
      expect(parseAddress(encodeAddress(a))).toEqual(a);
    }
    expect(parseAddress('s1.i0.s0.b1.s0')).toEqual(ACME_CAP);
  });

  it('parentAddress drops the last step; root has no parent', () => {
    expect(encodeAddress(parentAddress(ACME_CALL)!)).toBe('s1.i0.s0.b0');
    expect(parentAddress(ROOT_ADDRESS)).toBeNull();
  });

  it('addressEquals compares structurally', () => {
    expect(addressEquals(ACME_CALL, leaf(0, 0))).toBe(true);
    expect(addressEquals(ACME_CALL, ACME_CAP)).toBe(false);
  });

  it('isAncestorOrSelf is the join test — leaves under a frame share its prefix', () => {
    const acmeParallel = parseAddress('s1.i0.s0'); // the parallel frame for the Acme item
    expect(isAncestorOrSelf(acmeParallel, ACME_CALL)).toBe(true);
    expect(isAncestorOrSelf(acmeParallel, ACME_CAP)).toBe(true);
    // Beta's asks are NOT under Acme's parallel.
    expect(isAncestorOrSelf(acmeParallel, BETA_CALL)).toBe(false);
    // self is an ancestor-or-self; strict is not.
    expect(isAncestorOrSelf(acmeParallel, acmeParallel)).toBe(true);
    expect(isStrictAncestor(acmeParallel, acmeParallel)).toBe(false);
    expect(isStrictAncestor(acmeParallel, ACME_CALL)).toBe(true);
  });

  it('commonPrefix is the nearest shared frame (scope-sharing)', () => {
    // Acme's two asks share the parallel frame s1.i0.s0 (where c=Acme lives).
    expect(encodeAddress(commonPrefix(ACME_CALL, ACME_CAP))).toBe('s1.i0.s0');
    // Acme vs Beta share only the fan-out frame s1 (the deals).
    expect(encodeAddress(commonPrefix(ACME_CALL, BETA_CALL))).toBe('s1');
  });

  it('enclosingJoinAddress is the leaf’s nearest parallel/fan-out frame (§5.4)', () => {
    // Example-2's deepest leaves: nearest join is the inner parallel s1.i0.s0.
    expect(encodeAddress(enclosingJoinAddress(ACME_CALL)!)).toBe('s1.i0.s0');
    expect(encodeAddress(enclosingJoinAddress(ACME_CAP)!)).toBe('s1.i0.s0');
    expect(encodeAddress(enclosingJoinAddress(BETA_CALL)!)).toBe('s1.i1.s0');
    // The canonical golden case: `deals-> { ask; if ok { write } }` — one ask per
    // iteration, the fan-out is the only join. The ask leaf is s1.i0.s0; its
    // enclosing join is the fan-out statement s1.
    expect(encodeAddress(enclosingJoinAddress(parseAddress('s1.i0.s0'))!)).toBe('s1');
    expect(encodeAddress(enclosingJoinAddress(parseAddress('s0.b1.s0'))!)).toBe('s0');
    // A single linear ask (s0) has no enclosing join → completes directly.
    expect(enclosingJoinAddress(parseAddress('s0'))).toBeNull();
    expect(enclosingJoinAddress(ROOT_ADDRESS)).toBeNull();
  });

  it('a call step: the k-th call a statement made, under which its body or members follow', () => {
    const memberLeaf = childStmt(childIter(childCall(childStmt(ROOT_ADDRESS, 1), 0), 2), 0);
    expect(encodeAddress(memberLeaf)).toBe('s1.c0.i2.s0');
    expect(parseAddress('s1.c0.i2.s0')).toEqual(memberLeaf);
    // A member's join is the op itself — the call step; a call is not a join.
    expect(encodeAddress(enclosingJoinAddress(memberLeaf)!)).toBe('s1.c0');
    expect(enclosingJoinAddress(parseAddress('s0.c1.s3'))).toBeNull();
  });

  it('rejects malformed address text', () => {
    expect(() => parseAddress('s1.x0')).toThrow(/malformed/);
    expect(() => parseAddress('s')).toThrow(/malformed/);
    expect(() => parseAddress('sa.b1')).toThrow(/malformed/);
  });

  it('rejects negative / non-integer step indices', () => {
    expect(() => childStmt(ROOT_ADDRESS, -1)).toThrow(/non-negative/);
    expect(() => childIter(ROOT_ADDRESS, 1.5)).toThrow(/non-negative/);
  });
});
