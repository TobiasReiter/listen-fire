// `serve-module`: any module as a protocol-2 process, so lf, the Rust host,
// the cloud and an embedder run a module one way. It prints
// `listening <port>` once it answers (the line lf's externals wait for), logs
// as JSON lines on stderr, and binds loopback unless told otherwise.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve as resolvePath } from 'node:path';

import type { ModuleDefinition, ModuleFiles, ModuleLog } from './define';

import { refusingKv } from './in_process';
import { createModuleProtocolHandler } from './module_server';

/** A log that writes one JSON line per entry to `write`. */
export function jsonLineLog(module: string, write: (line: string) => void): ModuleLog {
  const at =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void =>
      write(`${JSON.stringify({ level, module, message, ...(meta !== undefined ? { meta } : {}) })}\n`);
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** The files of a served module: a file value the host handed in carries a URL
 *  (protocol 2 moves bytes by URL), which is where its bytes are read; nothing
 *  is kept for the module. */
function urlFiles(module: string): ModuleFiles {
  const refuse = (what: string) => new Error(`module ${module}: ${what} is not available when the module is served as a process (protocol 2 keeps no module files)`);
  return {
    read: async (ref) => {
      if (typeof ref.url !== 'string' || ref.url === '') throw new Error(`module ${module}: the file${ref.name !== undefined ? ` '${ref.name}'` : ''} carries no URL to read its bytes from`);
      const response = await fetch(ref.url);
      if (!response.ok) throw new Error(`module ${module}: reading the file${ref.name !== undefined ? ` '${ref.name}'` : ''} answered HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    put: async () => {
      throw refuse('ctx.files.put');
    },
  };
}

export interface ServeModuleOptions {
  definition: ModuleDefinition;
  /** 0 (the default) picks a free one. */
  port?: number;
  /** Default 127.0.0.1. */
  host?: string;
  /** When set, every request must carry `Authorization: Bearer <token>`. */
  token?: string;
  baseUrlOverride?: string;
  log?: ModuleLog;
}

export async function serveModule(options: ServeModuleOptions): Promise<{ port: number; server: Server }> {
  const { definition, token } = options;
  const log = options.log ?? jsonLineLog(definition.name, (line) => process.stderr.write(line));
  const unavailable = (what: string) =>
    `module ${definition.name}: ${what} is not available when the module is served as a process (protocol 2 carries files by URL and keeps no module state)`;
  const handler = createModuleProtocolHandler({
    definition,
    log,
    files: urlFiles(definition.name),
    kv: refusingKv(unavailable('ctx.kv')),
    ...(options.baseUrlOverride !== undefined ? { baseUrlOverride: options.baseUrlOverride } : {}),
    ...(token !== undefined ? { authenticate: (headers) => headers.authorization === `Bearer ${token}` } : {}),
  });
  const server = createServer((req, res) => {
    handler(req, res).catch((error: unknown) => {
      log.error('request failed outside the envelope', { error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((done) => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', done));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === 'string') throw new Error('serve-module: the server is not listening on a port');
  return { port: address.port, server };
}

/** Whether a loaded value is a module definition (its default export, or
 *  `module`). Checked by shape: the file is the operator's, not ours. */
export function isModuleDefinition(value: unknown): value is ModuleDefinition {
  if (value === null || typeof value !== 'object') return false;
  const kind: unknown = Reflect.get(value, 'kind');
  return (
    (kind === 'adapter' || kind === 'plugin') &&
    typeof Reflect.get(value, 'name') === 'string' &&
    typeof Reflect.get(value, 'create') === 'function' &&
    Array.isArray(Reflect.get(value, 'credentials'))
  );
}

/** Load the module a path or package name names, relative to `cwd`. */
export function loadModuleDefinition(specifier: string, cwd: string): ModuleDefinition {
  const target = specifier.startsWith('.') || specifier.startsWith('/') ? resolvePath(cwd, specifier) : specifier;
  const loaded: unknown = require(require.resolve(target, { paths: [cwd] }));
  for (const candidate of [loaded, Reflect.get(Object(loaded), 'default'), Reflect.get(Object(loaded), 'module')]) {
    if (isModuleDefinition(candidate)) return candidate;
  }
  throw new Error(`serve-module: ${specifier} exports no module (a default export or \`module\` made with defineModule)`);
}

/** The command line: `serve-module <module> [--port N] [--host H]`; PORT,
 *  MODULE_TOKEN and MODULE_BASE_URL_OVERRIDE from the environment. */
export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<void> {
  const args = [...argv];
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    if (at < 0) return undefined;
    const [, value] = args.splice(at, 2);
    return value;
  };
  const port = flag('--port') ?? env.PORT;
  const host = flag('--host');
  const [specifier] = args;
  if (specifier === undefined) throw new Error('usage: serve-module <module> [--port N] [--host H]');
  const definition = loadModuleDefinition(specifier, process.cwd());
  const served = await serveModule({
    definition,
    ...(port !== undefined ? { port: Number(port) } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(env.MODULE_TOKEN !== undefined && env.MODULE_TOKEN !== '' ? { token: env.MODULE_TOKEN } : {}),
    ...(env.MODULE_BASE_URL_OVERRIDE !== undefined && env.MODULE_BASE_URL_OVERRIDE !== '' ? { baseUrlOverride: env.MODULE_BASE_URL_OVERRIDE } : {}),
  });
  process.stdout.write(`listening ${served.port}\n`);
}
