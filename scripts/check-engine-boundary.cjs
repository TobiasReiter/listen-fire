#!/usr/bin/env node
// The engine boundary guard. apps/api production code may reach the engine
// package only through `movement-engine/public/*`; this lists every import of
// an internal module (anything else under `movement-engine/`) and compares the
// count with the baseline in engine-boundary-baseline.json.
//
// The baseline is empty: any import of an internal fails. ESLint's
// no-restricted-imports (apps/api/eslint.config.js) says the same in the
// editor, and the package's `exports` map refuses an internal at run time
// outside the test runners' `movement-engine-internals` condition.
//
//   node scripts/check-engine-boundary.cjs            report / gate
//   node scripts/check-engine-boundary.cjs --update   rewrite the baseline
//   node scripts/check-engine-boundary.cjs --list     also list every site

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');
const apiSrc = path.join(repoRoot, 'apps/api/src');
const engineRoot = path.join(repoRoot, 'packages/movement-engine');
const baselineFile = path.join(__dirname, 'engine-boundary-baseline.json');

const PACKAGE = 'movement-engine';
const args = new Set(process.argv.slice(2));

// Not production code: tests, their fixtures and setup, and the dev-loop
// scripts that exercise the engine by hand.
const NOT_PRODUCTION = [
  /\.(test|spec)\.tsx?$/,
  /(^|\/)__(test|tests|conformance|fixtures)__(\/|$)/,
  /^test\//,
  /^scripts\/dev\//,
];

function sourceFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      sourceFiles(full, found);
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** The module an import names, as a path inside the engine package, or null
 *  when it does not reach the package. '' is the package root. */
function enginePathOf(specifier, fromFile) {
  if (specifier === PACKAGE) return '';
  if (specifier.startsWith(`${PACKAGE}/`)) return specifier.slice(PACKAGE.length + 1);
  if (specifier.startsWith('.')) {
    const target = path.resolve(path.dirname(fromFile), specifier);
    const inside = path.relative(engineRoot, target);
    if (!inside.startsWith('..') && !path.isAbsolute(inside)) return inside;
  }
  return null;
}

function specifiersIn(sourceFile) {
  const found = [];
  const add = (literal) => {
    if (literal && ts.isStringLiteralLike(literal)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile));
      found.push({ specifier: literal.text, line: line + 1 });
    }
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if (isRequire || callee.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

const sites = [];
for (const file of sourceFiles(apiSrc)) {
  const relative = path.relative(apiSrc, file).split(path.sep).join('/');
  if (NOT_PRODUCTION.some((pattern) => pattern.test(relative))) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(PACKAGE) && !text.includes('packages/')) continue;
  const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  for (const { specifier, line } of specifiersIn(parsed)) {
    const inside = enginePathOf(specifier, file);
    if (inside === null) continue;
    if (inside === 'public' || inside.startsWith('public/')) continue;
    sites.push({ module: inside === '' ? '(package root)' : inside, file: `apps/api/src/${relative}`, line });
  }
}

const byModule = {};
for (const { module: name } of sites) byModule[name] = (byModule[name] ?? 0) + 1;
const sortedModules = Object.fromEntries(Object.entries(byModule).sort(([a], [b]) => a.localeCompare(b)));
const total = sites.length;

if (args.has('--update')) {
  fs.writeFileSync(baselineFile, `${JSON.stringify({ total, byModule: sortedModules }, null, 2)}\n`);
  console.log(`engine boundary: baseline written (${total} imports of ${Object.keys(sortedModules).length} internal modules)`);
  process.exit(0);
}

const baseline = fs.existsSync(baselineFile)
  ? JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
  : { total: 0, byModule: {} };

const grown = [];
if (total > baseline.total) grown.push(`total ${baseline.total} -> ${total}`);
for (const [name, count] of Object.entries(sortedModules)) {
  const allowed = baseline.byModule[name] ?? 0;
  if (count > allowed) grown.push(`${name}: ${allowed} -> ${count}`);
}

console.log(
  `engine boundary: ${total} production imports of engine internals outside movement-engine/public (baseline ${baseline.total}, ${Object.keys(sortedModules).length} modules)`,
);
if (args.has('--list')) {
  for (const site of sites) console.log(`  ${site.file}:${site.line}  ${site.module}`);
}
if (grown.length > 0) {
  console.error('engine boundary: FAILED, imports of engine internals grew past the baseline:');
  for (const line of grown) console.error(`  ${line}`);
  console.error('Import from movement-engine/public/* instead, or add the answer to a public entry.');
  process.exit(1);
}
if (total < baseline.total) {
  console.log('engine boundary: below baseline; run with --update to lock in the lower count.');
}
