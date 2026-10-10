// eslint-disable-next-line local-rules/bottom-exports
export default {
  // Automatically clear mock calls and instances between every test
  clearMocks: true,

  // Half the cores. Each worker is recycled past the idle-memory bound so
  // leaked module state (Prisma clients, compiled modules) cannot accumulate
  // across hundreds of suites and walk a worker off the heap.
  maxWorkers: '50%',
  workerIdleMemoryLimit: '3GB',

  // Open Prisma/Kysely handles otherwise keep a finished run alive (one
  // worktree run sat >35 min after its last suite).
  forceExit: true,

  rootDir: '../../',

  // Inert env defaults so a suite whose import graph reaches an env-reading
  // module (prisma, kysely, the adapters) loads without an `apps/api/.env` and
  // without touching a real system. A developer's own `.env` still wins — see
  // the file header. Without this, a fresh clone could not run ANY scoped unit
  // test: the first import of `prisma/index.ts` threw at module load.
  setupFiles: ['<rootDir>/src/test/test-env-defaults.ts'],

  // The glob patterns Jest uses to detect test files
  testMatch: ['**/*.unit.test.ts'],
  // Older language versions' corpora run under their own version, via
  // jest-conformance-v<n>.config.ts — never under the current one.
  testPathIgnorePatterns: ['/node_modules/', '/__conformance__/'],
  // ts-jest required for Prisma >= 5.10.x (babel-jest cannot load the client).
  // Transpile only: types are owned by `pnpm code:type-check`, and per-worker
  // type-checking was most of each suite's fixed cost.
  preset: 'ts-jest',
  transform: { '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true, diagnostics: false }] },
  testEnvironment: 'node',

  // Sources before compiled output. The preset's default order tries `.js`
  // first, so a compiled copy beside a source (a package compiled in place)
  // would shadow it and any `jest.mock` of the source path would miss.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'json', 'node'],
  setupFilesAfterEnv: ['<rootDir>/src/test/movement_lang_source.setup.ts'],
};
