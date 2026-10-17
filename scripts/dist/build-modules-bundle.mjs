#!/usr/bin/env node
// Builds the built-in modules bundle a release ships beside the lf binary:
//   modules/node_modules/   module-kit and the workspace packages it needs,
//                           plus their third-party dependencies (tsx, zod, ...)
//   modules/<name>/         one folder per module under repo modules/
// so `module: "@lf/<name>"` in an external's manifest runs offline after
// install. The modules are TypeScript served by serve-module under tsx, so the
// user's machine needs node. Run from the repo root: node scripts/dist/build-modules-bundle.mjs <outDir> [os cpu libc]
// Writes <outDir>/modules/... (the folder a release archive carries at
// share/lf/modules). esbuild (under tsx) ships a native binary per platform, so
// a bundle is for one platform: pass os/cpu/libc (npm's names: linux x64
// glibc) to build for another than this machine's.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const [outArg, os, cpu, libc] = process.argv.slice(2);
if (outArg === undefined) throw new Error('usage: build-modules-bundle.mjs <outDir> [os cpu libc]');
const bundle = resolve(outArg);
rmSync(bundle, { recursive: true, force: true });
mkdirSync(bundle, { recursive: true });
const platform = [os && `--os=${os}`, cpu && `--cpu=${cpu}`, libc && `--libc=${libc}`].filter(Boolean);

// Workspace packages the modules load at run time, by the name they import them under.
const WORKSPACE = {
  'module-kit': 'packages/module-kit',
  'engine-contracts': 'packages/engine-contracts',
  'movement-engine': 'packages/movement-engine',
  'movement-lang': 'packages/movement-lang',
  'file-text': 'packages/file-text',
  '#shared': 'packages/shared',
  '@listen-fire/shared': 'packages/shared',
};
const modules = readdirSync('modules', { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const sources = [...new Set([...Object.values(WORKSPACE), ...modules.map((m) => `modules/${m}`)])];

const thirdParty = {};
for (const source of sources) {
  const { dependencies = {} } = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  for (const [name, range] of Object.entries(dependencies)) {
    if (!String(range).startsWith('workspace:')) thirdParty[name] = range;
  }
}
writeFileSync(join(bundle, 'package.json'), JSON.stringify({ private: true, dependencies: thirdParty }));
// npm prunes whatever it did not install, so third-party packages go in first.
execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...platform], { cwd: bundle, stdio: 'inherit' });

const skip = (path) => !/(^|\/)(node_modules|__test__|bench)(\/|$)|jest\.config/.test(path);
for (const [name, source] of Object.entries(WORKSPACE)) {
  cpSync(source, join(bundle, 'node_modules', name), { recursive: true, filter: skip });
}
for (const name of modules) cpSync(join('modules', name), join(bundle, name), { recursive: true, filter: skip });

const missing = ['node_modules/module-kit/bin/serve-module.cjs', 'node_modules/tsx'].filter((p) => !existsSync(join(bundle, p)));
if (missing.length > 0) throw new Error(`bundle is missing ${missing.join(', ')}`);

console.log(`wrote ${bundle}`);
