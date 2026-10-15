// Jest resolver for a language version's conformance corpus.
//
// A corpus is an older release's own test files, copied VERBATIM into
// `__conformance__/v<n>/` at the same relative position they had in that
// release (so `checker/__test__/x.unit.test.ts` sits at
// `__conformance__/v1/checker/__test__/x.unit.test.ts`). Their relative
// imports were written against that release's tree, so they resolve as if the
// file still sat at its original position — against the CURRENT code — except
// that a request landing on another corpus file resolves to the corpus copy,
// not to today's version of that test.
const path = require('path');

const CORPUS_SEGMENT = /[\\/]__conformance__[\\/]v\d+(?=[\\/]|$)/;

module.exports = (request, options) => {
  const { basedir, defaultResolver } = options;
  const match = basedir.match(CORPUS_SEGMENT);
  if (!match || !request.startsWith('.')) return defaultResolver(request, options);

  const corpusRoot = basedir.slice(0, match.index + match[0].length) + path.sep;
  try {
    const inCorpus = defaultResolver(request, options);
    if (inCorpus.startsWith(corpusRoot)) return inCorpus;
  } catch {
    // Not a corpus file — resolve against the original position below.
  }
  const live = basedir.replace(CORPUS_SEGMENT, '');
  try {
    return defaultResolver(request, { ...options, basedir: live });
  } catch (error) {
    // The engine moved out of apps/api into packages/movement-engine with its
    // paths kept (apps/api/src/X -> packages/movement-engine/X), so a corpus
    // test's relative import of an engine module resolves there.
    const moved = live.replace(/([\\/])apps[\\/]api[\\/]src(?=[\\/]|$)/, '$1packages$1movement-engine');
    if (moved === live) throw error;
    return defaultResolver(request, { ...options, basedir: moved });
  }
};
