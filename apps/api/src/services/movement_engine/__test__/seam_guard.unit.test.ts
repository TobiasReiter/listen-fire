// The engine/host seam, pinned. A pure engine file reaches the database, the
// model provider, billing, adapter implementations and run recording only
// through the `EngineHost` it is handed — never by importing them. That is
// what lets an embedder (a test, the browser, another process) run the engine
// on a host of its own (DESIGN §6).
//
// Imports are read with the TypeScript compiler, not a regex, so a multi-line
// import or an `import { type X }` is classified the way the compiler sees it.
// Type-only imports are allowed from anywhere: they vanish at compile time.

import { builtinModules } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import type { TeamId } from '../../../generated/kysely/core/Team';
import { makeFakeParkSink, type AwaitWakeRequest } from '../host';
import type { ParkSink } from '../run';
import { awaitingSource, makeAwaitingAdapter, runAwaiting } from './awaitable_fixture';

const ENGINE_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.resolve(__dirname, '../../..');

/** Engine files that must import no host code. */
const PURE_FILES = [
  'address.ts',
  'ai_tiers.ts',
  'call_depth.ts',
  'callback_types.ts',
  'effect_locks.ts',
  'errors.ts',
  'expression.ts',
  'extraction.ts',
  'extraction_call.ts',
  'file_render.ts',
  'host.ts',
  'interpretable.ts',
  'kg.ts',
  'local_edge_adapter.ts',
  'provenance.ts',
  'run.ts',
  'run_scope.ts',
  'rust_engine.ts',
  'serialize.ts',
];

/** Host implementations that still live in this directory: they wire the
 *  engine to Postgres, the work queue and the run recorder. */
const HOST_SIDE_FILES = [
  'await_description.ts',
  'await_resume.ts',
  'await_wake.ts',
  'callback_fire.ts',
  'callback_sink.ts',
  'callback_store.ts',
  'cancel_gate.ts',
  'join_pending.ts',
  'limit_pause.ts',
  'park_sink.ts',
  'single_flight.ts',
  'timer_resume.ts',
  'timer_wake.ts',
];

/** Module paths are relative to apps/api/src, without extension. */
const FORBIDDEN: Array<{ matches: (module: string) => boolean; reason: string }> = [
  { matches: under('lib/kysely'), reason: 'the database client (the host owns storage)' },
  { matches: under('generated/kysely'), reason: 'generated database code (types only)' },
  { matches: under('generated/prisma'), reason: 'generated database code (types only)' },
  { matches: (m) => m === 'prisma' || m.startsWith('@prisma/'), reason: 'the database client' },
  { matches: under('lib/anthropic'), reason: 'the model provider (the host supplies `llm`)' },
  { matches: under('lib/llm_usage'), reason: 'billing context (the host wraps model calls)' },
  {
    matches: under('services/translation_graph/adapters'),
    reason: 'adapter implementations (the host supplies `adapters`)',
  },
  { matches: under('services/translation_graph/runs'), reason: 'run recording (the host supplies `trace`)' },
  { matches: under('services/translation_graph/movement'), reason: 'the production host itself' },
  { matches: under('services/document'), reason: 'document storage (the host supplies `files`)' },
  { matches: under('services/work'), reason: 'the work queue (the host supplies `park`)' },
  { matches: under('services/interaction'), reason: 'run failure reporting (host side)' },
  { matches: under('services/webhook_sync'), reason: 'inbound sync (host side)' },
  {
    matches: (m) => HOST_SIDE_FILES.some((f) => m === `services/movement_engine/${f.replace(/\.ts$/, '')}`),
    reason: 'a host-side movement_engine module',
  },
];

const ALLOWED: Array<(module: string) => boolean> = [
  (m) => m === 'movement-lang' || m.startsWith('movement-lang/'),
  (m) => m === 'zod',
  (m) => m.startsWith('node:') || builtinModules.includes(m),
  (m) => m.startsWith('#shared/'),
  under('lib/utils'),
  under('lib/run_spend'),
  under('lib/models'),
  under('lib/prompts'),
  under('services/logger'),
  // Recorded debt (DESIGN §9 item 6): file IO still reaches the shared engine
  // helpers directly instead of through `host.files`.
  under('services/translation_graph/engine'),
  under('services/translation_graph/uniqueness'),
  under('services/translation_graph/required_fields'),
  under('services/translation_graph/types'),
  under('services/translation_graph/mutation_context'),
  // The adapter protocol: the contract the engine calls adapters through, no
  // implementation.
  under('services/translation_graph/adapter'),
  // The lock interface and the in-memory locks `makeTestHost` uses; the
  // Postgres implementation is a separate module.
  under('services/write_locks/write_locks'),
  (m) => PURE_FILES.some((f) => m === `services/movement_engine/${f.replace(/\.ts$/, '')}`),
];

/**
 * Host reaches that remain in a pure file, each named so it cannot spread and
 * so its removal also removes the exemption. All are file IO, the recorded
 * debt of DESIGN §9 item 6: rendered files belong behind `host.files`.
 */
