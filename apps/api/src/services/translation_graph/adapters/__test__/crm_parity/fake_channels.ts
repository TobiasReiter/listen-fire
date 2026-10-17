// The fake-channels provider for one CRM, booted on its own throwaway
// database, for RECORDING a parity fixture only (replay needs no provider). A
// child process under fake-channels' own tsx, because that app is not a
// dependency of this one and its store needs better-sqlite3. Mounted exactly
// as fake-channels mounts it (`/<route>`), JSON and form bodies parsed as there.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const FAKE_CHANNELS = resolve(__dirname, '../../../../../../../fake-channels');

export type FakeCrm = 'affinity' | 'airtable' | 'attio';

function boot(route: FakeCrm): string {
  return `
const express = require('express');
const { EntityStore } = require('./src/store');
const { seedDefaults } = require('./src/seed');
const { ${route}Routes } = require('./src/routes/${route}');
const store = new EntityStore(process.env.PARITY_DB);
seedDefaults(store);
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/${route}', ${route}Routes(store));
const server = app.listen(0, '127.0.0.1', () => console.log('listening ' + server.address().port));
`;
}

export async function bootFakeCrm(route: FakeCrm): Promise<{ baseUrl: string; stop(): void }> {
  const db = join(mkdtempSync(join(tmpdir(), `${route}-parity-`)), 'fake-channels.db');
  const child = spawn(join(FAKE_CHANNELS, 'node_modules/.bin/tsx'), ['--eval', boot(route)], {
    cwd: FAKE_CHANNELS,
    env: { ...process.env, PARITY_DB: db },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`fake ${route} did not start within 20s`)), 20_000);
    child.once('exit', (code) => reject(new Error(`fake ${route} exited (${code})`)));
    if (child.stdout === null) return;
    createInterface({ input: child.stdout }).on('line', (line) => {
      const match = /^listening (\d+)/.exec(line);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
  });
  return { baseUrl: `http://127.0.0.1:${port}/${route}`, stop: () => child.kill() };
}
