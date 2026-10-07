export default {
  clearMocks: true,
  maxWorkers: '50%',
  testMatch: ['**/*.unit.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/__conformance__/'],
  preset: 'ts-jest',
  // Transpile only: types are owned by `pnpm code:type-check`.
  transform: { '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true, diagnostics: false }] },
  testEnvironment: 'node',
  rootDir: '.',
  // Resolve TypeScript sources BEFORE any compiled `.js`. ts-jest's preset
  // default lists `.js` first, so a stray `tsc` build (the `build` script,
  // or apps/api's prod build run locally) would shadow the sources and make
  // tests run stale code. Sources are always the truth here.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'json', 'node'],
};
