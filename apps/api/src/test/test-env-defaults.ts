// Inert env defaults for the jest suites.
//
// Several modules read env at MODULE LOAD (`getEnvVar`/`requireEnv` at top
// level) — e.g. `prisma/index.ts` and the inbound/outbound adapters. Importing
// any of them in a test therefore requires those vars to exist, even though the
// test mocks the actual integration. Locally that env comes from `apps/api/.env`;
// a fresh clone and CI have no `.env`, so the suites died at module load (the
// first missing one being DATABASE_URL_TEST).
//
// So this setup file does two things, in order:
//
//   1. Loads `apps/api/.env` if the developer has one. Jest loads no dotenv of
//      its own, and the path is resolved from THIS file rather than from the
//      cwd, so it finds the same `.env` whether jest was started from the
//      package or from the repository root.
//   2. Fills whatever is still missing with INERT, fake values, so the suites
//      load without any `.env` and WITHOUT pointing at a real system.
//
// `??=` never overrides a value that is already set, so an exported shell
// value, a CI workflow env (e.g. the ephemeral postgres service URL for
// DATABASE_URL_TEST) and a real local `.env` all win over the defaults below,
// in that order.

import path from 'node:path';

import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  // DB: a throwaway CI postgres service. Overridden by .env locally and by the
  // workflow env in CI. prisma connects on import, so this must be reachable —
  // it points at an ephemeral CI container, never a real database.
  DATABASE_URL_TEST: 'postgresql://test:test@localhost:5432/test',
  DATABASE_URL_TEST_READONLY: 'postgresql://test:test@localhost:5432/test',
  // Inert external-service config — tests mock these integrations; the values
  // exist only to satisfy module-load `getEnvVar` and must not resolve to a
  // real host.
  API_BASE_URL: 'http://localhost:0',
  GOOGLE_STORAGE_BUCKET_NAME: 'test-bucket',
  // The auth token module reads these at load (billing notices pulled it into
  // the movement-engine import graph); signing/verification in tests only ever
  // round-trips against these same inert values.
  SESSION_JWT_AUDIENCE: 'test-audience',
  TOKEN_SECRET: 'test-token-secret',
  // The shared WhatsApp number the manifest quotes. Reserved-range, so a test
  // that renders it can never name a routable number.
  WHATSAPP_MOVEMENTS_NUMBER: '+447700900000',
  // The address inbound mail routes on. It has no default in the code — one
  // would point every deployment at Listen-Fire — so the fixtures name the
  // deployment they were written against.
  INBOUND_EMAIL_ADDRESS: 'inbox@example.com',
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
