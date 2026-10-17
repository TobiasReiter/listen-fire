// A segment's wall clock (MOVEMENT_MAX_SEGMENT_SECONDS) through the real
// binary: the run fails coded MOVENG_LIMIT_WALL_CLOCK, and a write in flight
// when the clock runs out is waited for, past the grace a read would get,
// rather than cut off mid-flight.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { companies, lfCommand, project } from './example';

const WRITE_SECONDS = 7;

test('past its wall clock a segment fails, and the write in flight still lands', () => {
  const dir = project();
  const server = join(dir, 'externals', 'acme_crm', 'server.mjs');
  const createRecord = 'createRecord: async ({ recordType, fields: written }) => {';
  const source = readFileSync(server, 'utf8');
  assert.ok(source.includes(createRecord), 'the sample external still has its createRecord');
  writeFileSync(server, source.replace(createRecord, `${createRecord}\n    await new Promise((r) => setTimeout(r, ${WRITE_SECONDS * 1000}));`));

  const started = Date.now();
  const run = spawnSync(...lfCommand(['run', '--event', 'events/company_created.json']), {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1', MOVEMENT_MAX_SEGMENT_SECONDS: '1' },
  });
  const seconds = (Date.now() - started) / 1000;
  const out = `${run.stdout}${run.stderr}`;

  assert.match(out, /MOVENG_LIMIT_WALL_CLOCK/, out);
  assert.ok(seconds >= WRITE_SECONDS, `lf stopped after ${seconds}s, before the write in flight finished`);
  assert.deepEqual(companies(dir), ['Welcome Vireo Robotics']);
});
