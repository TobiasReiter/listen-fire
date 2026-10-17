// The module kit end to end: a module defined once, loaded in process and
// served as a process, answers the same; its declarations pair with its
// methods or it does not load; the credential reaches it per call and what it
// changes is written back; a plugin module is invoked both ways; and
// `serve-module` serves a module file as a child process.

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { createMemoryVault, createSecretsFamily } from 'movement-engine/public/secrets';
import { makeMetaPosition } from 'movement-engine/public/catalog';
import { createRemoteAdapter, fetchRemoteManifest, type RemoteAdapter } from 'movement-engine/public/modules';

import type { ModuleCredential, ModuleHost, ModuleLog } from '../index';

import {
  ModuleAnswerInvalid,
  adapterInProcess,
  defineModule,
  inProcessValidationDefault,
  pluginSpecsOfManifest,
  pluginsInProcess,
  refusingFiles,
  refusingKv,
  serveModule,
} from '../index';
import notes from './modules/notes_module';
import shout from './modules/shout_module';

const NOTES = [
  { id: 'n1', title: 'First', at: 10 },
  { id: 'n2', title: 'Second', at: 20 },
];

const quiet: ModuleLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** The notes provider: answers with the notes after `since`, and keeps the
 *  authorization each request carried. */
async function notesProvider(): Promise<{ url: string; seen: string[]; close(): Promise<void> }> {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? '');
    const since = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('since') ?? '0');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(NOTES.filter((note) => note.at > since)));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((done) => server.close(() => done())) };
}

function memoryCredential(fields: Record<string, string>): ModuleCredential & { updates: Array<Record<string, string>> } {
  let current = { ...fields };
  const updates: Array<Record<string, string>> = [];
  return {
    name: 'notes',
    updates,
    fields: async () => current,
    update: async (changed) => {
      updates.push({ ...changed });
      current = { ...current, ...changed };
    },
  };
}

function host(credential: ModuleCredential, overrides: Partial<ModuleHost> = {}): ModuleHost {
  return {
    tenant: 'team-1',
    credential,
    log: quiet,
    files: refusingFiles('no files in this test'),
    kv: refusingKv('no kv in this test'),
    validateResults: true,
    ...overrides,
  };
}

async function served(definition: Parameters<typeof serveModule>[0]['definition']): Promise<{ url: string; close(): Promise<void> }> {
  const { port, server } = await serveModule({ definition, log: quiet });
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((done) => server.close(() => done())) };
}

async function remoteOver(url: string, vault: ReturnType<typeof createMemoryVault>): Promise<RemoteAdapter> {
  const config = { adapterType: 'notes', teamId: 'team-1', baseUrl: url, authStrategy: { kind: 'bearer' as const }, credentialsId: 'cred-1' };
  const manifest = await fetchRemoteManifest(config, '');
  return createRemoteAdapter({
    config,
    secret: '',
    cacheScopeId: 'scope-1',
    manifest,
    documents: { put: async () => ({}) } as never,
    credential: { name: 'notes', secrets: createSecretsFamily({ backend: vault }), ref: 'cred-1' },
  });
}

describe('defining a module', () => {
  it('refuses a manifest that names another adapter than its package', () => {
    expect(() => defineModule({ ...notes, name: '@lf/other' })).toThrow(/answers to "other"/);
  });

  it('declares what the protocol manifest carries, its methods read off what create built', () => {
    const loaded = adapterInProcess(notes, host(memoryCredential({ api_key: 'k' })));
    expect(loaded.manifest).toMatchObject({
      protocolVersion: 2,
      adapterType: 'notes',
      supportedTriggers: ['poll'],
      credentials: notes.credentials,
      poll: { intervalSeconds: 60 },
      periodic: [{ name: 'rotate_key', intervalSeconds: 3600 }],
      subscribableEvents: ['note_created'],
      listenConfig: [{ key: 'folder', required: false }],
    });
    expect(loaded.manifest.methods).toEqual(expect.arrayContaining(['manifest', 'listEntryPoints', 'getRelated', 'poll', 'runPeriodic']));
  });

  it('refuses to load a module whose declaration has no method, naming it', () => {
    const unpaired = defineModule({
      ...notes,
      create: (ctx) => {
        const { poll: _poll, ...rest } = notes.create(ctx);
        return rest;
      },
    });
    expect(() => adapterInProcess(unpaired, host(memoryCredential({})))).toThrow(/module @lf\/notes: its manifest is refused: methods: declares `poll`/);
  });
});

