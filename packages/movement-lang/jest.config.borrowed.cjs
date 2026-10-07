// movement-lang's own jest install is broken locally (stale pnpm symlinks —
// see packages/movement-lang/CLAUDE.md "Local gotchas"). This config borrows
// apps/api's ts-jest transform instead of reinstalling jest here, and points
// rootDir back at this package. Named `.cjs` because this package's
// .gitignore excludes `*.js` (guards against a stray tsc build shadowing
// sources — see "Local gotchas" in CLAUDE.md). Run via `pnpm test` in this
// package (see package.json) — do not invoke jest directly against
// jest.config.ts, which requires the package's own (broken) install.
const path = require('path');
const API_NODE_MODULES = path.resolve(__dirname, '../../apps/api/node_modules');

module.exports = {
  rootDir: __dirname,
  testMatch: ['**/*.unit.test.ts'],
  // Older language versions' corpora run under their own version, via
  // jest.conformance.v<n>.cjs — never under the current one.
  testPathIgnorePatterns: ['/node_modules/', '/__conformance__/'],
  testEnvironment: 'node',
  maxWorkers: '50%',
  clearMocks: true,
  // Resolve TypeScript sources before any stray compiled `.js` — see the
  // same rationale in jest.config.ts.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'json', 'node'],
  // Transpile only: types are owned by `pnpm code:type-check`.
  transform: {
    '^.+\\.tsx?$': [
      path.join(API_NODE_MODULES, 'ts-jest'),
      {
        tsconfig: { target: 'es2022', module: 'commonjs', esModuleInterop: true, strict: true },
        isolatedModules: true,
        diagnostics: false,
      },
    ],
  },
  modulePaths: [API_NODE_MODULES],
};