const RECORDED_DEBT: Array<{ file: string; specifier: string; reason: string }> = [
  {
    file: 'file_render.ts',
    specifier: '../../adapters/registry',
    reason: 'uploads a rendered file to the document store',
  },
  { file: 'file_render.ts', specifier: '../playwright', reason: 'renders HTML to PDF in a browser' },
];

function isRecordedDebt(file: string, specifier: string): boolean {
  return RECORDED_DEBT.some((debt) => debt.file === file && debt.specifier === specifier);
}

function under(prefix: string): (module: string) => boolean {
  return (m) => m === prefix || m.startsWith(`${prefix}/`);
}

/** A relative specifier becomes a path under apps/api/src; a bare one stays. */
function moduleOf(fromFile: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier;
  const resolved = path.relative(SRC_DIR, path.resolve(path.dirname(fromFile), specifier));
  return resolved.split(path.sep).join('/').replace(/\.(ts|js)$/, '').replace(/\/index$/, '');
}

/** Every specifier the file loads at run time. */
function valueImports(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!isTypeOnlyImport(node)) specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (!isTypeOnlyExport(node)) specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && isLoaderCall(node)) {
      const [arg] = node.arguments;
      if (arg !== undefined && ts.isStringLiteralLike(arg)) specifiers.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name !== undefined) return false;
  const bindings = clause.namedBindings;
  return (
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  return (
    clause !== undefined &&
    ts.isNamedExports(clause) &&
    clause.elements.length > 0 &&
    clause.elements.every((element) => element.isTypeOnly)
  );
}

function isLoaderCall(node: ts.CallExpression): boolean {
  return (
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === 'require')
  );
}

describe('the engine/host seam', () => {
  it('classifies every movement_engine file as pure or host side, exactly once', () => {
    const onDisk = fs
      .readdirSync(ENGINE_DIR)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .sort();
    const listed = [...PURE_FILES, ...HOST_SIDE_FILES].sort();
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).toEqual(onDisk);
  });

  it('pure engine files import no host code', () => {
    const violations: string[] = [];
    for (const file of PURE_FILES) {
      const filePath = path.join(ENGINE_DIR, file);
      for (const specifier of valueImports(filePath)) {
        if (isRecordedDebt(file, specifier)) continue;
        const module = moduleOf(filePath, specifier);
        const forbidden = FORBIDDEN.find((rule) => rule.matches(module));
        if (forbidden !== undefined) {
          violations.push(`${file} imports '${specifier}': ${forbidden.reason}`);
        } else if (!ALLOWED.some((allowed) => allowed(module))) {
          violations.push(
            `${file} imports '${specifier}': not on the seam's allow list (reach it through the host, or allow it here with the reason)`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('every recorded debt is still present, so a paid-off one drops its exemption', () => {
    const stale = RECORDED_DEBT.filter(
      (debt) => !valueImports(path.join(ENGINE_DIR, debt.file)).includes(debt.specifier),
    ).map((debt) => `${debt.file} no longer imports '${debt.specifier}'`);
    expect(stale).toEqual([]);
  });

  it('flags a value import from host code and lets a type-only one through', () => {
    const probe = path.join(ENGINE_DIR, 'probe.ts');
    const classify = (text: string) => {
      const source = ts.createSourceFile(probe, text, ts.ScriptTarget.Latest, true);
      const [statement] = source.statements;
      if (statement === undefined || !ts.isImportDeclaration(statement)) {
        throw new Error('probe must be one import');
      }
      return isTypeOnlyImport(statement);
    };
    expect(classify(`import { getQb } from '../../lib/kysely';`)).toBe(false);
    expect(classify(`import type { Kysely } from '../../lib/kysely';`)).toBe(true);
    expect(classify(`import { type Kysely } from '../../lib/kysely';`)).toBe(true);
    expect(classify(`import { type Kysely, getQb } from '../../lib/kysely';`)).toBe(false);
    expect(classify(`import '../../lib/kysely';`)).toBe(false);
    expect(moduleOf(probe, '../../lib/kysely')).toBe('lib/kysely');
    expect(FORBIDDEN.some((rule) => rule.matches(moduleOf(probe, './park_sink')))).toBe(true);
  });
});

describe('the engine/host seam carries data', () => {
  // DESIGN §6: every host call is request/response with JSON-serialisable
  // arguments. The await park and its wake are the calls that used to carry a
  // closure (the re-check); the engine now re-checks itself.
  it('an await park and the wake after it pass plain data only', async () => {
    const calls: unknown[] = [];
    const { sink } = makeFakeParkSink();
    const recording: ParkSink = {
      ...sink,
      async commitAwaitPark(input) {
        calls.push(input);
      },
    };
    const awaiting = makeAwaitingAdapter([
      { status: 'pending', correlationKey: 'req-1' },
      {
        status: 'landed',
        correlationKey: 'req-1',
        landings: [{ recordId: 'req-1', recordType: 'Check Response', fields: { Answer: true } }],
      },
    ]);

    await runAwaiting({
      teamId: '00000000-0000-0000-0000-000000000042' as TeamId,
      source: awaitingSource(),
      adapter: awaiting.adapter,
      parkSink: recording,
      wake: async (request: AwaitWakeRequest) => {
        calls.push(request);
      },
    });

    expect(calls).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(calls))).toEqual(calls);
  });
});