describe('in process', () => {
  it('reads through ctx: the credential per call, the base URL override, fetch', async () => {
    const provider = await notesProvider();
    try {
      const loaded = adapterInProcess(notes, host(memoryCredential({ api_key: 'k1' }), { baseUrlOverride: provider.url }));
      const related = await loaded.adapter.getRelated({ position: makeMetaPosition('notes'), fieldId: 'Notes', direction: 'outgoing' });
      expect(related.map((r) => r.position.recordType)).toEqual(['Note', 'Note']);
      expect(provider.seen).toEqual(['Bearer k1']);
      expect(await loaded.poll?.({ config: {}, checkpoint: 10 })).toEqual({
        events: [{ payload: NOTES[1], externalId: 'n2', tag: 'note_created' }],
        checkpoint: 20,
      });
    } finally {
      await provider.close();
    }
  });

  it('hands what the module changed in its credential to the host', async () => {
    const credential = memoryCredential({ api_key: 'k1' });
    await adapterInProcess(notes, host(credential)).runPeriodic?.('rotate_key');
    expect(credential.updates).toEqual([{ api_key: 'k1-rotated' }]);
  });

  it('validates each answer against the protocol when asked, and not when not', async () => {
    const broken = defineModule({
      ...notes,
      create: (ctx) => Object.assign(notes.create(ctx), { listEntryPoints: async () => [{ displayName: 7 }] as never }),
    });
    await expect(adapterInProcess(broken, host(memoryCredential({}))).adapter.listEntryPoints()).rejects.toThrow(ModuleAnswerInvalid);
    await expect(adapterInProcess(broken, host(memoryCredential({}), { validateResults: false })).adapter.listEntryPoints()).resolves.toEqual([{ displayName: 7 }]);
  });

  it('validates by default everywhere but hosted production', () => {
    expect(inProcessValidationDefault({ NODE_ENV: 'test' })).toBe(true);
    expect(inProcessValidationDefault({})).toBe(true);
    expect(inProcessValidationDefault({ NODE_ENV: 'production' })).toBe(false);
    expect(inProcessValidationDefault({ NODE_ENV: 'production', ADAPTER_VALIDATE: '1' })).toBe(true);
    expect(inProcessValidationDefault({ NODE_ENV: 'test', ADAPTER_VALIDATE: '0' })).toBe(false);
  });
});

describe('as a process', () => {
  it('answers what the in-process module answers, its credential sent per call', async () => {
    const provider = await notesProvider();
    const server = await served(notes);
    try {
      const vault = createMemoryVault({ 'cred-1': { api_key: 'k1', base_url: provider.url } });
      const remote = await remoteOver(server.url, vault);
      const local = adapterInProcess(notes, host(memoryCredential({ api_key: 'k1', base_url: provider.url })));
      const at = { position: makeMetaPosition('notes'), fieldId: 'Notes', direction: 'outgoing' as const };
      expect(await remote.getRelated(at)).toEqual(await local.adapter.getRelated(at));
      expect(await remote.listEntryPoints()).toEqual(await local.adapter.listEntryPoints());
      expect(await remote.poll({ config: {}, checkpoint: 10 })).toEqual(await local.poll?.({ config: {}, checkpoint: 10 }));
      expect(provider.seen).toEqual(['Bearer k1', 'Bearer k1', 'Bearer k1', 'Bearer k1']);
    } finally {
      await server.close();
      await provider.close();
    }
  });

  it('writes back what the module changed in its credential', async () => {
    const server = await served(notes);
    try {
      const vault = createMemoryVault({ 'cred-1': { api_key: 'k1' } });
      const remote = await remoteOver(server.url, vault);
      await remote.runPeriodic('rotate_key');
      expect((await vault.resolve('cred-1'))?.fields).toEqual({ api_key: 'k1-rotated' });
    } finally {
      await server.close();
    }
  });

  it('declares over the wire what it declares in process', async () => {
    const server = await served(notes);
    try {
      const wire = await fetchRemoteManifest(
        { adapterType: 'notes', teamId: 't', baseUrl: server.url, authStrategy: { kind: 'bearer' } },
        '',
      );
      const local = adapterInProcess(notes, host(memoryCredential({}))).manifest;
      expect(wire.methods).toEqual(local.methods);
      expect(wire.credentials).toEqual(local.credentials);
    } finally {
      await server.close();
    }
  });
});

describe('a plugin module', () => {
  it('lists its plugins as one package, for the checker', () => {
    const { manifest } = pluginsInProcess(shout, host(memoryCredential({})));
    expect(pluginSpecsOfManifest(manifest)).toEqual({
      shout: expect.objectContaining({ args: ['text'], priced: true, requiredArgs: ['text'], package: '@lf/shout' }),
    });
  });

  it('is invoked the same in process and as a process', async () => {
    const local = pluginsInProcess(shout, host(memoryCredential({})));
    const call = { name: 'shout', config: { text: 'hi' }, extractedContext: {} };
    const server = await served(shout);
    try {
      const config = { adapterType: 'shout', teamId: 't', baseUrl: server.url, authStrategy: { kind: 'bearer' as const }, credentialsId: '' };
      const remote = createRemoteAdapter({
        config,
        secret: '',
        cacheScopeId: 's',
        manifest: await fetchRemoteManifest(config, ''),
        documents: {} as never,
      });
      expect(await remote.invokePlugin(call)).toEqual({ text: 'HI', costMicrodollars: 2 });
      expect(await local.invoke(call)).toEqual({ text: 'HI', costMicrodollars: 2 });
    } finally {
      await server.close();
    }
  });
});

describe('serve-module', () => {
  it('serves a module file as a child process that prints the port it answers on', async () => {
    const bin = join(__dirname, '../bin/serve-module.cjs');
    const child = spawn(process.execPath, [bin, './__test__/modules/shout_module.ts'], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, PORT: '0' },
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
      const manifest = await fetchRemoteManifest(
        { adapterType: 'shout', teamId: 't', baseUrl: `http://127.0.0.1:${port}/`, authStrategy: { kind: 'bearer' } },
        '',
      );
      expect(manifest.methods).toEqual(['manifest', 'invokePlugin']);
    } finally {
      child.kill();
    }
  }, 30_000);
});

