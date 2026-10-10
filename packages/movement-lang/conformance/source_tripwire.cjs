// Fails a jest run loudly when movement-lang resolves to a compiled .js copy
// instead of its TypeScript sources. The conformance setups pin the language
// version with jest.mock on language_version.ts; a compiled copy beside it is
// a different module, so the mock misses and a v1 corpus silently runs
// current behaviour. See the cure in the message.
const path = require('path');

const CURE =
  'Delete the compiled files beside the sources (every .js under packages/movement-lang ' +
  'outside node_modules and dist). Compile only through the package\'s own build script, ' +
  'which emits to dist/ — never a bare tsc in the package.';

function assertResolvesToSource(label, resolved) {
  if (!resolved.endsWith('.ts')) {
    throw new Error(
      `movement-lang tripwire: ${label} resolved to ${resolved}, not a .ts source. ` +
        `A compiled copy is shadowing the sources, so version mocks no longer reach the code under test. ${CURE}`,
    );
  }
}

// `resolve` is the caller's require.resolve (jest's, inside a test run), so the
// answer is the one the module under test would get.
function assertSourcesResolve(resolve, specifiers) {
  const packageDir = path.resolve(__dirname, '..');
  const targets = specifiers ?? [packageDir, path.join(packageDir, 'language_version')];
  for (const specifier of targets) assertResolvesToSource(specifier, resolve(specifier));
}

module.exports = { assertResolvesToSource, assertSourcesResolve };
