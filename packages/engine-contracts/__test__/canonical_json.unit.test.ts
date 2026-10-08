import { canonicalJson } from '../conformance';

describe('canonicalJson', () => {
  it('ignores key order at every depth', () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalJson({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('keeps array order', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('tells differing values apart', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ b: 1 }));
  });
});
