// The example project (examples/lf-acme), copied into a temporary folder per
// test, and the real `lf` entry point run against it.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const LF = resolve(__dirname, '../../bin/lf.cjs');
export const EXAMPLE = resolve(__dirname, '../../../../examples/lf-acme');

export function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-example-'));
  cpSync(EXAMPLE, dir, { recursive: true, filter: (src) => !src.includes(`${EXAMPLE}/.lf`) });
  mkdirSync(join(dir, '.lf'), { recursive: true });
  cpSync(join(dir, 'secrets.example.yaml'), join(dir, '.lf', 'secrets.yaml'));
  return dir;
}

export function lf(dir: string, ...args: string[]): { code: number; out: string } {
  const run = spawnSync(process.execPath, [LF, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return { code: run.status ?? -1, out: `${run.stdout}${run.stderr}` };
}

export function companies(dir: string): string[] {
  const state = JSON.parse(readFileSync(join(dir, '.lf/externals/acme_crm/state.json'), 'utf8')) as {
    companies: Array<{ fields: { Name: string } }>;
  };
  return state.companies.map((c) => c.fields.Name);
}

