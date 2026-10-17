// What a module answers it spent on a paid service (an answer's `cost`)
// through the real binary: it rides the adapter call's answer into the
// engine's ledger, so the run's spend counts it once and the engine's account
// and lf's agree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { companies, lf, project } from './example';

test("an adapter call's answered cost is the run's spend, counted once", () => {
  const dir = project();
  const server = join(dir, 'externals', 'acme_crm', 'server.mjs');
  const answer = "send(res, 200, { ok: true, result: await handler(params ?? {}) });";
  const source = readFileSync(server, 'utf8');
  assert.ok(source.includes(answer), 'the sample external still answers this way');
  const priced = "send(res, 200, { ok: true, result: await handler(params ?? {}), ...(method === 'createRecord' ? { cost: [{ label: 'acme.enrich', microdollars: 1500 }] } : {}) });";
  writeFileSync(server, source.replace(answer, priced));

  const run = lf(dir, 'run', '--event', 'events/company_created.json');
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(companies(dir), ['Welcome Vireo Robotics']);
  const db = new DatabaseSync(join(dir, '.lf', 'state.db'));
  try {
    const rows = db.prepare('select spent_microdollars as spent from run').all() as Array<{ spent: number }>;
    assert.deepEqual(rows.map((r) => r.spent), [1500]);
  } finally {
    db.close();
  }
});
