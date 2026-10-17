// Plugin modules in lf: the bundled plugins' module, `@lf/web`, served by
// serve-module as any external is and called by its plugins' own names or
// through the package; and a custom plugin module (examples/lf-custom-plugin)
// dropped into a project's externals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { companies, lf, lfCommand, project } from './example';

const WEB = resolve(__dirname, '../../../../modules/web');
const CUSTOM_PLUGIN = resolve(__dirname, '../../../../examples/lf-custom-plugin');

const PAGE = `<html><head><title>Vireo</title><script>track()</script></head>
<body><h1>Vireo Robotics</h1><p>Vireo builds warehouse robots that pick, pack and restock shelves overnight.</p></body></html>`;

/** A web server with one page, keeping the paths asked for. */
async function site(): Promise<{ url: string; asked: string[]; close(): void }> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    asked.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, asked, close: () => server.close() };
}

/** `lf <args>` without blocking this process, which serves the page the run
 *  fetches. */
function lfAsync(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(...lfCommand(args), { cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('close', (code) => done({ code: code ?? -1, out }));
  });
}

/** The example with `@lf/web` as a plugin external and one movement whose
 *  body is `body`, reading the page at `url`. */
function webProject(imports: string, call: string): string {
  const dir = project();
  mkdirSync(join(dir, 'externals/web'));
  writeFileSync(join(dir, 'externals/web/lf-external.yaml'), `name: web\nkind: plugin\nmodule: ${JSON.stringify(WEB)}\n`);
  rmSync(join(dir, 'movements/companies.mvt'));
  writeFileSync(
    join(dir, 'movements/read.mvt'),
    `import { acme_crm } from adapters
${imports}
import { acme } from credentials

crm = connect acme_crm using acme

function read(company: <crm-[:Company]->>) {
  page = ${call}
  write crm-[:Company]-> { Name: Text.includes(page, "warehouse robots") ? "Read: robots" : "Read: \${page}" }
}

listen to crm { events: ["company.created"] } fire read
`,
  );
  return dir;
}

for (const [how, imports, call] of [
  ['by its own name', 'import { fetchUrl } from plugins', 'fetchUrl(URL)'],
  ['through the package', 'import { `@lf/web` as web } from plugins', 'web.fetchUrl(URL)'],
] as const) {
  test(`@lf/web as a process: fetchUrl ${how}, checked, called and its page read`, async () => {
    const page = await site();
    try {
      const dir = webProject(imports, call.replace('URL', JSON.stringify(`${page.url}/vireo`)));
      const check = await lfAsync(dir, 'check');
      assert.equal(check.code, 0, check.out);
      const run = await lfAsync(dir, 'run', '--event', 'events/company_created.json');
      assert.equal(run.code, 0, run.out);
      assert.deepEqual(companies(dir), ['Read: robots']);
      assert.deepEqual(page.asked, ['/vireo']);
    } finally {
      page.close();
    }
  });
}

test('a custom plugin module (examples/lf-custom-plugin) runs end to end', () => {
  const dir = project();
  cpSync(join(CUSTOM_PLUGIN, 'externals/words'), join(dir, 'externals/words'), { recursive: true });
  rmSync(join(dir, 'movements/companies.mvt'));
  cpSync(join(CUSTOM_PLUGIN, 'movements/initials.mvt'), join(dir, 'movements/initials.mvt'));
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  const run = lf(dir, 'run', '--event', 'events/company_created.json');
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(companies(dir), ['Vireo Robotics (VR)']);
});
