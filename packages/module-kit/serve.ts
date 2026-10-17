// `serve-module`: any module as a protocol-2 process, so lf, the Rust host,
// the cloud and an embedder run a module one way. It prints
// `listening <port>` once it answers (the line lf's externals wait for), logs
// as JSON lines on stderr, and binds loopback unless told otherwise.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve as resolvePath } from 'node:path';

import type { ModuleDefinition, ModuleLog } from './define';

import { fileKv } from './file_kv';
import { refusingFiles, refusingKv } from './in_process';
import { createModuleProtocolHandler } from './module_server';

/** A log that writes one JSON line per entry to `write`. */
export function jsonLineLog(module: string, write: (line: string) => void): ModuleLog {
  const at =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void =>
      write(`${JSON.stringify({ level, module, message, ...(meta !== undefined ? { meta } : {}) })}\n`);
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
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
  /** Where the module's kv is kept, one file per tenant. Absent: the module
   *  has no kv, and using it is refused. */
  stateDir?: string;
  /** The install's construction arguments, for every request. */
  constructionArgs?: Readonly<Record<string, string>>;
}

export async function serveModule(options: ServeModuleOptions): Promise<{ port: number; server: Server }> {
  const { definition, token } = options;
  const log = options.log ?? jsonLineLog(definition.name, (line) => process.stderr.write(line));
  const unavailable = (what: string) =>
    `module ${definition.name}: ${what} is not available when the module is served as a process (protocol 2 carries files by URL and keeps no module state)`;
  const { stateDir } = options;
  const noKv = refusingKv(`${unavailable('ctx.kv')}; set MODULE_STATE_DIR to keep it in files`);
  const handler = createModuleProtocolHandler({
    definition,
    log,
    files: refusingFiles(unavailable('ctx.files')),
    kvFor: stateDir !== undefined ? (tenant) => fileKv(stateDir, tenant) : () => noKv,
    ...(options.baseUrlOverride !== undefined ? { baseUrlOverride: options.baseUrlOverride } : {}),
    ...(options.constructionArgs !== undefined ? { constructionArgs: options.constructionArgs } : {}),
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

/** A JSON object of strings (`MODULE_CONSTRUCTION_ARGS`), or a refusal. */
export function parseConstructionArgs(text: string): Record<string, string> {
  const refuse = (): never => {
    throw new Error('serve-module: MODULE_CONSTRUCTION_ARGS is a JSON object of strings, e.g. {"spreadsheet":"Pipeline"}');
  };
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return refuse();
  const args: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) args[name] = typeof value === 'string' ? value : refuse();
  return args;
}

/** The command line: `serve-module <module> [--port N] [--host H]`; PORT,
 *  MODULE_TOKEN, MODULE_BASE_URL_OVERRIDE, MODULE_STATE_DIR and
 *  MODULE_CONSTRUCTION_ARGS from the environment. */
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
    ...(env.MODULE_STATE_DIR !== undefined && env.MODULE_STATE_DIR !== '' ? { stateDir: env.MODULE_STATE_DIR } : {}),
    ...(env.MODULE_CONSTRUCTION_ARGS !== undefined && env.MODULE_CONSTRUCTION_ARGS !== ''
      ? { constructionArgs: parseConstructionArgs(env.MODULE_CONSTRUCTION_ARGS) }
      : {}),
  });
  process.stdout.write(`listening ${served.port}\n`);
}
