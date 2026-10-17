// Tripwire for a production 500 (2026-09-03): `packages/shared` is
// compiled by its OWN tsconfig at deploy time (the api's compile step runs the
// shared package's `tsc`), and with no `target` TypeScript emits ES5. An ES5
// `class extends Error` loses its prototype, so movement-lang's
// `e instanceof ParseError` guard in expression/bridge.ts was false in
// production and a plain expression parse error escaped the checker as an
// internal error. The tests and the dev loop never saw it — they compile the
// same files under apps/api's tsconfig.
//
// This pins the shared package's effective compile options to the ones every
// other consumer of these files uses.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const sharedDir = path.resolve(__dirname, '../../../../../../packages/shared');

function effectiveCompilerOptions(): { target?: string; module?: string } {
  const tsc = require.resolve('typescript/bin/tsc', { paths: [sharedDir] });
  const result = spawnSync(
    process.execPath,
    [tsc, '-p', path.join(sharedDir, 'tsconfig.json'), '--showConfig'],
    { cwd: sharedDir, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`tsc --showConfig failed: ${result.stderr}`);
  return JSON.parse(result.stdout).compilerOptions;
}

describe('@listen-fire/shared compiles to the same target as its consumers', () => {
  it('targets es2022 with commonjs modules', () => {
    const options = effectiveCompilerOptions();
    expect(options.target?.toLowerCase()).toBe('es2022');
    expect(options.module?.toLowerCase()).toBe('commonjs');
  });
});
