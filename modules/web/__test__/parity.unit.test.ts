// Recorded parity, off the platform. The platform's own parity test
// (apps/api engine/transforms/__test__/web_plugins_parity) holds the module to
// the legacy plugins' service calls and answers, and records here what each
// plugin asked of its tools and what the module answered. These replay that
// recording in process and through serve-module as a child process, called
// over adapter protocol 2: the same asks, in the same order, and the same
// answer — so a host that is not the platform runs exactly the plugin the
// platform runs.

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { noCredential, pluginsInProcess, refusingFiles, refusingKv } from 'module-kit';
import { createRemoteAdapter, fetchRemoteManifest, type RemoteAdapter } from 'movement-engine/public/modules';
import { type RecordedInvocation } from './replay_tools';
import { replayWebModule } from './modules/replay_web';

const recorded = JSON.parse(readFileSync(join(__dirname, '__fixtures__/web_tools_parity.json'), 'utf8')) as RecordedInvocation[];
const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

const call = (c: RecordedInvocation) => ({ name: c.plugin, config: c.config, extractedContext: c.extractedContext });

describe('in process', () => {
  const module = pluginsInProcess(replayWebModule, {
    tenant: 't',
    credential: noCredential('none'),
    log: quiet,
    files: refusingFiles('none'),
    kv: refusingKv('none'),
    validateResults: true,
  });

  it.each(recorded.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    expect(JSON.parse(JSON.stringify(await module.invoke(call(c))))).toEqual(c.answer);
  });
});

describe('as a process (serve-module, protocol 2)', () => {
  let child: ChildProcess;
  let remote: RemoteAdapter;

  beforeAll(async () => {
    const bin = join(__dirname, '../../../packages/module-kit/bin/serve-module.cjs');
    child = spawn(process.execPath, [bin, './__test__/modules/replay_web.ts'], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no listening line in 30s')), 30_000);
      child.once('exit', (code) => reject(new Error(`serve-module exited ${code}`)));
      createInterface({ input: child.stdout! }).on('line', (line) => {
        const match = /^listening (\d+)$/.exec(line);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
    });
    const config = { adapterType: 'web', teamId: 't', baseUrl: `http://127.0.0.1:${port}/`, authStrategy: { kind: 'bearer' as const }, credentialsId: '' };
    const manifest = await fetchRemoteManifest(config, '');
    expect(manifest.methods).toEqual(['manifest', 'invokePlugin']);
    remote = createRemoteAdapter({ config, secret: '', cacheScopeId: 's', manifest, documents: { put: async () => ({}) } as never });
  }, 40_000);

  afterAll(() => {
    child?.kill();
  });

  it.each(recorded.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    expect(await remote.invokePlugin(call(c))).toEqual(c.answer);
  });
});
