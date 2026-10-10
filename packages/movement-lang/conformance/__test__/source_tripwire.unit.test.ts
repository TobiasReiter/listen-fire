// eslint-disable-next-line @typescript-eslint/no-require-imports
const { assertResolvesToSource, assertSourcesResolve } = require('../source_tripwire.cjs');

describe('source tripwire', () => {
  it('accepts a .ts source', () => {
    expect(() => assertResolvesToSource('movement-lang', '/x/index.ts')).not.toThrow();
  });

  it('rejects a compiled copy and says how to cure it', () => {
    expect(() => assertResolvesToSource('movement-lang', '/x/index.js')).toThrow(/compiled copy.*Delete the compiled files/s);
  });

  it('passes in this checkout: the package and its language_version resolve to sources', () => {
    expect(() => assertSourcesResolve(require.resolve)).not.toThrow();
  });

  it('fails when the resolver returns a .js for any target', () => {
    expect(() => assertSourcesResolve((s: string) => `${s}.js`, ['movement-lang'])).toThrow(/not a \.ts source/);
  });
});
