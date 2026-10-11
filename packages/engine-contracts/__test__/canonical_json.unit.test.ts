import { fileValue } from '../file_ref';
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

describe('a file at the host boundary', () => {
  const descriptor = {
    __brand: 'FileRef' as const,
    name: 'deck.pdf',
    source: { adapterType: 'attio', credentialId: 'cred-1', handle: 'h-1' },
  };

  it('is its descriptor in a canonical request or result, as the recordings hold it', () => {
    expect(canonicalJson({ fields: { deck: fileValue(descriptor) } })).toBe(canonicalJson({ fields: { deck: descriptor } }));
  });

  it("is its descriptor in a JSON copy (the recorder's, a result's, an HTTP host's body)", () => {
    expect(JSON.parse(JSON.stringify({ writtenValues: { deck: fileValue(descriptor) } }))).toEqual({ writtenValues: { deck: descriptor } });
  });
});
