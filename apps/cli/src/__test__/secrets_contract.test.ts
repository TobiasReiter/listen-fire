// The secrets family's contract suite (packages/movement-engine/services/
// secrets/contract.ts) against lf's stores: a plain secrets file, a SOPS file
// (through a stand-in `sops` that keeps the plaintext beside the file, and
// through the real sops + age when both are installed), and the environment.

import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { secretsContractCases, type SecretsContractBackend } from 'movement-engine/public/secrets-testing';
import type { SecretFields } from 'movement-engine/public/secrets';
import { envSecrets, fileSecrets } from '../secrets';

const newName = () => `c${randomUUID().replaceAll('-', '').slice(0, 12)}`;

function entry(name: string, fields: SecretFields): string {
  return stringify({ [name]: { external: 'acme_crm', ...fields } });
}

function fileBackend(path: string, append: (text: string) => void): SecretsContractBackend {
  return {
    backend: fileSecrets(path),
    sibling: () => fileSecrets(path),
    seed: async (fields) => {
      const name = newName();
      append(entry(name, fields));
      return name;
    },
    missingRef: () => 'missing',
  };
}

/** A `sops` that keeps the plaintext at `<file>.plain`: `-d` prints it, `set`
 *  updates it the way sops does (a JSON path and a JSON value). */
function sopsStandIn(): string {
  const bin = mkdtempSync(join(tmpdir(), 'lf-sops-standin-'));
  writeFileSync(
    join(bin, 'sops'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const yaml = require(${JSON.stringify(require.resolve('yaml'))});
const [command, ...rest] = process.argv.slice(2);
if (command === '--version') { console.log('sops 3.9.0 (stand-in)'); process.exit(0); }
if (command === '-d') { process.stdout.write(fs.readFileSync(rest[0] + '.plain', 'utf8')); process.exit(0); }
if (command === 'set') {
  const [file, path, value] = rest;
  const keys = [...path.matchAll(/\\[("(?:[^"\\\\]|\\\\.)*")\\]/g)].map((m) => JSON.parse(m[1]));
  const doc = yaml.parseDocument(fs.readFileSync(file + '.plain', 'utf8'));
  doc.setIn(keys, JSON.parse(value));
  fs.writeFileSync(file + '.plain', doc.toString());
  process.exit(0);
}
process.stderr.write('stand-in sops: unknown command ' + command + '\\n');
process.exit(2);
`,
  );
  chmodSync(join(bin, 'sops'), 0o755);
  return bin;
}

function onPath(command: string): boolean {
  return spawnSync('which', [command], { encoding: 'utf8' }).status === 0;
}

function suite(label: string, make: () => SecretsContractBackend, options: { skip?: string; path?: string } = {}): void {
  for (const contractCase of secretsContractCases) {
    test(`${label}: ${contractCase.name}`, { ...(options.skip !== undefined ? { skip: options.skip } : {}) }, async () => {
      const savedPath = process.env.PATH;
      if (options.path !== undefined) process.env.PATH = `${options.path}:${savedPath}`;
      try {
        await contractCase.run(make());
      } finally {
        process.env.PATH = savedPath;
      }
    });
  }
}

suite('plain file', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'lf-secrets-plain-')), 'secrets.yaml');
  writeFileSync(path, '# a comment that survives\n');
  return fileBackend(path, (text) => appendFileSync(path, text));
});

const standIn = sopsStandIn();
suite(
  'SOPS file (stand-in sops)',
  () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lf-secrets-sops-')), 'secrets.yaml');
    writeFileSync(path, 'sops:\n  version: 3.9.0\n');
    writeFileSync(`${path}.plain`, '');
    return fileBackend(path, (text) => appendFileSync(`${path}.plain`, text));
  },
  { path: standIn },
);

const realSops = onPath('sops') && onPath('age-keygen');
suite(
  'SOPS file (sops + age)',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-secrets-age-'));
    const keys = join(dir, 'keys.txt');
    const made = spawnSync('age-keygen', ['-o', keys], { encoding: 'utf8' });
    const recipient = /public key: (\S+)/.exec(made.stderr)?.[1];
    if (recipient === undefined) throw new Error(`age-keygen gave no public key: ${made.stderr}`);
    process.env.SOPS_AGE_KEY_FILE = keys;
    const path = join(dir, 'secrets.yaml');
    const plain: Record<string, unknown> = {};
    const encrypt = () => {
      writeFileSync(path, stringify(Object.keys(plain).length > 0 ? plain : { placeholder: { external: 'none' } }));
      const run = spawnSync('sops', ['--encrypt', '--age', recipient, '--in-place', path], { encoding: 'utf8' });
      if (run.status !== 0) throw new Error(`sops --encrypt failed: ${run.stderr}`);
    };
    encrypt();
    return {
      ...fileBackend(path, () => undefined),
      seed: async (fields) => {
        const name = newName();
        plain[name] = { external: 'acme_crm', ...fields };
        encrypt();
        return name;
      },
    };
  },
  realSops ? {} : { skip: 'sops and age-keygen are not installed here; the stand-in sops suite covers lf\'s side of the calls' },
);

suite('environment (read-only)', () => {
  const env: NodeJS.ProcessEnv = {};
  return {
    backend: envSecrets(env),
    sibling: () => envSecrets(env),
    seed: async (fields) => {
      const name = newName();
      env[`LF_SECRET__${name.toUpperCase()}__EXTERNAL`] = 'acme_crm';
      for (const [field, value] of Object.entries(fields)) env[`LF_SECRET__${name.toUpperCase()}__${field.toUpperCase()}`] = value;
      return name;
    },
    missingRef: () => 'missing',
    readOnly: true,
  };
});
