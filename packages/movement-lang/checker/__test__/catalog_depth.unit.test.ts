// The Rust catalog's depth bound, through the WASM: catalog data nested past
// 256 levels is refused with a message naming the limit, never a trap of the
// engine's stack (about 1,800 levels of `list of` exhausted it in Node,
// measured 2026-10-07), and the module answers the next call.
import { callCatalog } from '../../wasm/loader';

const LIMIT = 256;

const nestedList = (n: number): string => `${'{"kind":"list","of":'.repeat(n)}"text"${'}'.repeat(n)}`;

/** A snapshot whose one property is typed `nestedList(n)`, eight levels down. */
const snapshot = (n: number): string =>
  `{"adapters":{"a":{"constructionArgs":[],"schemas":{"":{"positions":{"p":{"properties":{"f":${nestedList(n)}},"edges":{}}},"collections":{},"writableRoots":{}}}}},"credentials":{},"plugins":{}}`;

const instantiate = (n: number) => callCatalog(snapshot(n), '{"op":"instantiate","adapter":"a","args":{}}');
const describe_ = (n: number) =>
  callCatalog('', `{"op":"helper","name":"describeFieldType","args":[${nestedList(n)}]}`);

describe('catalog JSON depth, through the WASM', () => {
  it('answers at the limit', () => {
    expect(instantiate(LIMIT - 8)).toMatchObject({ ok: true, json: { value: { collections: {} } } });
    expect(describe_(LIMIT)).toMatchObject({ ok: true, json: { value: expect.stringMatching(/^list of list of /) } });
  });

  it('refuses past it, naming the limit, and stays usable', () => {
    for (const n of [LIMIT - 7, 2_000]) {
      expect(instantiate(n)).toEqual({
        ok: false,
        json: { error: { message: `the snapshot does not read: it nests deeper than ${LIMIT} levels` } },
      });
    }
    for (const n of [LIMIT + 1, 2_000]) {
      expect(describe_(n)).toEqual({
        ok: false,
        json: { error: { message: `the type does not read: it nests deeper than ${LIMIT} levels` } },
      });
    }
    expect(describe_(1)).toEqual({ ok: true, json: { value: 'list of text' } });
  });
});
