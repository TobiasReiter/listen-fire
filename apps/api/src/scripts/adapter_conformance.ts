/**
 * Adapter conformance CLI: run a protocol v2 adapter server through every
 * check a vendor can fail, and report one line per check.
 *
 * Needs no dev loop and no database. It imports the protocol client and the
 * `RemoteAdapter` directly and serves a host double of its own for the push
 * doors and the subscription callback (see `adapter_conformance_host.ts`).
 *
 * Usage:
 *   pnpm adapter:conformance --url <baseUrl> --auth bearer
 *   pnpm adapter:conformance --url <baseUrl> --auth secret --auth-header <name>
 *
 * The secret is read from the environment variable named by `--secret-env`
 * (default ADAPTER_CONFORMANCE_SECRET), never from the command line.
 *
 * Flags:
 *   --url <baseUrl>               your server's protocol endpoint (required)
 *   --auth bearer|secret          how Listen-Fire presents the credential (required)
 *   --auth-header <name>          the header for `--auth secret` (default x-listen-fire-adapter-secret)
 *   --secret-env <VAR>            the env var holding the secret (default ADAPTER_CONFORMANCE_SECRET)
 *   --scratch-type <typeId>       a type the CLI may create, update and delete records of
 *   --scratch-fields '<json>'     the fields to create each scratch record with
 *   --sample-delivery '<json>'    a webhook body your server sends, for preprocessInbound and wakeKeys
 *   --host-port <n>               fixed port for the host double (default: ephemeral)
 *   --host-bind <address>         address the host double binds (default 127.0.0.1; use one your server can reach)
 *   --wait-for-push <seconds>     wait this long for your server to push to the doors (default 0: skip)
 *   --json                        print the report as a JSON array
 *
 * Without the scratch flags, the checks that write or read records are
 * skipped. Exits 1 if any check fails.
 */

import { z } from 'zod';

import type { AuthStrategy } from 'movement-engine/public/adapter';

import { formatReport, messageOf, runConformance, type ConformanceOptions } from './adapter_conformance_checks';

// ── The command line ─────────────────────────────────────────────────────────

const AuthFlag = z.enum(['bearer', 'secret']);

const JsonObject = z.record(z.string(), z.unknown());

function parseJsonFlag(flag: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${flag} is not valid JSON`);
  }
}

interface ParsedArgs {
  url: string;
  auth: z.infer<typeof AuthFlag>;
  authHeader?: string;
  secretEnv: string;
  scratchType?: string;
  scratchFields?: string;
  sampleDelivery?: string;
  hostPort?: string;
  hostBind?: string;
  waitForPush?: string;
  json: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const values: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === undefined) continue;
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (!flag.startsWith('--')) throw new Error(`unexpected argument ${flag}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    values[flag.slice(2)] = value;
  }
  const known = new Set(['url', 'auth', 'auth-header', 'secret-env', 'scratch-type', 'scratch-fields', 'sample-delivery', 'host-port', 'host-bind', 'wait-for-push']);
  const unknown = Object.keys(values).filter((name) => !known.has(name));
  if (unknown.length > 0) throw new Error(`unknown flag --${unknown[0]}`);
  if (values['url'] === undefined) throw new Error('--url <baseUrl> is required');
  const auth = AuthFlag.safeParse(values['auth']);
  if (!auth.success) throw new Error('--auth bearer|secret is required');
  return {
    url: values['url'],
    auth: auth.data,
    authHeader: values['auth-header'],
    secretEnv: values['secret-env'] ?? 'ADAPTER_CONFORMANCE_SECRET',
    scratchType: values['scratch-type'],
    scratchFields: values['scratch-fields'],
    sampleDelivery: values['sample-delivery'],
    hostPort: values['host-port'],
    hostBind: values['host-bind'],
    waitForPush: values['wait-for-push'],
    json,
  };
}

function optionsFromArgs(args: ParsedArgs, env: NodeJS.ProcessEnv): ConformanceOptions {
  const secret = env[args.secretEnv];
  if (secret === undefined || secret === '') {
    throw new Error(`set the credential in the environment variable ${args.secretEnv} (the secret is never taken from the command line)`);
  }
  if ((args.scratchType === undefined) !== (args.scratchFields === undefined)) {
    throw new Error('--scratch-type and --scratch-fields go together');
  }
  const authStrategy: AuthStrategy =
    args.auth === 'bearer'
      ? { kind: 'bearer' }
      : { kind: 'shared_secret', ...(args.authHeader !== undefined ? { header: args.authHeader } : {}) };
  const scratchFields =
    args.scratchFields !== undefined ? JsonObject.parse(parseJsonFlag('--scratch-fields', args.scratchFields)) : undefined;
  const hostPort = args.hostPort !== undefined ? z.coerce.number().int().min(0).max(65535).parse(args.hostPort) : undefined;
  const waitForPushSeconds = args.waitForPush !== undefined ? z.coerce.number().min(0).parse(args.waitForPush) : undefined;
  return {
    baseUrl: args.url,
    authStrategy,
    secret,
    ...(args.scratchType !== undefined && scratchFields !== undefined
      ? { scratch: { typeId: args.scratchType, fields: scratchFields } }
      : {}),
    ...(args.sampleDelivery !== undefined
      ? { sampleDelivery: parseJsonFlag('--sample-delivery', args.sampleDelivery) }
      : {}),
    ...(hostPort !== undefined ? { hostPort } : {}),
    ...(args.hostBind !== undefined ? { hostBind: args.hostBind } : {}),
    ...(waitForPushSeconds !== undefined ? { waitForPushSeconds } : {}),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const options = optionsFromArgs(args, process.env);
  const results = await runConformance({
    ...options,
    onHostReady: ({ hostUrl, adapterType }) => {
      process.stderr.write(`host double listening at ${hostUrl} (push to ${hostUrl}/api/public/adapter/${adapterType}/{emit,wake})\n`);
    },
  });
  process.stdout.write(`${args.json ? JSON.stringify(results, null, 2) : formatReport(results)}\n`);
  const failed = results.filter((r) => r.status === 'FAIL').length;
  if (!args.json) {
    const skipped = results.filter((r) => r.status === 'SKIP').length;
    process.stdout.write(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped\n`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`adapter:conformance: ${messageOf(err)}\n`);
    process.exit(2);
  });
}
