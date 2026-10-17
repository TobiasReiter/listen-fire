// Borrows apps/api's ts-jest install rather than carrying a jest install of its
// own — the same arrangement engine-contracts uses. Transpile only:
// types are owned by `pnpm code:type-check`. Run via `pnpm test` in this
// package.
const path = require('path');

const API_NODE_MODULES = path.resolve(__dirname, '../../apps/api/node_modules');

module.exports = {
  rootDir: __dirname,
  testMatch: ['**/*.unit.test.ts'],
  testEnvironment: 'node',
  maxWorkers: 1,
  clearMocks: true,
  // Sources are the truth: resolve `.ts` before any stray compiled `.js`.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'json', 'node'],
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
