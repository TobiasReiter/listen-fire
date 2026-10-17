// The Rust lf-host binary (crates/lf-host) for the tests that drive it:
// `LF_HOST_BIN` when set, else built here with cargo (a no-op when it is
// already up to date). Built rather than skipped: a test that quietly passes
// without the binary proves nothing.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '../../../..');
let built: string | undefined;

export function lfHostBinary(): string {
  const named = process.env.LF_HOST_BIN;
  if (named !== undefined && named !== '') return resolve(named);
  if (built !== undefined) return built;
  const cargo = spawnSync('cargo', ['build', '--quiet', '-p', 'lf-host'], { cwd: REPO, encoding: 'utf8' });
  if (cargo.error !== undefined || cargo.status !== 0) {
    throw new Error(`cargo build -p lf-host failed (set LF_HOST_BIN to a built lf-host instead): ${cargo.error?.message ?? cargo.stderr}`);
  }
  built = resolve(REPO, 'target/debug/lf-host');
  return built;
}
