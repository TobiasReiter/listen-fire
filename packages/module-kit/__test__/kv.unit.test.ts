// A module's kv: listing in creation order, refusing by name where a host has
// none, and kept in files (one per tenant) when serve-module is told where its
// state lives (`MODULE_STATE_DIR`), in process and as a child process. And the
// install's construction arguments a served module is given
// (`MODULE_CONSTRUCTION_ARGS`), since protocol 2 carries none.

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { createRemoteAdapter, fetchRemoteManifest } from 'movement-engine/public/modules';

import type { ModuleLog } from '../index';

import { fileKv, fileKvPath, parseConstructionArgs, refusingKv, serveModule, writeFileKv } from '../index';
import tally from './modules/tally_module';

const quiet: ModuleLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const stateDir = () => mkdtempSync(join(tmpdir(), 'module-kv-'));

async function invokeTally(url: string, teamId: string): Promise<unknown> {
  const config = { adapterType: 'tally', teamId, baseUrl: url, authStrategy: { kind: 'bearer' as const }, credentialsId: '' };
  const remote = createRemoteAdapter({ config, secret: '', cacheScopeId: 's', manifest: await fetchRemoteManifest(config, ''), documents: {} as never });
  return (await remote.invokePlugin({ name: 'tally', config: {}, extractedContext: {} })).data;
}

describe('a refusing kv', () => {
  it('refuses every method, list included, by the reason it was given', async () => {
    const kv = refusingKv('no kv here');
    await expect(kv.get('a')).rejects.toThrow('no kv here');
    await expect(kv.set('a', 1)).rejects.toThrow('no kv here');
    await expect(kv.delete('a')).rejects.toThrow('no kv here');
    await expect(kv.list('')).rejects.toThrow('no kv here');
  });
});

describe('a file kv', () => {
  it('gets what was set, and nothing for a key never set', async () => {
    const kv = fileKv(stateDir(), 'team-1');
    expect(await kv.get('a')).toBeUndefined();
    await kv.set('a', { mimeType: 'x', name: null });
    expect(await kv.get('a')).toEqual({ mimeType: 'x', name: null });
  });

  it('lists by prefix in the order keys were first set, a key set again keeping its place', async () => {
    const kv = fileKv(stateDir(), 'team-1');
    await kv.set('granted/b', 1);
    await kv.set('other', 2);
    await kv.set('granted/a', 3);
    await kv.set('granted/b', 4);
    expect(await kv.list('granted/')).toEqual([
      { key: 'granted/b', value: 4 },
      { key: 'granted/a', value: 3 },
    ]);
    await kv.delete('granted/b');
    expect(await kv.list('')).toEqual([
      { key: 'other', value: 2 },
      { key: 'granted/a', value: 3 },
    ]);
  });

  it('keeps one file per tenant, written whole by rename (no temporary file left)', async () => {
    const dir = stateDir();
    await fileKv(dir, 'team/1').set('a', 1);
    await fileKv(dir, 'team-2').set('a', 2);
    expect(await fileKv(dir, 'team/1').get('a')).toBe(1);
    expect(await fileKv(dir, 'team-2').get('a')).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(['team%2F1.json', 'team-2.json']);
    expect(fileKvPath(dir, 'team/1')).toBe(join(dir, 'team%2F1.json'));
  });

  it('loses no write when many land at once', async () => {
    const dir = stateDir();
    await Promise.all(Array.from({ length: 20 }, (_, i) => fileKv(dir, 'team-1').set(`k${i}`, i)));
    expect((await fileKv(dir, 'team-1').list('k')).length).toBe(20);
  });

  it('reads what was seeded beside it', async () => {
    const dir = stateDir();
    await writeFileKv(dir, 'team-1', [{ key: 'team/emails', value: ['a@x.test'] }]);
    expect(await fileKv(dir, 'team-1').get('team/emails')).toEqual(['a@x.test']);
  });

  it('refuses a request that names no tenant', async () => {
    await expect(fileKv(stateDir(), '').get('a')).rejects.toThrow('no tenant');
  });
});

describe('serve-module state', () => {
  it('keeps each tenant’s kv in its own file across requests', async () => {
    const dir = stateDir();
    const { port, server } = await serveModule({ definition: tally, log: quiet, stateDir: dir });
    try {
      const url = `http://127.0.0.1:${port}/`;
      expect(await invokeTally(url, 'team-1')).toEqual({ count: 1, keys: ['count'], args: {} });
      expect(await invokeTally(url, 'team-1')).toEqual({ count: 2, keys: ['count'], args: {} });
      expect(await invokeTally(url, 'team-2')).toEqual({ count: 1, keys: ['count'], args: {} });
      expect(await fileKv(dir, 'team-1').get('count')).toBe(2);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  it('refuses the kv by name when no state directory is given', async () => {
    const { port, server } = await serveModule({ definition: tally, log: quiet });
    try {
      await expect(invokeTally(`http://127.0.0.1:${port}/`, 'team-1')).rejects.toThrow('MODULE_STATE_DIR');
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  it('hands every request the install’s construction arguments', async () => {
    const { port, server } = await serveModule({ definition: tally, log: quiet, stateDir: stateDir(), constructionArgs: { spreadsheet: 'Pipeline' } });
    try {
      expect(await invokeTally(`http://127.0.0.1:${port}/`, 'team-1')).toEqual({ count: 1, keys: ['count'], args: { spreadsheet: 'Pipeline' } });
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  it('reads construction arguments as a JSON object of strings, or refuses', () => {
    expect(parseConstructionArgs('{"spreadsheet":"Pipeline"}')).toEqual({ spreadsheet: 'Pipeline' });
    expect(() => parseConstructionArgs('{"spreadsheet":1}')).toThrow('JSON object of strings');
    expect(() => parseConstructionArgs('["x"]')).toThrow('JSON object of strings');
  });

  it('takes MODULE_STATE_DIR from the environment as a child process', async () => {
    const dir = stateDir();
    await writeFileKv(dir, 'team-1', [{ key: 'count', value: 41 }]);
    const child = spawn(process.execPath, [join(__dirname, '../bin/serve-module.cjs'), './__test__/modules/tally_module.ts'], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, PORT: '0', MODULE_STATE_DIR: dir, MODULE_CONSTRUCTION_ARGS: '{"spreadsheet":"Pipeline"}' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no listening line in 20s')), 20_000);
        child.once('exit', (code) => reject(new Error(`exited ${code}`)));
        createInterface({ input: child.stdout! }).on('line', (line) => {
          const match = /^listening (\d+)$/.exec(line);
          if (match) {
            clearTimeout(timer);
            resolve(Number(match[1]));
          }
        });
      });
      expect(await invokeTally(`http://127.0.0.1:${port}/`, 'team-1')).toEqual({ count: 42, keys: ['count'], args: { spreadsheet: 'Pipeline' } });
      expect(await fileKv(dir, 'team-1').get('count')).toBe(42);
    } finally {
      child.kill();
    }
  }, 30_000);
});
