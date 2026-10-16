// W3-A2 — Test environment override.
//
// Runs in the worker process before any test file imports production
// code. Overrides `process.env.DATABASE_URL` to point at the test DB so
// the production Kysely pool (instantiated at module load in
// `lib/kysely.ts`) connects to the test database rather than the
// dev-loop.
//
// Why this is needed:
//
//   - The production `prisma/index.ts` branches on `NODE_ENV === 'test'`
//     and, when true, synthesises a per-process random schema name and
//     appends `?schema=<uuid>` to the connection URL. That mechanism is
//     incompatible with the harness's "real `public` + real `knowledge`
//     schema" requirement.
//
//   - Setting `NODE_ENV` to something other than `test` (e.g.
//     `integration`) takes the non-test branch, which requires
//     `DATABASE_URL` to be set and uses it directly with no schema
//     override.
//
//   - This file is wired via `setupFiles` in the integration jest
//     config so the env mutation happens before the test file imports
//     anything that touches `lib/kysely.ts`.

import path from 'node:path';

import dotenv from 'dotenv';

// Resolved from THIS file, not from the cwd, so the same `apps/api/.env` is
// found whether jest was started from the package or from the repo root.
dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

if (!process.env.DATABASE_URL_TEST) {
  throw new Error(
    '[W3-A2 harness] DATABASE_URL_TEST is not set. Add it to apps/api/.env or export it before running integration tests.',
  );
}

// Override `DATABASE_URL` so the production module-level Kysely pool
// in `lib/kysely.ts` connects to the test DB. Mirrors the readonly URL
// for symmetry; integration tests don't use the readonly client today
// but the prisma module requires the env var when NODE_ENV != 'test'.
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;

process.env.DATABASE_URL_READONLY =
  process.env.DATABASE_URL_TEST_READONLY ?? process.env.DATABASE_URL_TEST;

// Bypass the per-process random schema synthesis in `prisma/index.ts`
// — that's a unit-test convenience that doesn't compose with our
// "real knowledge + public schema" requirement. `prisma/index.ts`
// only treats `'test'` specially; anything else (including
// `'development'`) takes the production-style branch which reads
// `DATABASE_URL` directly (without the schema-uuid suffix).
//
// We use `'development'` (rather than e.g. `'integration'`) because
// `NodeJS.ProcessEnv['NODE_ENV']` is typed as
// `'development' | 'production' | 'test'` in this codebase.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process.env as any).NODE_ENV = 'development';
