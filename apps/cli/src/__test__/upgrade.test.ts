// `lf upgrade`, through the real binary entry point, on the example project
// (written in the version 4 spelling): `--check` shows the rewrite and writes
// nothing, `lf upgrade` rewrites the file so `lf check` is clean, and a second
// run changes nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lf, project } from './example';

const OLD = `import { acme_crm } from adapters
import { acme } from credentials

crm = acme_crm(credentials: acme)

# A company created in the CRM is welcomed at once — then followed up.
movement welcome(company: <crm-[:Company]->>) {
  write crm-[:Company]-> { Name: Text.concat("Welcome ", UPPER(company.Name)) }
  await sleep(1h)
}

listen to crm { events: ["company.created"] } fire welcome
`;

test('lf upgrade --check prints the rewrite; lf upgrade makes it; a second run changes nothing', () => {
  const dir = project();
  const file = join(dir, 'movements', 'companies.mvt');
  writeFileSync(file, OLD);

  const checked = lf(dir, 'upgrade', '--check');
  assert.equal(checked.code, 1, checked.out);
  assert.match(checked.out, /^-crm = acme_crm\(credentials: acme\)$/m);
  assert.match(checked.out, /^\+crm = connect acme_crm using acme$/m);
  assert.match(checked.out, /1 file\(s\), 1 would be rewritten, 0 left to change by hand/);
  assert.equal(readFileSync(file, 'utf8'), OLD);

  const upgraded = lf(dir, 'upgrade');
  assert.equal(upgraded.code, 0, upgraded.out);
  assert.equal(
    readFileSync(file, 'utf8'),
    OLD.replace('acme_crm(credentials: acme)', 'connect acme_crm using acme')
      .replace('movement welcome', 'function welcome')
      .replace('UPPER(company.Name)', 'Text.upper(company.Name)'),
  );
  assert.equal(lf(dir, 'check').code, 0);

  const again = lf(dir, 'upgrade', '--check');
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /1 file\(s\), 0 would be rewritten, 0 left to change by hand/);
});

test('lf upgrade reports what it cannot rewrite, by file and line', () => {
  const dir = project();
  const file = join(dir, 'movements', 'companies.mvt');
  writeFileSync(file, OLD.replace('Name: Text.concat', 'Nme: Text.concat'));
  const { code, out } = lf(dir, 'upgrade');
  assert.equal(code, 1, out);
  assert.match(out, /^movements\/companies\.mvt:8:\d+ error MOV_WRITE_UNKNOWN_FIELD /m);
  assert.match(readFileSync(file, 'utf8'), /^crm = connect acme_crm using acme$/m);
});
