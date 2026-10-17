#!/usr/bin/env node
// The module boundary guard. A module (modules/*) and the kit it is built
// with (packages/module-kit) are loaded by every host — the platform, lf, the
// Rust host, an embedder — so neither may reach what only the hosted product
// has: apps/*, a database client, or the recording layer (lib/recording). The
// engine is reached only through its public entries (movement-engine/public/*).
// Everything a module needs from its host comes through `ctx`.
//
// Unlike the engine boundary there is no baseline: the count is zero and
// stays zero. Run by each module's and the kit's `code:type-check`.
//
//   node scripts/check-module-boundary.cjs

const fs = require('node:fs');
const path = require('node:path');
const ts = require(require.resolve('typescript', { paths: [path.join(__dirname, '../packages/module-kit')] }));

const repoRoot = path.resolve(__dirname, '..');
const roots = [path.join(repoRoot, 'packages/module-kit')];
const modulesDir = path.join(repoRoot, 'modules');
if (fs.existsSync(modulesDir)) {
  for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    if (entry.isDirectory()) roots.push(path.join(modulesDir, entry.name));
  }
}

const DATABASE_CLIENTS = /^(kysely|pg|pg-[^/]+|postgres|@prisma\/.*|prisma|\.prisma\/.*|better-sqlite3|sqlite3|knex|mysql2?)(\/|$)/;

function sourceFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      sourceFiles(full, found);
    } else if (/\.(c|m)?[tj]sx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** Why an import is refused, or null when it is allowed. */
function refusal(specifier, fromFile) {
  if (specifier.startsWith('.')) {
    const target = path.resolve(path.dirname(fromFile), specifier);
    const inRepo = path.relative(repoRoot, target);
    if (inRepo.startsWith(`apps${path.sep}`)) return 'reaches into apps/';
    if (/(^|[\\/])lib[\\/]recording(\.ts)?$/.test(target)) return 'reaches the recording layer';
    if (inRepo.startsWith(`packages${path.sep}movement-engine${path.sep}`) && !inRepo.startsWith(`packages${path.sep}movement-engine${path.sep}public${path.sep}`)) {
      return 'reaches an engine internal (import movement-engine/public/*)';
    }
    return null;
  }
  if (specifier === 'api' || specifier.startsWith('api/')) return 'reaches the hosted product';
  if (DATABASE_CLIENTS.test(specifier)) return 'reaches a database client';
  if (/(^|\/)lib\/recording$/.test(specifier)) return 'reaches the recording layer';
  if (specifier === 'movement-engine' || (specifier.startsWith('movement-engine/') && !specifier.startsWith('movement-engine/public/'))) {
    return 'reaches an engine internal (import movement-engine/public/*)';
  }
  return null;
}

const refused = [];
let files = 0;
for (const root of roots) {
  for (const file of sourceFiles(root)) {
    files += 1;
    const { importedFiles } = ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true);
    for (const imported of importedFiles) {
      const why = refusal(imported.fileName, file);
      if (why !== null) refused.push(`  ${path.relative(repoRoot, file)}: '${imported.fileName}' ${why}`);
    }
  }
}

if (refused.length > 0) {
  console.error(`module boundary: ${refused.length} import(s) a module may not make:`);
  for (const line of refused) console.error(line);
  process.exit(1);
}
console.log(`module boundary: ${files} files in ${roots.length} package(s), none reaching the hosted product, a database or the recording layer`);
