// `serve-module`: any module as a protocol-2 process, so lf, the Rust host,
// the cloud and an embedder run a module one way. It prints
// `listening <port>` once it answers (the line lf's externals wait for), logs
// as JSON lines on stderr, and binds loopback unless told otherwise.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve as resolvePath } from 'node:path';

import type { ModuleDefinition, ModuleLog, ModuleModels } from './define';

import { fileKv } from './file_kv';
import { refusingFiles, refusingKv, refusingModels } from './in_process';
import { createModuleProtocolHandler } from './module_server';

/** A log that writes one JSON line per entry to `write`. */
export function jsonLineLog(module: string, write: (line: string) => void): ModuleLog {
  const at =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void =>
      write(`${JSON.stringify({ level, module, message, ...(meta !== undefined ? { meta } : {}) })}\n`);
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** The host part of this server's own URL: a wildcard bind is reached at
 *  loopback (a caller elsewhere needs MODULE_PUBLIC_URL). */
function ownOrigin(bindHost: string): string {
  if (bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '') return '127.0.0.1';
  return bindHost.includes(':') ? `[${bindHost}]` : bindHost;
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
  /** Where callers reach this server (behind a proxy), for file URLs.
   *  Default: the address it binds. */
  publicUrl?: string;
  /** Models to lend the module (an embedder's). The command line lends none,
   *  so a module call that asks one is refused by name there. */
  models?: ModuleModels;
}

export async function serveModule(options: ServeModuleOptions): Promise<{ port: number; server: Server }> {
  const { definition, token } = options;
  const log = options.log ?? jsonLineLog(definition.name, (line) => process.stderr.write(line));
  const unavailable = (what: string) =>
    `module ${definition.name}: ${what} is not available when the module is served as a process (protocol 2 carries files by URL and keeps no module state)`;
  const { stateDir } = options;
  const noKv = refusingKv(`${unavailable('ctx.kv')}; set MODULE_STATE_DIR to keep it in files`);
  // The handler is built once the port is known: a file's URL is under
  // MODULE_PUBLIC_URL, else this server's own bound address, and never under
  // a request's Host header.
  let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
  const server = createServer((req, res) => {
    if (handler === undefined) {
      res.writeHead(503).end();
      return;
    }
    handler(req, res).catch((error: unknown) => {
      log.error('request failed outside the envelope', { error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  const bindHost = options.host ?? '127.0.0.1';
  await new Promise<void>((done) => server.listen(options.port ?? 0, bindHost, done));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === 'string') throw new Error('serve-module: the server is not listening on a port');
  const publicUrl = options.publicUrl ?? `http://${ownOrigin(bindHost)}:${address.port}`;
  handler = createModuleProtocolHandler({
    definition,
    log,
    files: refusingFiles(unavailable('ctx.files')),
    kvFor: stateDir !== undefined ? (tenant) => fileKv(stateDir, tenant) : () => noKv,
    models: options.models ?? refusingModels(`module ${definition.name}: ctx.models is lent by no host when the module is served by the serve-module command line`),
    ...(options.baseUrlOverride !== undefined ? { baseUrlOverride: options.baseUrlOverride } : {}),
    ...(options.constructionArgs !== undefined ? { constructionArgs: options.constructionArgs } : {}),
    publicUrl,
    ...(token !== undefined ? { authenticate: (headers) => headers.authorization === `Bearer ${token}` } : {}),
  });
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
 *  MODULE_TOKEN, MODULE_BASE_URL_OVERRIDE, MODULE_STATE_DIR,
 *  MODULE_CONSTRUCTION_ARGS and MODULE_PUBLIC_URL from the environment. */
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
    ...(env.MODULE_PUBLIC_URL !== undefined && env.MODULE_PUBLIC_URL !== '' ? { publicUrl: env.MODULE_PUBLIC_URL } : {}),
  });
  process.stdout.write(`listening ${served.port}\n`);
}
