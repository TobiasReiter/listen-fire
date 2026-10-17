// The store slot through the real `lf` binary: a third-party store module
// (store_module/forward.mjs, a process lf drives over the store wire) keeps a
// run's state, and an event carrying an `idempotencyKey` runs each listen
// once — over the default SQLite store and over the store module alike.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { companies, lf, project } from './example';
import { withStoreModule } from './store_module/project';

function moduleProject(): { dir: string; statePath: string } {
  const dir = project();
  const statePath = join(mkdtempSync(join(tmpdir(), 'lf-store-module-')), 'kept.db');
  withStoreModule(dir, statePath);
  return { dir, statePath };
}

test('a store module fills the store slot: lf run keeps its run there', () => {
  const { dir, statePath } = moduleProject();
  const run = lf(dir, 'run', '--event', 'events/company_created.json');
  assert.equal(run.code, 0, run.out);
  const runId = /^run (\S+) companies:\S+ (?:completed|parked)/m.exec(run.out)?.[1];
  assert.ok(runId !== undefined, run.out);
  assert.match(lf(dir, 'runs').out, new RegExp(`^${runId} .* (?:completed|parked)$`, 'm'));
  // The module's own state file holds it; lf's default one was never made.
  assert.match(lf(dir, 'runs', '--store', statePath).out, new RegExp(`^${runId} `, 'm'));
  assert.throws(() => readFileSync(join(dir, '.lf/state.db')));
});

test('lf connect lists an installed store module beside the built-ins', () => {
  const { dir } = moduleProject();
  assert.match(lf(dir, 'connect').out, /^acme_store {2}installed store module; set up \(lf connect acme_store\)$/m);
});

function keyedEvent(dir: string, key: string): string {
  const file = join(dir, 'events/keyed.json');
  const event = JSON.parse(readFileSync(join(dir, 'events/company_created.json'), 'utf8')) as { event: Record<string, unknown> };
  event.event.idempotencyKey = key;
  writeFileSync(file, JSON.stringify(event));
  return 'events/keyed.json';
}

for (const [over, make] of [
  ['the SQLite store', () => project()],
  ['a store module', () => moduleProject().dir],
] as const) {
  test(`${over}: a redelivered event (same idempotencyKey) runs nothing; a dry run notes no receipt`, () => {
    const dir = make();
    const event = keyedEvent(dir, 'delivery-1');
    const dry = lf(dir, 'run', '--dry-run', '--event', event);
    assert.equal(dry.code, 0, dry.out);
    const first = lf(dir, 'run', '--event', event);
    assert.match(first.out, /^run \S+ companies:\S+ (?:completed|parked)/m);
    const again = lf(dir, 'run', '--event', event);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /has run the event delivery-1 before: this delivery runs nothing/);
    assert.doesNotMatch(again.out, /^run /m);
    assert.equal(companies(dir).length, 1, companies(dir).join(', '));
    // Another key is another occurrence.
    assert.match(lf(dir, 'run', '--event', keyedEvent(dir, 'delivery-2')).out, /^run \S+ companies:\S+ (?:completed|parked)/m);
  });
}
