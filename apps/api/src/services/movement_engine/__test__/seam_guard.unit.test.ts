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
import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import { CURRENT_LANGUAGE_VERSION } from 'movement-lang';

import {
  makeFakeParkSink,
  makeTestHost,
  type AwaitWakeRequest,
  type EngineHost,
  type RenderFile,
  type ResolveFileText,
} from '../host';
import { runMovement, type ParkSink } from '../run';
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
  'host.ts',
  'interpretable.ts',
  'kg.ts',
  'local_edge_adapter.ts',
  'provenance.ts',
  'run.ts',
  'run_context.ts',
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

/** The host-side modules that turn a file descriptor into bytes, or bytes
 *  into a URL. */
const BYTE_READERS = ['retrieve', 'expose', 'fetch-stream'];

/** Module paths are relative to apps/api/src, without extension. */
const FORBIDDEN: Array<{ matches: (module: string) => boolean; reason: string }> = [
  { matches: under('lib/kysely'), reason: 'the database client (the host owns storage)' },
  { matches: under('generated/kysely'), reason: 'generated database code (types only)' },
  { matches: under('generated/prisma'), reason: 'generated database code (types only)' },
  { matches: (m) => m === 'prisma' || m.startsWith('@prisma/'), reason: 'the database client' },
  { matches: under('lib/anthropic'), reason: 'the model provider (the host supplies `llm`)' },
  { matches: under('lib/llm_usage'), reason: 'billing context (the host wraps model calls)' },
  {
    matches: under('lib/run_spend'),
    reason: "a priced call's spend meter (the host meters its calls; the engine keeps the run's ledger)",
  },
  {
    matches: under('services/translation_graph/segment_scope'),
    reason: "a segment's host scope (the engine holds only the segment's id)",
  },
  {
    matches: under('services/translation_graph/adapters'),
    reason: 'adapter implementations (the host supplies `adapters`)',
  },
  { matches: under('services/translation_graph/runs'), reason: 'run recording (the host supplies `trace`)' },
  { matches: under('services/translation_graph/movement'), reason: 'the production host itself' },
  { matches: under('services/document'), reason: 'document storage (the host supplies `files`)' },
  {
    matches: (m) => BYTE_READERS.some((reader) => m === `services/translation_graph/engine/files/${reader}`),
    reason: 'a file byte reader (bytes stay on the host: the engine holds descriptors)',
  },
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
  // The spend vocabulary both sides speak: budgets, cost lines, the cap.
  under('lib/run_cost'),
  under('lib/models'),
  under('lib/prompts'),
  under('services/logger'),
  // Shared engine helpers that are pure computation over engine data: the
  // dry-run write capture, resource stamping and filtering, the model choice
  // for an extraction's size. The transform registry is the plugin-signature
  // debt (DESIGN §9 item 8).
  (m) => m === 'services/translation_graph/engine/dry_run_adapter',
  (m) => m === 'services/translation_graph/engine/files/resources',
  (m) => m === 'services/translation_graph/engine/batched_extraction/schema_synthesis',
  (m) => m === 'services/translation_graph/engine/transforms/registry',
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
    expect(FORBIDDEN.some((rule) => rule.matches(moduleOf(probe, '../translation_graph/engine/files/retrieve')))).toBe(true);
    expect(FORBIDDEN.some((rule) => rule.matches(moduleOf(probe, '../../lib/run_spend')))).toBe(true);
    expect(FORBIDDEN.some((rule) => rule.matches(moduleOf(probe, '../translation_graph/segment_scope')))).toBe(true);
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

  // A file crosses as its descriptor: FILE() asks the host to render and gets
  // a descriptor back; READ() hands that descriptor over and gets text back.
  // No bytes, and no closure, in either direction. The segment the run opened
  // and closed around them, the budget in and the cost out, are data too.
  it('a file render and a file read pass plain data only', async () => {
    const teamId = '00000000-0000-0000-0000-000000000043' as TeamId;
    const calls: Array<{ call: string; input: unknown; output: unknown }> = [];
    const render: RenderFile = async (input) => {
      const output = {
        __brand: 'FileRef' as const,
        name: 'movement-artifact.txt',
        contentType: 'text/plain',
        source: { store: 'document' as const, objectUri: 'mem://rendered/1' },
      };
      calls.push({ call: 'render', input, output });
      return output;
    };
    const resolveFileText: ResolveFileText = async (input) => {
      const output = { text: 'the digest', rawTextId: 'rt-1', cost: [{ source: 'model:ocr', microdollars: 120 }] };
      calls.push({ call: 'resolveFileText', input, output });
      return output;
    };
    const segment: EngineHost['segment'] = {
      open: async (input) => {
        const output = { segmentId: 'seg-1' };
        calls.push({ call: 'segment.open', input, output });
        return output;
      },
      close: async (input) => {
        const output = { cost: [] };
        calls.push({ call: 'segment.close', input, output });
        return output;
      },
    };
    const manual = createManualAdapter({ teamId });
    const result = await runMovement({
      source: [
        'import { manual } from adapters',
        'runs = manual()',
        '',
        'movement m(go: <runs-[:Invocation]->>) {',
        '  f = FILE("the digest", "text")',
        '  t = READ(f)',
        '}',
        'listen to runs {} fire m',
      ].join('\n'),
      event: {
        pipelineInputId: 'trigger:manual-files',
        adapterType: 'manual',
        triggerType: 'webhook',
        payload: { firedAt: '2026-10-07T09:00:00.000Z' },
        occurredAt: '2026-10-07T09:00:00.000Z',
      },
      teamId,
      catalog: staticCatalogSnapshot({ credentials: {} }),
      host: makeTestHost({
        segment,
        adapters: {
          resolve: (input) => {
            calls.push({ call: 'adapters.resolve', input, output: 'an adapter' });
            return manual;
          },
        },
        files: { render, resolveFileText },
      }),
      dryRun: true,
    });

    expect(result.trace.filter((entry) => entry.kind === 'warning')).toEqual([]);
    const made = calls.filter((c) => c.call !== 'adapters.resolve');
    expect(made.map((c) => c.call)).toEqual(['segment.open', 'render', 'resolveFileText', 'segment.close']);
    expect(made[0]?.input).toEqual({ teamId, languageVersion: CURRENT_LANGUAGE_VERSION });
    expect(made[1]?.input).toEqual({ content: 'the digest', type: 'text' });
    // A priced call: the run's budget in (no cap here), what it spent out —
    // and the run charged it.
    expect(made[2]?.input).toEqual({ file: made[1]?.output, budget: { remainingMicrodollars: null } });
    expect(result.spentBySource).toEqual({ 'model:ocr': 120 });
    expect(made[3]?.input).toEqual({ segmentId: 'seg-1' });
    // Every adapter is resolved for the segment, by its id.
    const resolutions = calls.filter((c) => c.call === 'adapters.resolve');
    expect(resolutions.length).toBeGreaterThan(0);
    for (const resolved of resolutions) {
      expect(resolved.input).toMatchObject({ segmentId: 'seg-1' });
    }
    expect(JSON.parse(JSON.stringify(calls))).toEqual(calls);
  });
});
