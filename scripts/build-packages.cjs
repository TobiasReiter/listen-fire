#!/usr/bin/env node
// Builds the publishable packages (the engine, its contracts, the language,
// the module kit, file text, the model providers, the shared library and
// every module) into each one's dist/: JavaScript and declarations. They are
// SOURCE packages while you work (`main` names index.ts); the published
// tarball is this build, which `publishConfig` points at.
//
// Each package is compiled against the dist/ of the packages it depends on,
// so a compile never re-emits a neighbour's sources; the order below is the
// dependency order. The sources import a neighbour by its workspace spelling
// (`movement-engine/public/host`, `#shared/…`); the emitted files are
// rewritten to the published name (`@listen-fire/engine/public/host`), so an installed
// package finds its neighbour by the name npm installed it under.
//
//   node scripts/build-packages.cjs                 every package
//   node scripts/build-packages.cjs <dir>           that package and what it depends on
//   node scripts/build-packages.cjs --restore <dir> put the package's own package.json back
//
// `pnpm pack` in a package runs it for that package (its `prepack`), and
// `--restore` after (its `postpack`). While packing, the manifest loses its
// workspace aliases (`#shared`, `movement-engine`, ...): they are devDependencies
// that only make the monorepo's source imports resolve, and `#shared` is not a
// package name a registry should be handed.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

/** Each package, in dependency order; `assets` are copied beside its build. */
const PACKAGES = [
  { dir: 'packages/shared' },
  { dir: 'packages/movement-lang', assets: [/^wasm\/[^/]+\.wasm$/] },
  { dir: 'packages/engine-contracts' },
  { dir: 'packages/movement-engine', assets: [/\/prompts\/[^/]+\.md$/] },
  { dir: 'packages/file-text' },
  { dir: 'packages/model-providers' },
  { dir: 'packages/module-kit' },
  { dir: 'modules/google-sheets' },
  ...fs
    .readdirSync(path.join(ROOT, 'modules'))
    .filter((name) => name !== 'google-sheets' && fs.existsSync(path.join(ROOT, 'modules', name, 'package.json')))
    .sort()
    .map((name) => ({ dir: `modules/${name}` })),
];

/** The workspace spelling each package is imported by, beside its published name. */
const SPELLINGS = {
  'movement-engine': '@listen-fire/engine',
  'engine-contracts': '@listen-fire/engine-contracts',
  'module-kit': '@listen-fire/module-kit',
  'file-text': '@listen-fire/file-text',
  'model-providers': '@listen-fire/model-providers',
  'movement-lang': '@listen-fire/movement-lang',
  '@listen-fire/shared': '@listen-fire/shared',
  '#shared': '@listen-fire/shared',
};

const manifestOf = (dir) => JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'));
const NAMES = Object.fromEntries(PACKAGES.map(({ dir }) => [manifestOf(dir).name, dir]));

/** Every name a source may import `dir`'s package by. */
function spellingsOf(dir) {
  const name = manifestOf(dir).name;
  return [name, ...Object.entries(SPELLINGS).filter(([, published]) => published === name).map(([spelling]) => spelling)];
}

/** The workspace packages `dir` depends on (as built here), directly. */
function dependenciesOf(dir) {
  const dependencies = manifestOf(dir).dependencies ?? {};
  return Object.keys(dependencies).filter((name) => NAMES[name] !== undefined).map((name) => NAMES[name]);
}

/** `dir` and everything it depends on, in build order. */
function closureOf(dir) {
  const wanted = new Set();
  const visit = (at) => {
    if (wanted.has(at)) return;
    wanted.add(at);
    dependenciesOf(at).forEach(visit);
  };
  visit(dir);
  return PACKAGES.filter((p) => wanted.has(p.dir));
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'dist' ? [] : walk(full);
    return [full];
  });
}

/** A published `main`, `types` or exact `exports` target the build did not produce would only fail for an installer. */
function assertPublishedEntriesExist(dir) {
  const { publishConfig = {} } = manifestOf(dir);
  const targets = [publishConfig.main, publishConfig.types];
  for (const [subpath, target] of Object.entries(publishConfig.exports ?? {})) {
    if (subpath.includes('*')) continue;
    targets.push(...(typeof target === 'string' ? [target] : Object.values(target)));
  }
  const missing = targets.filter((target) => typeof target === 'string' && !fs.existsSync(path.join(ROOT, dir, target)));
  if (missing.length > 0) throw new Error(`${dir} publishes ${missing.join(', ')}, which its build did not produce`);
}

