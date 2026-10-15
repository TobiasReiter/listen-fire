// The catalog through the real `lf` binary: the external's manifest answer
// declares the events a listen may choose, so the checker refuses a listen
// config the external would never route, and routing honours the choice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { companies, lf, project } from './example';

function listenWith(dir: string, config: string): void {
  const path = join(dir, 'movements/companies.mvt');
  const source = readFileSync(path, 'utf8');
  const listen = /^listen to crm .* fire welcome$/m;
  assert.match(source, listen);
  writeFileSync(path, source.replace(listen, `listen to crm ${config} fire welcome`));
}

function event(dir: string, eventType: string): string {
  const path = join(dir, `events/${eventType}.json`);
  const file = JSON.parse(readFileSync(join(dir, 'events/company_created.json'), 'utf8')) as {
    event: Record<string, unknown>;
  };
  writeFileSync(path, JSON.stringify({ ...file, event: { ...file.event, eventType } }));
  return path;
}

test('lf check: a listen choosing one of the declared events is clean', () => {
  const dir = project();
  assert.match(readFileSync(join(dir, 'movements/companies.mvt'), 'utf8'), /listen to crm \{ events: \["company\.created"\] \}/);
  const { code, out } = lf(dir, 'check');
  assert.equal(code, 0, out);
  assert.match(out, /1 file\(s\), 0 error\(s\)/);
});

test('lf check: a config key the external does not declare is refused', () => {
  const dir = project();
  listenWith(dir, '{ colour: "red" }');
  const { code, out } = lf(dir, 'check');
  assert.equal(code, 1, out);
  assert.match(out, /MOV_LISTEN_BAD_CONFIG .*'colour'/);
});

test('lf check: an event the external does not declare is refused', () => {
  const dir = project();
  listenWith(dir, '{ events: ["company.deleted"] }');
  const { code, out } = lf(dir, 'check');
  assert.equal(code, 1, out);
  assert.match(out, /MOV_LISTEN_BAD_CONFIG .*'company\.deleted'/);
});

test('lf run: an event the listen did not choose is not routed; a chosen one is', () => {
  const dir = project();
  const skipped = lf(dir, 'run', '--ephemeral', '--event', event(dir, 'company.updated'));
  assert.equal(skipped.code, 0, skipped.out);
  assert.match(skipped.out, /no listen matched/);

  const routed = lf(dir, 'run', '--ephemeral', '--event', event(dir, 'company.created'));
  assert.equal(routed.code, 0, routed.out);
  assert.match(routed.out, /companies:welcome parked — 1 write\(s\)/);
  assert.deepEqual(companies(dir), ['Welcome Vireo Robotics']);
});
