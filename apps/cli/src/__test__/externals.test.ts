// Externals through the hosted product's own adapter path: a file a movement
// makes crosses to an external as a URL the document store's local backend
// serves; a dry run captures its writes instead of making them; a run that
// calls an external too often is stopped at the segment's call ceiling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LF, companies, lf, project } from './example';

const STATE = '.lf/externals/acme_crm/state.json';

/** The example with one movement in place of its own: it writes a FILE(). */
function reportProject(): string {
  const dir = project();
  rmSync(join(dir, 'movements/companies.mvt'));
  writeFileSync(
    join(dir, 'movements/reports.mvt'),
    `import { acme_crm } from adapters
import { acme } from credentials

crm = connect acme_crm using acme

function report(company: <crm-[:Company]->>) {
  write crm-[:Company]-> { Name: "Report ${'$'}{company.Name}", Report: File.from("Hello ${'$'}{company.Name}", "text") }
}

listen to crm { events: ["company.created"] } fire report
`,
  );
  return dir;
}

test('a FILE() written to an external crosses as a URL the local document store serves', () => {
  const dir = reportProject();
  const run = lf(dir, 'run', '--event', 'events/company_created.json');
  assert.equal(run.code, 0, run.out);
  const state = JSON.parse(readFileSync(join(dir, STATE), 'utf8')) as {
    companies: Array<{ fields: { Name: string; Report: { text: string; contentType: string } } }>;
  };
  assert.equal(state.companies[0]?.fields.Name, 'Report Vireo Robotics');
  assert.deepEqual(
    { text: state.companies[0]?.fields.Report.text, contentType: state.companies[0]?.fields.Report.contentType },
    { text: 'Hello Vireo Robotics', contentType: 'text/plain' },
  );
});

test('lf run --dry-run captures the writes and makes none', () => {
  const dir = project();
  const run = lf(dir, 'run', '--dry-run', '--event', 'events/company_created.json');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /dry run, not written: .*"kind":"create".*Welcome Vireo Robotics/);
  assert.ok(!existsSync(join(dir, STATE)) || companies(dir).length === 0, 'nothing reached the external');
});

test('a run past the call ceiling is stopped, naming the knob', () => {
  const dir = project();
  const run = spawnSync(process.execPath, [LF, 'run', '--event', 'events/company_created.json'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1', REMOTE_ADAPTER_MAX_CALLS_PER_RUN: '1' },
  });
  const out = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 1, out);
  assert.match(out, /call ceiling reached.*REMOTE_ADAPTER_MAX_CALLS_PER_RUN/);
});
