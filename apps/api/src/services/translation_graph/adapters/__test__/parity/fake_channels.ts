// One fake-channels service, booted on its own throwaway database and an
// ephemeral port, for RECORDING a parity fixture only (replay needs no
// provider). A child process under fake-channels' own tsx, because that app
// is not a dependency of this one and its store needs better-sqlite3. The
// seed is the dev loop's (`seedDefaults`), so a recording walks the same
// fixtures the dev loop does.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const FAKE_CHANNELS = resolve(__dirname, '../../../../../../../fake-channels');

export interface FakeChannelsRoute {
  /** The routes file under fake-channels/src/routes (`sheets`). */
  file: string;
  /** Its router factory (`sheetsRoutes`). */
  factory: string;
  /** Where the router is mounted (`/sheets`, or `/` for a service served from the root). */
  mount: string;
}

export async function bootFakeChannels(route: FakeChannelsRoute): Promise<{ baseUrl: string; stop(): void }> {
  const db = join(mkdtempSync(join(tmpdir(), `${route.file}-parity-`)), 'fake-channels.db');
  const boot = `
const express = require('express');
const { EntityStore } = require('./src/store');
const { seedDefaults } = require('./src/seed');
const { ${route.factory} } = require('./src/routes/${route.file}');
const store = new EntityStore(process.env.PARITY_DB);
seedDefaults(store);
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(${JSON.stringify(route.mount)}, ${route.factory}(store));
const server = app.listen(0, '127.0.0.1', () => console.log('listening ' + server.address().port));
`;
  const child = spawn(join(FAKE_CHANNELS, 'node_modules/.bin/tsx'), ['--eval', boot], {
    cwd: FAKE_CHANNELS,
    env: { ...process.env, PARITY_DB: db },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`fake ${route.file} did not start within 20s`)), 20_000);
    child.once('exit', (code) => reject(new Error(`fake ${route.file} exited (${code})`)));
    if (child.stdout === null) return;
    createInterface({ input: child.stdout }).on('line', (line) => {
      const match = /^listening (\d+)/.exec(line);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
  });
  const mount = route.mount === '/' ? '' : route.mount;
  return { baseUrl: `http://127.0.0.1:${port}${mount}`, stop: () => child.kill() };
}
