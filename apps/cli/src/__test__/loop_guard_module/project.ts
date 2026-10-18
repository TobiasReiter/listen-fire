// A project whose loopGuard slot is filled by the test loop guard module (serve.ts).

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SERVE = resolve(__dirname, 'serve.ts');

export function guardModuleProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-guard-slot-'));
  mkdirSync(join(dir, 'externals/acme_guard'), { recursive: true });
  const command = [process.execPath, '--conditions=movement-engine-internals', '--require', require.resolve('tsx/cjs'), SERVE];
  writeFileSync(
    join(dir, 'externals/acme_guard/lf-external.yaml'),
    ['name: acme_guard', 'kind: core', 'slot: loopGuard', `command: [${command.map((part) => JSON.stringify(part)).join(', ')}]`, ''].join('\n'),
  );
  writeFileSync(join(dir, 'lf.yaml'), 'engine: 0.11.0\ncore:\n  loopGuard: acme_guard\n');
  return dir;
}
