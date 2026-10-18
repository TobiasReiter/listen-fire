// A project whose limiter slot is filled by the test limiter module (serve.ts).

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SERVE = resolve(__dirname, 'serve.ts');

export function limiterModuleProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-limiter-slot-'));
  mkdirSync(join(dir, 'externals/acme_limits'), { recursive: true });
  const command = [process.execPath, '--conditions=movement-engine-internals', '--require', require.resolve('tsx/cjs'), SERVE];
  writeFileSync(
    join(dir, 'externals/acme_limits/lf-external.yaml'),
    ['name: acme_limits', 'kind: core', 'slot: limiter', `command: [${command.map((part) => JSON.stringify(part)).join(', ')}]`, ''].join('\n'),
  );
  writeFileSync(join(dir, 'lf.yaml'), 'engine: 0.11.0\ncore:\n  limiter: acme_limits\n');
  return dir;
}