function build({ dir, assets = [] }) {
  const at = path.join(ROOT, dir);
  const dist = path.join(at, 'dist');
  fs.rmSync(dist, { recursive: true, force: true });

  // Every neighbour, by every spelling, resolves to its built declarations.
  const paths = {};
  for (const neighbour of PACKAGES) {
    if (neighbour.dir === dir) continue;
    const built = path.relative(at, path.join(ROOT, neighbour.dir, 'dist'));
    for (const spelling of spellingsOf(neighbour.dir)) {
      paths[spelling] = [`${built}/index.d.ts`];
      paths[`${spelling}/*`] = [`${built}/*`];
    }
  }
  const config = path.join(at, 'tsconfig.publish.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: {
        noEmit: false,
        declaration: true,
        sourceMap: false,
        rootDir: '.',
        outDir: 'dist',
        paths,
      },
      exclude: ['node_modules', 'dist', '**/__test__/**', '**/__conformance__/**', '__embed_smoke__', 'jest.config.ts', 'jest.config.borrowed.cjs', ...(dir === 'packages/movement-lang' ? ['conformance', 'checker/harvest', 'parser/harvest', 'parser/expression/harvest'] : [])],
    }),
  );
  try {
    execFileSync(process.execPath, [require.resolve('typescript/bin/tsc', { paths: [at] }), '-p', config], { cwd: at, stdio: 'inherit' });
  } finally {
    fs.rmSync(config);
  }

  for (const file of walk(dist)) {
    if (!/\.(js|d\.ts)$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const renamed = text.replace(
      /(require\(|from |import\()(["'])(#shared|@listen-fire\/shared|movement-engine|engine-contracts|module-kit|file-text|model-providers|movement-lang)(\/[^"']*)?\2/g,
      (_match, call, quote, spelling, rest = '') => `${call}${quote}${SPELLINGS[spelling]}${rest}${quote}`,
    );
    if (renamed !== text) fs.writeFileSync(file, renamed);
  }

  for (const file of walk(at)) {
    const relative = path.relative(at, file);
    if (!assets.some((pattern) => pattern.test(relative))) continue;
    fs.mkdirSync(path.dirname(path.join(dist, relative)), { recursive: true });
    fs.copyFileSync(file, path.join(dist, relative));
  }

  // A bin runs the build; it still registers tsx, so a module named by path
  // may be TypeScript.
  const bin = manifestOf(dir).bin ?? {};
  for (const source of Object.values(bin)) {
    const target = path.join(dist, source);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fs.readFileSync(path.join(at, source), 'utf8').replace(/require\('\.\.\/(\w+)\.ts'\)/g, "require('../$1.js')"));
    fs.chmodSync(target, 0o755);
  }
  assertPublishedEntriesExist(dir);
  process.stdout.write(`built ${manifestOf(dir).name} (${dir}/dist)\n`);
}

const MANIFEST_BACKUP = 'package.json.unpacked';

function stripWorkspaceAliases(dir) {
  const file = path.join(ROOT, dir, 'package.json');
  const backup = path.join(ROOT, dir, MANIFEST_BACKUP);
  if (fs.existsSync(backup)) throw new Error(`${dir}/${MANIFEST_BACKUP} exists: a pack did not finish; run build-packages.cjs --restore ${dir}`);
  const manifest = manifestOf(dir);
  const { devDependencies = {} } = manifest;
  const kept = Object.fromEntries(Object.entries(devDependencies).filter(([, range]) => !String(range).startsWith('workspace:')));
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, `${JSON.stringify({ ...manifest, devDependencies: kept }, null, 2)}\n`);
}

function restoreManifest(dir) {
  const backup = path.join(ROOT, dir, MANIFEST_BACKUP);
  if (fs.existsSync(backup)) fs.renameSync(backup, path.join(ROOT, dir, 'package.json'));
}

const restoring = process.argv[2] === '--restore';
const only = restoring ? process.argv[3] : process.argv[2];
if (restoring) {
  restoreManifest(path.relative(ROOT, path.resolve(only)));
  process.exit(0);
}
const targets = only === undefined ? PACKAGES : closureOf(path.relative(ROOT, path.resolve(only)));
if (targets.length === 0) throw new Error(`${only} is not a publishable package`);
targets.forEach(build);
if (only !== undefined) stripWorkspaceAliases(path.relative(ROOT, path.resolve(only)));
