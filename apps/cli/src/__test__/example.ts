// The example project (examples/lf-acme), copied into a temporary folder per
// test, and the real `lf` entry point run against it. `LF_BIN=<executable>`
// runs the tests against another binary instead (the Rust lf-host:
// `LF_BIN=target/debug/lf-host`), so one set of tests holds both.

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const LF = resolve(__dirname, '../../bin/lf.cjs');

/** The command and arguments that run `lf <args>`: the TypeScript entry
 *  point under this Node, or the executable `LF_BIN` names. */
export function lfCommand(args: readonly string[]): [string, string[]] {
  const bin = process.env.LF_BIN;
  return bin !== undefined && bin !== '' ? [resolve(bin), [...args]] : [process.execPath, [LF, ...args]];
}
export const EXAMPLE = resolve(__dirname, '../../../../examples/lf-acme');

/** The example project; with a fixture, its movements replaced by the
 *  fixture's folder (movements/<name>). */
export function project(fixture?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-example-'));
  cpSync(EXAMPLE, dir, { recursive: true, filter: (src) => !src.includes(`${EXAMPLE}/.lf`) });
  mkdirSync(join(dir, '.lf'), { recursive: true });
  cpSync(join(dir, 'secrets.example.yaml'), join(dir, '.lf', 'secrets.yaml'));
  if (fixture !== undefined) {
    rmSync(join(dir, 'movements'), { recursive: true });
    cpSync(resolve(__dirname, 'movements', fixture), join(dir, 'movements'), { recursive: true });
  }
  return dir;
}

export function lf(dir: string, ...args: string[]): { code: number; out: string } {
  const run = spawnSync(...lfCommand(args), {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return { code: run.status ?? -1, out: `${run.stdout}${run.stderr}` };
}

export interface Served {
  port: number;
  lines: string[];
  /** Resolves with the first output line matching, or rejects after `ms`. */
  waitFor(pattern: RegExp, ms?: number): Promise<string>;
  stop(): Promise<void>;
}

/** `lf serve` on a free port, its output collected. */
export async function served(dir: string, args: string[] = [], env: Record<string, string> = {}): Promise<Served> {
  const server = spawn(...lfCommand(['serve', '--port', '0', ...args]), {
    cwd: dir,
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines: string[] = [];
  const waiters: Array<{ pattern: RegExp; resolve: (line: string) => void }> = [];
  createInterface({ input: server.stdout! }).on('line', (line) => {
    lines.push(line);
    for (const w of [...waiters]) {
      if (w.pattern.test(line)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(line);
      }
    }
  });
  const waitFor = (pattern: RegExp, ms = 20_000) =>
    new Promise<string>((resolveLine, reject) => {
      const seen = lines.find((l) => pattern.test(l));
      if (seen !== undefined) return resolveLine(seen);
      const timer = setTimeout(() => reject(new Error(`no line matching ${pattern} in ${ms}ms; saw:\n${lines.join('\n')}`)), ms);
      waiters.push({ pattern, resolve: (line) => (clearTimeout(timer), resolveLine(line)) });
    });
  const exited = new Promise<void>((resolveExit) => server.once('exit', () => resolveExit()));
  const line = await Promise.race([
    waitFor(/serving on http:\/\/127\.0\.0\.1:(\d+)/),
    exited.then(() => {
      throw new Error(`lf serve exited:\n${lines.join('\n')}`);
    }),
  ]);
  const port = Number(/:(\d+)\//.exec(line)?.[1]);
  return {
    port,
    lines,
    waitFor,
    stop: async () => {
      server.kill('SIGTERM');
      await exited;
    },
  };
}

/** The port the started external listens on, read from its own state. */
export function externalPort(dir: string): number {
  return Number(readFileSync(join(dir, '.lf/externals/acme_crm/port'), 'utf8'));
}

export function crmCompanies(dir: string): Array<{ externalId: string; fields: { Name: string } }> {
  const file = join(dir, '.lf/externals/acme_crm/state.json');
  if (!existsSync(file)) return [];
  return (JSON.parse(readFileSync(file, 'utf8')) as { companies: Array<{ externalId: string; fields: { Name: string } }> }).companies;
}

export function companies(dir: string): string[] {
  return crmCompanies(dir).map((c) => c.fields.Name);
}
