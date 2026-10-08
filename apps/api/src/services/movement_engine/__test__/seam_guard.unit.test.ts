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
import { Readable } from 'node:stream';

import ts from 'typescript';
import { CURRENT_LANGUAGE_VERSION, type InstanceSchema } from 'movement-lang';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { CapturedWrite } from '../../translation_graph/engine/dry_run_adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { MovementTraceEntry } from '../expression';
import type { ParkedScopeState } from '../serialize';

import {
  iterateRelatedPages,
  containerAssociation,
  type Adapter,
  type ExternalRecordRef,
  type GetRelatedInput,
  type RelatedPage,
  type RelatedResult,
} from '../../translation_graph/adapter';
import { createEmailAdapter } from '../../translation_graph/adapters/email';
import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { adapterErrorOf } from '../../translation_graph/engine/adapter_table';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import { productionEngineHost } from '../../translation_graph/movement/engine_host';
import { inMemoryRawTextStore } from '../../translation_graph/movement/raw_text_store';
import { makeUnstablePosition, positionData } from '../../translation_graph/types';
import { InMemoryWriteLocks } from '../../write_locks/write_locks';
import {
  HOST_FAMILIES,
  hostMethodPaths,
  type AwaitWakeRequest,
  type Scoped,
  type EngineHost,
  type RenderFile,
  type ResolveFileText,
} from '../host';
import type { QueuedWake } from '../host_kit';
import {
  MovementRunFailed,
  resumeMovement,
  runMovement,
  type ParkSink,
  type ResumeMovementInput,
  type RunLimitPause,
  type RunMovementInput,
} from '../run';
import { makeFakeParkSink, makeTestHost, type TestHostOverrides } from '../test_host';
import { awaitingSource, makeAwaitingAdapter, runAwaiting } from './awaitable_fixture';
import { methodPaths, notJsonAt, roundTripHost } from './round_trip_host';
import { tenantIdOf } from 'engine-contracts';
import { tenantOfTeam } from '../../translation_graph/movement/tenant';

const ENGINE_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.resolve(__dirname, '../../..');

/** Engine files that must import no host code. */
const PURE_FILES = [
  'address.ts',
  'ai_tiers.ts',
  'builtins.ts',
  'call_depth.ts',
  'effect_locks.ts',
  'errors.ts',
  'expression.ts',
  'extraction.ts',
  'extraction_call.ts',
  'host.ts',
  'host_adapter.ts',
  'interpretable.ts',
  'kg.ts',
  'local_edge_adapter.ts',
  'program_check.ts',
  'provenance.ts',
  'run.ts',
  'run_context.ts',
  'rust_engine.ts',
  'rust_host.ts',
  'rust_stats.ts',
  'rust_wire.ts',
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
  'host_kit.ts',
  'join_pending.ts',
  'lease_fence.ts',
  'limit_pause.ts',
  'park_sink.ts',
  'run_lease.ts',
  'single_flight.ts',
  'test_host.ts',
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
    reason:
      "a priced call's spend meter (the host meters its calls; the engine keeps the run's ledger)",
  },
  {
    matches: under('services/translation_graph/segment_scope'),
    reason: "a segment's host scope (the engine holds only the segment's id)",
  },
  {
    matches: under('services/translation_graph/adapters'),
    reason: 'adapter implementations (the host supplies `adapters`)',
  },
  {
    matches: under('services/translation_graph/runs'),
    reason: 'run recording (the host supplies `trace`)',
  },
  { matches: under('services/translation_graph/movement'), reason: 'the production host itself' },
  { matches: under('services/document'), reason: 'document storage (the host supplies `files`)' },
  {
    matches: (m) =>
      BYTE_READERS.some((reader) => m === `services/translation_graph/engine/files/${reader}`),
    reason: 'a file byte reader (bytes stay on the host: the engine holds descriptors)',
  },
  { matches: under('services/work'), reason: 'the work queue (the host supplies `park`)' },
  { matches: under('services/interaction'), reason: 'run failure reporting (host side)' },
  { matches: under('services/webhook_sync'), reason: 'inbound sync (host side)' },
  {
    matches: (m) =>
      HOST_SIDE_FILES.some((f) => m === `services/movement_engine/${f.replace(/\.ts$/, '')}`),
    reason: 'a host-side movement_engine module',
  },
];

const ALLOWED: Array<(module: string) => boolean> = [
  (m) => m === 'movement-lang' || m.startsWith('movement-lang/'),
  // The contracts the engine speaks: data shapes and the protocol schema.
  (m) => m === 'engine-contracts',
  (m) => m === 'zod',
  (m) => m.startsWith('node:') || builtinModules.includes(m),
  (m) => m.startsWith('#shared/'),
  under('lib/utils'),
  // The spend vocabulary both sides speak: budgets, cost lines, the cap.
  under('lib/run_cost'),
  under('lib/models'),
  under('lib/prompts'),
  under('services/logger'),
  // Shared engine helpers that are pure computation over engine data:
  // resource stamping and filtering, the model choice for an extraction's
  // size.
  (m) => m === 'services/translation_graph/engine/files/resources',
  (m) => m === 'services/translation_graph/engine/batched_extraction/model_choice',
  under('services/translation_graph/uniqueness'),
  under('services/translation_graph/required_fields'),
  under('services/translation_graph/types'),
  under('services/translation_graph/mutation_context'),
  // The adapter protocol: the contract the engine calls adapters through, no
  // implementation.
  under('services/translation_graph/adapter'),
  (m) => PURE_FILES.some((f) => m === `services/movement_engine/${f.replace(/\.ts$/, '')}`),
];

function under(prefix: string): (module: string) => boolean {
  return (m) => m === prefix || m.startsWith(`${prefix}/`);
}

/** A relative specifier becomes a path under apps/api/src; a bare one stays. */
function moduleOf(fromFile: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier;
  const resolved = path.relative(SRC_DIR, path.resolve(path.dirname(fromFile), specifier));
  return resolved
    .split(path.sep)
    .join('/')
    .replace(/\.(ts|js)$/, '')
    .replace(/\/index$/, '');
}

/** Every specifier the file loads at run time. */
function valueImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
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
    expect(
      FORBIDDEN.some((rule) =>
        rule.matches(moduleOf(probe, '../translation_graph/engine/files/retrieve')),
      ),
    ).toBe(true);
    expect(FORBIDDEN.some((rule) => rule.matches(moduleOf(probe, '../../lib/run_spend')))).toBe(
      true,
    );
    expect(
      FORBIDDEN.some((rule) => rule.matches(moduleOf(probe, '../translation_graph/segment_scope'))),
    ).toBe(true);
  });
});

// ── Generated database code ─────────────────────────────────────────────────
//
// The engine, the contracts it speaks, the test host and the adapter
// protocol's server kit are what an embedder imports without the run host.
// None of them may reach the run host's generated database code, not even by
// a type: a type import still loads the module for the compiler, so an
// embedder compiling against them would need the run host's schema.

const REPO_DIR = path.resolve(SRC_DIR, '../../..');
const CONTRACTS_DIR = path.join(REPO_DIR, 'packages/engine-contracts');

/** The roots an embedder imports. */
const EMBEDDABLE_ROOTS = [
  ...PURE_FILES.map((f) => path.join(ENGINE_DIR, f)),
  path.join(ENGINE_DIR, 'test_host.ts'),
  path.join(SRC_DIR, 'services/translation_graph/protocol/server.ts'),
  path.join(CONTRACTS_DIR, 'index.ts'),
];

/** A resolved file or bare specifier that is generated database code or a
 *  database client. */
function isDatabaseCode(resolvedOrSpecifier: string): boolean {
  return (
    /\/src\/generated\//.test(resolvedOrSpecifier) ||
    /\/src\/prisma(\/|\.ts$|$)/.test(resolvedOrSpecifier) ||
    /\/src\/lib\/kysely\.ts$/.test(resolvedOrSpecifier) ||
    /\/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(kysely|@prisma|\.prisma)\//.test(resolvedOrSpecifier) ||
    /^(kysely|@prisma\/|prisma$)/.test(resolvedOrSpecifier)
  );
}

/** Every specifier the file names, type-only ones included. */
function allImports(file: string): string[] {
  return ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true).importedFiles.map((f) => f.fileName);
}

const RESOLUTION: ts.CompilerOptions = {
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
};

function resolved(specifier: string, fromFile: string): string | undefined {
  return ts.resolveModuleName(specifier, fromFile, RESOLUTION, ts.sys).resolvedModule?.resolvedFileName;
}

/** Source files this repo owns: followed. A library's own files are not. */
function isRepoSource(file: string): boolean {
  if (file.endsWith('.d.ts')) return false;
  const real = fs.realpathSync(file);
  return real.startsWith(REPO_DIR) && !real.includes('/node_modules/');
}

/** Every chain from a root to database code, as `root <= … <= file → specifier`. */
function databaseReach(roots: readonly string[]): string[] {
  const parent = new Map<string, string>();
  const seen = new Set(roots.map((r) => fs.realpathSync(r)));
  const queue = [...seen];
  const reach: string[] = [];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined) break;
    for (const specifier of allImports(file)) {
      const target = resolved(specifier, file);
      if (isDatabaseCode(specifier) || (target !== undefined && isDatabaseCode(target))) {
        const chain = [file];
        for (let at = parent.get(file); at !== undefined; at = parent.get(at)) chain.push(at);
        reach.push(`${chain.map((f) => path.relative(REPO_DIR, f)).join(' <= ')} → '${specifier}'`);
        continue;
      }
      if (target === undefined || !isRepoSource(target)) continue;
      const real = fs.realpathSync(target);
      if (seen.has(real)) continue;
      seen.add(real);
      parent.set(real, file);
      queue.push(real);
    }
  }
  return reach;
}

function contractFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__embed_smoke__') continue;
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(at);
      else if (entry.name.endsWith('.ts')) files.push(at);
    }
  };
  walk(CONTRACTS_DIR);
  return files;
}

describe('generated database code stays out of what an embedder imports', () => {
  it('no pure engine file and no contract file imports database code, not even a type', () => {
    const violations: string[] = [];
    for (const file of [...PURE_FILES.map((f) => path.join(ENGINE_DIR, f)), ...contractFiles()]) {
      for (const specifier of allImports(file)) {
        const target = resolved(specifier, file);
        if (isDatabaseCode(specifier) || (target !== undefined && isDatabaseCode(target))) {
          violations.push(`${path.relative(REPO_DIR, file)} imports '${specifier}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the contracts package imports nothing of the run host', () => {
    const violations: string[] = [];
    for (const file of contractFiles()) {
      for (const specifier of allImports(file)) {
        const target = resolved(specifier, file);
        if (target !== undefined && fs.realpathSync(target).startsWith(path.join(REPO_DIR, 'apps/'))) {
          violations.push(`${path.relative(REPO_DIR, file)} imports '${specifier}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the engine, the contracts, the test host and the server kit reach no database code, by any path', () => {
    expect(databaseReach(EMBEDDABLE_ROOTS)).toEqual([]);
  });

  it('a type import of generated code counts as reaching it', () => {
    const probe = path.join(ENGINE_DIR, 'probe.ts');
    expect(isDatabaseCode(resolved('../../generated/kysely/core/Team', probe) ?? '')).toBe(true);
    expect(allImports(path.join(SRC_DIR, 'services/translation_graph/movement/tenant.ts'))).toContain(
      '../../../generated/kysely/core/Team',
    );
    expect(databaseReach([path.join(SRC_DIR, 'services/translation_graph/movement/tenant.ts')])).not.toEqual([]);
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
      teamId: tenantIdOf('00000000-0000-0000-0000-000000000042'),
      source: awaitingSource(),
      adapter: awaiting.adapter,
      parkSink: recording,
      wake: async (request: Scoped<AwaitWakeRequest>) => {
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
      const output = {
        text: 'the digest',
        rawTextId: 'rt-1',
        cost: [{ source: 'model:ocr', microdollars: 120 }],
      };
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
      teamId: tenantOfTeam(teamId),
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
    expect(made.map((c) => c.call)).toEqual([
      'segment.open',
      'render',
      'resolveFileText',
      'segment.close',
    ]);
    expect(made[0]?.input).toEqual({ teamId, languageVersion: CURRENT_LANGUAGE_VERSION });
    // Every call names the segment the run opened.
    expect(made[1]?.input).toEqual({ segmentId: 'seg-1', content: 'the digest', type: 'text' });
    // A priced call: the run's budget in (no cap here), what it spent out —
    // and the run charged it.
    expect(made[2]?.input).toEqual({
      segmentId: 'seg-1',
      file: made[1]?.output,
      budget: { remainingMicrodollars: null },
    });
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

  // The engine never holds a live adapter: it resolves an instance to data
  // and an opaque id, and calls it by method name with one JSON argument.
  it('adapter instances are resolved and called with plain data only', async () => {
    const teamId = '00000000-0000-0000-0000-000000000044' as TeamId;
    const calls: Array<{ call: string; method?: string; input: unknown; output: unknown }> = [];
    const manual = createManualAdapter({ teamId });
    const kg: Adapter = {
      adapterType: 'kg',
      supportedTriggers: ['webhook'],
      runtimeCapabilities: () => ({
        traversal: { incoming: false, edgeProperties: false },
        resources: false,
      }),
      listEntryPoints: async () => [],
      describe: async () => null,
      resolveEntity: async () => ({ candidates: [] }),
      getFieldValue: async () => null,
      getRelated: async () => [],
      createRecord: async () => ({ adapterType: 'kg', externalId: 'note-1', data: {} }),
      updateRecord: async (input) => ({
        adapterType: 'kg',
        externalId: input.externalId,
        data: {},
        association: 'none',
      }),
      deleteRecord: async () => ({}),
    };
    const inner = makeTestHost({
      adapters: { resolve: ({ adapterType }) => (adapterType === 'kg' ? kg : manual) },
    });
    const host: EngineHost = {
      ...inner,
      adapters: {
        resolve: async (input) => {
          const output = await inner.adapters.resolve(input);
          calls.push({ call: 'adapters.resolve', input, output });
          return output;
        },
        call: async (input) => {
          const output = await inner.adapters.call(input);
          calls.push({ call: 'adapters.call', method: input.method, input, output });
          return output;
        },
      },
    };
    const result = await runMovement({
      source: [
        'import { manual, kg } from adapters',
        'import { kg_cred } from credentials',
        'runs = manual()',
        'graph = kg(credentials: kg_cred)',
        '',
        'movement m(go: <runs-[:Invocation]->>) {',
        '  write graph-[:note]-> { unique by (`body`) body: "hello" }',
        '}',
        'listen to runs {} fire m',
      ].join('\n'),
      event: {
        pipelineInputId: 'trigger:manual-adapters',
        adapterType: 'manual',
        triggerType: 'webhook',
        payload: { firedAt: '2026-10-07T09:00:00.000Z' },
        occurredAt: '2026-10-07T09:00:00.000Z',
      },
      teamId: tenantOfTeam(teamId),
      catalog: staticCatalogSnapshot({
        credentials: { kg_cred: { adapters: ['kg'] } },
        instanceSchemas: {
          kg: {
            positions: { note: { properties: { body: 'text' }, edges: {} } },
            collections: { note: { target: 'note' } },
            writableRoots: {
              note: { fields: { body: 'text' }, resultShape: { externalId: 'text' } },
            },
          },
        },
      }),
      credentialIds: { kg_cred: 'cred-kg' },
      host,
    });

    expect(result.writes).toHaveLength(1);
    const methods = calls.filter((c) => c.call === 'adapters.call').map((c) => c.method);
    expect(methods).toEqual(expect.arrayContaining(['resolveEntity', 'createRecord']));
    expect(calls.filter((c) => c.call === 'adapters.resolve').map((c) => c.input)).toContainEqual(
      expect.objectContaining({ adapterType: 'kg', credentialsId: 'cred-kg', role: 'target' }),
    );
    expect(JSON.parse(JSON.stringify(calls))).toEqual(calls);
  });

  // The rest of the host's families, as one run uses them: the acting-user
  // lookup names the source instance and the event (the host asks the source
  // itself), a callback and a timer carry their instants as ISO strings, the
  // write's cross-run locks go by token, and the trace is appended as data.
  it('the lookup, callbacks, timers, locks and trace pass plain data only', async () => {
    const teamId = '00000000-0000-0000-0000-000000000045' as TeamId;
    const calls: Array<{ call: string; input: unknown; output: unknown }> = [];
    const record = async <T>(call: string, input: unknown, answer: Promise<T>): Promise<T> => {
      const output = await answer;
      calls.push({ call, input, output: output ?? null });
      return output;
    };
    const manual = createManualAdapter({ teamId });
    const kg: Adapter = {
      adapterType: 'kg',
      supportedTriggers: ['webhook'],
      runtimeCapabilities: () => ({
        traversal: { incoming: false, edgeProperties: false },
        resources: false,
      }),
      listEntryPoints: async () => [],
      describe: async () => null,
      resolveEntity: async () => ({ candidates: [] }),
      getFieldValue: async () => null,
      getRelated: async () => [],
      createRecord: async () => ({ adapterType: 'kg', externalId: 'note-1', data: {} }),
      updateRecord: async (input) => ({
        adapterType: 'kg',
        externalId: input.externalId,
        data: {},
        association: 'none',
      }),
      deleteRecord: async () => ({}),
    };
    const parks = makeFakeParkSink();
    const appended: unknown[] = [];
    const inner = makeTestHost({
      adapters: { resolve: ({ adapterType }) => (adapterType === 'kg' ? kg : manual) },
      park: {
        sink: parks.sink,
        callbacks: {
          mint: async () => ({ id: 'cb_1', url: 'https://api.test/api/cb/cb_1' }),
          calls: async () => [],
        },
      },
      lookup: {
        resolveActingUser: async () => ({ id: 'user-1', email: 'amy@acme.dev', name: 'Amy' }),
      },
      trace: [],
    });
    const sink = inner.park.sink!;
    const callbacks = inner.park.callbacks!;
    const appendTrace = inner.trace!;
    const host: EngineHost = {
      ...inner,
      park: {
        ...inner.park,
        sink: {
          ...sink,
          commitTimerPark: (input) =>
            record('park.sink.commitTimerPark', input, sink.commitTimerPark(input)),
        },
        callbacks: {
          ...callbacks,
          mint: (input) => record('park.callbacks.mint', input, callbacks.mint(input)),
        },
      },
      lookup: {
        resolveActingUser: (input) =>
          record('lookup.resolveActingUser', input, inner.lookup.resolveActingUser(input)),
      },
      locks: {
        acquire: (input) => record('locks.acquire', input, inner.locks.acquire(input)),
        release: (input) => record('locks.release', input, inner.locks.release(input)),
      },
      trace: {
        append: (input) => {
          appended.push(...input.entries);
          return record('trace.append', input, appendTrace.append(input));
        },
      },
    };
    const result = await runMovement({
      source: [
        'import { manual, kg } from adapters',
        'import { kg_cred } from credentials',
        'runs = manual()',
        'graph = kg(credentials: kg_cred)',
        '',
        'movement m(go: <runs-[:Invocation]->>) {',
        '  write graph-[:note]-> { unique by (`body`) body: "by ${@user_email}" }',
        '  cb = callback({ write graph-[:note]-> { body: "called" } }, { ttl: 2d })',
        '  await sleep(1d)',
        '}',
        'listen to runs {} fire m',
      ].join('\n'),
      event: {
        pipelineInputId: 'trigger:manual-families',
        adapterType: 'manual',
        triggerType: 'webhook',
        payload: { firedAt: '2026-10-07T09:00:00.000Z' },
        occurredAt: '2026-10-07T09:00:00.000Z',
      },
      teamId: tenantOfTeam(teamId),
      firedAt: '2026-10-07T09:00:00.000Z',
      catalog: staticCatalogSnapshot({
        credentials: { kg_cred: { adapters: ['kg'] } },
        instanceSchemas: {
          kg: {
            positions: { note: { properties: { body: 'text' }, edges: {} } },
            collections: { note: { target: 'note' } },
            writableRoots: {
              note: { fields: { body: 'text' }, resultShape: { externalId: 'text' } },
            },
          },
        },
      }),
      host,
    });

    expect(result.parked).toBe(true);
    expect(result.writes[0]?.writtenValues).toEqual({ body: 'by amy@acme.dev' });
    const made = new Set(calls.map((c) => c.call));
    expect([...made].sort()).toEqual([
      'locks.acquire',
      'locks.release',
      'lookup.resolveActingUser',
      'park.callbacks.mint',
      'park.sink.commitTimerPark',
      'trace.append',
    ]);
    const lookup = calls.find((c) => c.call === 'lookup.resolveActingUser');
    // The lookup names its segment and the source instance; the team is the
    // segment's, so it is not repeated.
    expect(lookup?.input).toMatchObject({
      segmentId: expect.any(String),
      instance: expect.any(String),
    });
    expect(lookup?.input).not.toHaveProperty('teamId');
    expect(calls.find((c) => c.call === 'park.callbacks.mint')?.input).toMatchObject({
      segmentId: expect.any(String),
      expiresAt: expect.any(String),
    });
    expect(calls.find((c) => c.call === 'park.sink.commitTimerPark')?.input).toMatchObject({
      segmentId: expect.any(String),
      wakeAt: expect.any(String),
    });
    // Every call of the segment names the one segment it opened.
    const segmentIds = new Set(
      calls.map((c) => (typeof c.input === 'object' && c.input !== null ? Reflect.get(c.input, 'segmentId') : undefined)),
    );
    expect([...segmentIds]).toEqual([expect.any(String)]);
    // What the host was handed of the trace is the run's whole trace.
    expect(appended).toEqual(result.trace);
    expect(JSON.parse(JSON.stringify(calls))).toEqual(calls);
  });
});

// ── Every family, round-tripped ─────────────────────────────────────────────
//
// The tests above pin particular shapes. These prove the general claim: every
// method of every family takes and answers JSON. The host each run is handed
// is wrapped so each request and each answer is serialised and parsed on the
// way across (`round_trip_host.ts`), and fails naming the method and the path
// of anything JSON cannot carry. The wrapper walks the host object, so a
// method added to any family is wrapped without being listed; the manifest
// (`HOST_FAMILIES`) is what the doc and this test agree the host is, and the
// runs below reach every method on it.

/** Each method path the family suite's runs reached; only that suite's
 *  runs add to it, and only that suite asserts it. */
const REACHED = new Set<string>();
const ROUND_TRIP_TEAM = '00000000-0000-0000-0000-000000000046' as TeamId;

/** A CRM whose companies resolve by similarity, with notes beside them. */
const CRM_SCHEMA: InstanceSchema = {
  supportsInPlaceUpdate: true,
  positions: {
    company: { properties: { name: 'text', summary: 'text' }, edges: {} },
    note: { properties: { title: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  writableRoots: {
    company: {
      fields: { name: 'text', summary: 'text' },
      resultShape: { externalId: 'text', name: 'text', summary: 'text' },
      fuzzyResolution: true,
    },
    note: { fields: { title: 'text' }, resultShape: { externalId: 'text', title: 'text' } },
  },
};
const roundTripCatalog = staticCatalogSnapshot({
  credentials: { acme_main: { adapters: ['attio'] } },
  instanceSchemas: { attio: CRM_SCHEMA },
});

const ROUND_TRIP_PRELUDE = [
  'import { email, attio } from adapters',
  'import { acme_main } from credentials',
  'import { fetch_url } from plugins',
  '',
  'inbox = email()',
  'crm = attio(credentials: acme_main)',
  '',
  'node Detail: "more about the company" {',
  '  summary: <text> "one line on what it does"',
  '}',
  '',
].join('\n');

interface FakeCrm {
  adapter: Adapter;
  creates: Array<{ recordType: string; fields: Record<string, unknown> }>;
}

/** A CRM fake: finds `candidates` for a company, creates with fresh ids, and
 *  answers an update by id as not found when `updatesFind` is false. */
function fakeCrm(
  options: { candidates?: ExternalRecordRef[]; updatesFind?: boolean; createFails?: Error } = {},
): FakeCrm {
  const creates: FakeCrm['creates'] = [];
  const adapter: Adapter = {
    adapterType: 'attio',
    supportedTriggers: [],
    runtimeCapabilities: () => ({
      traversal: { incoming: true, edgeProperties: true },
      resources: true,
    }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async ({ recordType }) => ({
      candidates: recordType === 'company' ? options.candidates ?? [] : [],
    }),
    getFieldValue: async ({ position, fieldId }) => {
      const data = positionData(position);
      return typeof data === 'object' && data !== null ? Reflect.get(data, fieldId) ?? null : null;
    },
    getRelated: async () => [],
    createRecord: async (input) => {
      if (options.createFails !== undefined) throw options.createFails;
      creates.push({ recordType: input.recordType, fields: input.fields });
      return {
        adapterType: 'attio',
        externalId: `co-new-${creates.length}`,
        data: { ...input.fields },
      };
    },
    updateRecord: async (input) =>
      options.updatesFind === false
        ? { notFound: true }
        : {
            adapterType: 'attio',
            externalId: input.externalId,
            data: {},
            association: containerAssociation(input),
          },
    deleteRecord: async () => ({}),
  };
  return { adapter, creates };
}

/** The inbound email as a source fake that pages its attachments: two pages,
 *  the second asked for by a cursor that is a JSON object. */
function pagedInbox(): { adapter: Adapter; cursors: unknown[] } {
  const cursors: unknown[] = [];
  const attachment = (name: string): RelatedResult => ({
    position: makeUnstablePosition({
      adapterType: 'email',
      recordType: 'attachment',
      data: { filename: name },
    }),
  });
  const page = async (_input: GetRelatedInput, cursor?: unknown): Promise<RelatedPage> => {
    cursors.push(cursor ?? null);
    return cursor === undefined
      ? { items: [attachment('deck.pdf')], nextCursor: { after: 'deck.pdf', page: 2 } }
      : { items: [attachment('cap-table.xlsx')] };
  };
  const adapter: Adapter = {
    adapterType: 'email',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => ({
      traversal: { incoming: false, edgeProperties: false },
      resources: true,
    }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async ({ position, fieldId }) => {
      const data = positionData(position);
      return typeof data === 'object' && data !== null ? Reflect.get(data, fieldId) ?? null : null;
    },
    getRelated: async () => [],
    iterateRelated: (input) => iterateRelatedPages((cursor) => page(input, cursor)),
    iterateRelatedPage: page,
    getActorCandidates: async () => [{ identity: { identifier: 'amy@acme.dev', scheme: 'email' }, source: 'originator' }],
    createRecord: async () => {
      throw new Error('test: email is a source');
    },
    updateRecord: async () => {
      throw new Error('test: email is a source');
    },
    deleteRecord: async () => ({}),
  };
  return { adapter, cursors };
}

type ParkKind = 'timer' | 'await' | 'suspension';

/** An in-memory park sink with the durable join semantics of the real one. */
function joiningParkSink() {
  const parks = new Map<string, { kind: ParkKind; state: ParkedScopeState }>();
  const joins = new Map<
    string,
    { pending: number; closedBy: string | null; decremented: Set<string> }
  >();
  const exports = new Map<string, Map<string, { branchIndex: number; exports: unknown }>>();
  const pauses: RunLimitPause[] = [];
  const cancelled: Array<{ subtreeAddresses: string[]; excludeLeaf?: string }> = [];
  const keep = (kind: ParkKind, address: string, state: unknown): void => {
    parks.set(address, { kind, state: JSON.parse(JSON.stringify(state)) as ParkedScopeState });
  };
  const sink: ParkSink = {
    async recordJoin(input) {
      const existing = joins.get(input.frameAddress);
      joins.set(input.frameAddress, {
        pending: input.parkedChildren,
        closedBy: existing?.closedBy ?? null,
        decremented: existing?.decremented ?? new Set(),
      });
    },
    async commitTimerPark(input) {
      keep('timer', input.address, input.state);
    },
    async commitAwaitPark(input) {
      keep('await', input.address, input.state);
    },
    async commitSuspension(input) {
      keep('suspension', input.address, input.state);
    },
    async commitLimitPause({ limit, capMicrodollars, spentMicrodollars }) {
      pauses.push({ limit, capMicrodollars, spentMicrodollars });
    },
    async decrementJoin(input) {
      const frame = joins.get(input.frameAddress);
      if (frame === undefined) return { closed: false };
      if (frame.decremented.has(input.branchAddress))
        return { closed: frame.closedBy === input.leafAddress };
      frame.decremented.add(input.branchAddress);
      if (frame.pending === 0) return { closed: frame.closedBy === input.leafAddress };
      frame.pending -= 1;
      if (frame.pending > 0) return { closed: false };
      frame.closedBy = input.leafAddress;
      return { closed: true };
    },
    async persistBranchExport(input) {
      const byBranch = exports.get(input.frameAddress) ?? new Map();
      byBranch.set(input.branchAddress, { branchIndex: input.branchIndex, exports: input.exports });
      exports.set(input.frameAddress, byBranch);
    },
    async collectBranchExports(input) {
      return [...(exports.get(input.frameAddress) ?? new Map()).entries()]
        .map(([branchAddress, row]) => ({
          branchAddress,
          branchIndex: row.branchIndex,
          exports: row.exports,
        }))
        .sort((a, b) => a.branchIndex - b.branchIndex);
    },
    async cancelSubtrees(input) {
      cancelled.push(input);
      for (const address of [...parks.keys()]) {
        const under = input.subtreeAddresses.some(
          (prefix) => address === prefix || address.startsWith(`${prefix}.`),
        );
        if (under && address !== input.excludeLeaf) parks.delete(address);
      }
    },
  };
  return { sink, parks, pauses, cancelled };
}

function roundTripEvent(
  payload: Record<string, unknown> = { subject: 'Acme intro', text: 'https://acme.example' },
): TriggerEvent {
  return {
    pipelineInputId: 'pi-round-trip',
    adapterType: 'email',
    triggerType: 'webhook',
    payload,
  };
}

/** One run through a round-tripped test host, and resumes of whatever it
 *  parked. */
function roundTrip(
  body: string[],
  overrides: TestHostOverrides & { crm?: FakeCrm; inbox?: Adapter } = {},
) {
  const crm = overrides.crm ?? fakeCrm();
  const inbox = overrides.inbox ?? pagedInbox().adapter;
  const { crm: _crm, inbox: _inbox, ...hostOverrides } = overrides;
  const input = () => ({
    source: [ROUND_TRIP_PRELUDE, 'movement intake(m: <inbox-[:message]->>) {', ...body, '}'].join(
      '\n',
    ),
    movementName: 'intake',
    event: roundTripEvent(),
    teamId: tenantOfTeam(ROUND_TRIP_TEAM),
    catalog: roundTripCatalog,
    credentialIds: { acme_main: 'cred-attio-1' },
    firedAt: '2026-10-07T09:00:00.000Z',
    host: roundTripHost(
      makeTestHost({
        ...hostOverrides,
        adapters: {
          ...hostOverrides.adapters,
          resolve: ({ adapterType }) => (adapterType === 'email' ? inbox : crm.adapter),
        },
      }),
      REACHED,
    ),
    dryRun: false,
  });
  return {
    crm,
    run: (extra: Partial<RunMovementInput> = {}) => runMovement({ ...input(), ...extra }),
    resume: (state: ParkedScopeState, extra: Partial<ResumeMovementInput> = {}) =>
      resumeMovement({ ...input(), state, ...extra }),
  };
}

describe('the round trip', () => {
  it('names the method and the path of whatever JSON cannot carry', async () => {
    class Money {
      constructor(readonly cents: number) {}
    }
    const refused: Array<[unknown, string]> = [
      [() => 1, 'a function'],
      [new Money(5), 'an instance of Money'],
      [new Date('2026-10-07T09:00:00.000Z'), 'an instance of Date'],
      [new Map([['a', 1]]), 'an instance of Map'],
      [new Set([1]), 'an instance of Set'],
      [Readable.from(['bytes']), 'an instance of Readable'],
      [[1, undefined], 'undefined'],
      [BigInt(1), 'a BigInt'],
      [Number.NaN, 'NaN'],
      [Number.POSITIVE_INFINITY, 'Infinity'],
      [-0, '-0'],
      ['half a pair \uD83D', 'a string with a lone surrogate'],
    ];
    for (const [value, what] of refused) {
      const host = roundTripHost(
        makeTestHost({
          files: { resolveFileText: async () => ({ text: 'ok', nested: { value } }) as never },
        }),
      );
      await expect(
        host.files.resolveFileText({
          segmentId: 'seg-1',
          file: { __brand: 'FileRef', name: 'x', source: { store: 'document', objectUri: 'u' } },
          budget: { remainingMicrodollars: null },
        }),
      ).rejects.toThrow(
        `files.resolveFileText: answer.nested.value${Array.isArray(value) ? '[1]' : ''} is ${what}`,
      );
    }
    // The request is checked too, and a method that answers without a promise
    // could not cross a wire.
    const host = roundTripHost(makeTestHost());
    expect(() => host.locks.release({ segmentId: 'seg-1', token: new Date() as never })).toThrow(
      'locks.release: request[0].token is an instance of Date',
    );
    const sync = roundTripHost({
      ...makeTestHost(),
      lookup: { resolveActingUser: (() => null) as never },
    });
    expect(() => sync.lookup.resolveActingUser({} as never)).toThrow(
      'lookup.resolveActingUser: answer is answered synchronously',
    );
    // An undefined field is an absent one on the far side.
    expect(notJsonAt({ a: undefined, b: [null, { c: 'x' }] }, 'value')).toBeUndefined();
    // A value that contains itself is named, not recursed into; the same
    // object twice side by side is no cycle.
    const loop: Record<string, unknown> = { name: 'loop' };
    loop.inner = { back: loop };
    expect(notJsonAt({ loop }, 'answer')).toEqual({
      path: 'answer.loop.inner.back',
      what: 'a cycle back to answer.loop',
    });
    const shared = { x: 1 };
    expect(notJsonAt({ a: shared, b: shared }, 'answer')).toBeUndefined();
    expect(notJsonAt('a whole pair \uD83D\uDE00', 'answer')).toBeUndefined();
  });

  it('only a void method may answer nothing', async () => {
    const silent = roundTripHost({
      ...makeTestHost(),
      lookup: { resolveActingUser: async () => undefined as never },
    });
    await expect(silent.lookup.resolveActingUser({} as never)).rejects.toThrow(
      'lookup.resolveActingUser: answer is undefined',
    );
    const chatty = roundTripHost({
      ...makeTestHost(),
      locks: { ...makeTestHost().locks, release: async () => ({ released: true }) as never },
    });
    await expect(chatty.locks.release({ segmentId: 'seg-1', token: 't' })).rejects.toThrow(
      'locks.release: answer is a value from a void method',
    );
    const quiet = roundTripHost({
      ...makeTestHost(),
      locks: { ...makeTestHost().locks, release: async () => {} },
    });
    await expect(quiet.locks.release({ segmentId: 'seg-1', token: 't' })).resolves.toBeUndefined();
  });

  it('wraps every method of every family, which are the manifest’s', () => {
    const { sink } = joiningParkSink();
    const host = makeTestHost({
      park: {
        sink,
        callbacks: { mint: async () => ({ id: 'cb', url: 'u' }), calls: async () => [] },
      },
      trace: [],
    });
    expect(methodPaths(roundTripHost(host)).sort()).toEqual(hostMethodPaths().sort());
  });

  it('the manifest is the contract docs/contracts/host-families.md documents, method by method', () => {
    const doc = fs.readFileSync(path.resolve(SRC_DIR, '../../../docs/contracts/host-families.md'), 'utf8');
    const documented = [...doc.matchAll(/^#### `([A-Za-z.]+)`/gm)].map((match) => match[1]);
    expect(documented.sort()).toEqual(hostMethodPaths().sort());
    const families = [...doc.matchAll(/^### `([A-Za-z.]+)`/gm)].map((match) => match[1]);
    expect(families.sort()).toEqual(Object.keys(HOST_FAMILIES).sort());
  });
});

describe('every family crosses as JSON', () => {
  // The manifest check below holds only over a whole run of this suite: a
  // filtered run (`-t`) reaches a subset, which proves nothing either way.
  const declared = new Set<string>();
  const ran = new Set<string>();
  const familyRun = (name: string, fn: () => Promise<void>): void => {
    declared.add(name);
    it(name, async () => {
      ran.add(name);
      await fn();
    });
  };

  familyRun('models and plugins: AI(), extract(…), a plugin, and the judge', async () => {
    const h = roundTrip(
      [
        '  page = fetch_url(url: m.`text`)',
        '  found = extract([m.`subject`], Detail)',
        '  co = match crm-[:companies]-> { unique by (FUZZY `name`)',
        '    name: "Acme"',
        '  }',
        '  write crm-[:notes]-> { title: "${AI(m.`subject`)} ${COALESCE(page, "")} ${COALESCE(FIRST(found).summary, "")}" }',
      ],
      {
        crm: fakeCrm({
          candidates: [
            { adapterType: 'attio', externalId: 'co-1', data: { name: 'Acme Inc', summary: 's' } },
          ],
        }),
        llm: {
          client: {
            call: async () => ({
              parsedJson: { value: 'ACME', has_value: true },
              cost: [{ source: 'model:test', microdollars: 3 }],
            }),
          },
          extractCall: {
            call: async () => ({
              parsedJson: {
                records: [
                  { summary: { value: 'builds infra', evidence: { item: 0, quote: 'Acme' } } },
                ],
              },
              usage: {
                inputTokens: 10,
                outputTokens: 2,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
              },
            }),
          },
          transforms: { invoke: async () => ({ text: 'raised a seed' }) },
          arbitrateEntities: async () => ({ index: 0 }),
        },
      },
    );
    await h.run();
    expect(h.crm.creates).toEqual([
      { recordType: 'note', fields: { title: 'ACME raised a seed builds infra' } },
    ]);
  });

  familyRun('bindings: a bound counterpart found, gone, forgotten and rebound', async () => {
    const recorded: unknown[] = [];
    const h = roundTrip(
      [
        '  co = match crm-[:companies]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
        '  write crm-[:notes]-> bind co { title: m.`subject` }',
      ],
      {
        crm: fakeCrm({
          candidates: [
            { adapterType: 'attio', externalId: 'co-1', data: { name: 'Acme', summary: 's' } },
          ],
          updatesFind: false,
        }),
        park: {
          bindings: {
            record: async (input) => {
              recorded.push(input);
            },
            findBoundCounterpart: async () => ({
              adapterType: 'attio',
              instanceKey: 'k',
              typeId: 'company',
              recordId: 'co-gone',
            }),
            delete: async () => {},
          },
        },
      },
    );
    await h.run();
    expect(h.crm.creates).toHaveLength(1);
    expect(recorded).toHaveLength(1);
  });

  familyRun('parks: a callback and its ledger, a parallel join, a race settled', async () => {
    const parks = joiningParkSink();
    const h = roundTrip(
      [
        '  cb = callback({ write crm-[:notes]-> { title: "called" } }, { ttl: 2d })',
        '  cb-[c:Called]-> { write crm-[:notes]-> { title: c.At } }',
        '  r = await parallel([',
        '    () => { await sleep(1h)',
        '      return "a" },',
        '    () => { await sleep(2h)',
        '      return "b" },',
        '  ])',
        '  w = await race([',
        '    () => { await sleep(1h)',
        '      return "first" },',
        '    () => { await sleep(30d) },',
        '  ])',
        '  write crm-[:notes]-> { title: "${AT(r, 0)}${AT(r, 1)} ${AT(w, 0)}" }',
      ],
      {
        park: {
          sink: parks.sink,
          callbacks: {
            mint: async () => ({ id: 'cb_1', url: 'https://api.test/api/cb/cb_1' }),
            calls: async () => [{ at: '2026-10-07T10:00:00.000Z', values: {} }],
          },
        },
      },
    );
    const wake = async (): Promise<void> => {
      while (parks.parks.size > 0) {
        const [address, park] = [...parks.parks.entries()].sort(([a], [b]) =>
          a.localeCompare(b),
        )[0]!;
        parks.parks.delete(address);
        await h.resume(park.state);
      }
    };
    expect((await h.run()).parked).toBe(true);
    await wake();
    expect(h.crm.creates.map((c) => c.fields.title)).toEqual([
      '2026-10-07T10:00:00.000Z',
      'ab first',
    ]);
    expect(parks.cancelled.length).toBeGreaterThan(0);
  });

  familyRun('a limit pause: a priced call refused past the budget suspends the run', async () => {
    const parks = joiningParkSink();
    let invocations = 0;
    const h = roundTrip(
      [
        '  a = fetch_url(url: "a")',
        '  b = fetch_url(url: "b")',
        '  write crm-[:notes]-> { title: "${a}${b}" }',
      ],
      {
        park: { sink: parks.sink },
        llm: {
          transforms: {
            invoke: async () =>
              ++invocations === 1
                ? { text: 'got', cost: [{ source: 'plugin:fetch_url', microdollars: 900 }] }
                : {
                    error: { kind: 'budget', message: 'run budget spent' },
                    cost: [{ source: 'plugin:fetch_url', microdollars: 200 }],
                  },
          },
        },
      },
    );
    const result = await h.run({ costCapMicrodollars: 1000 });
    expect(result.parked).toBe(true);
    expect(parks.pauses).toEqual([
      { limit: 'cost', capMicrodollars: 1000, spentMicrodollars: 1100 },
    ]);
    expect([...parks.parks.values()].map((p) => p.kind)).toEqual(['suspension']);
  });

  familyRun('an await: the awaitable checked, parked, re-checked and woken', async () => {
    const { sink } = joiningParkSink();
    const wakes: QueuedWake[] = [];
    const result = await runAwaiting({
      teamId: tenantOfTeam(ROUND_TRIP_TEAM),
      source: awaitingSource(),
      adapter: makeAwaitingAdapter([
        { status: 'pending', correlationKey: 'req-1' },
        {
          status: 'landed',
          correlationKey: 'req-1',
          landings: [{ recordId: 'req-1', recordType: 'Check Response', fields: { Answer: true } }],
        },
      ]).adapter,
      parkSink: sink,
      wakes,
      wrapHost: (host) => roundTripHost(host, REACHED),
    });
    expect(result.parked).toBe(true);
    expect(wakes).toEqual([
      { adapterType: 'ask', teamId: ROUND_TRIP_TEAM, correlationKey: 'req-1' },
    ]);
  });

  familyRun('adapters, the lookup, locks and the trace: a paged traversal, an identity write, the acting user', async () => {
    const inbox = pagedInbox();
    const trace: MovementTraceEntry[] = [];
    const h = roundTrip(
      [
        '  m-[a:files]-> {',
        '    write crm-[:companies]-> { unique by (`name`) name: a.`filename`, summary: @user_email }',
        '  }',
      ],
      {
        inbox: inbox.adapter,
        trace,
        lookup: {
          resolveActingUser: async ({ getCandidates }) => {
            const [candidate] = await getCandidates();
            return { id: 'user-1', email: candidate?.identity.identifier ?? 'nobody', name: 'Amy' };
          },
        },
      },
    );
    const result = await h.run();
    expect(inbox.cursors).toEqual([null, { after: 'deck.pdf', page: 2 }]);
    expect(h.crm.creates.map((c) => c.fields)).toEqual([
      { name: 'deck.pdf', summary: 'amy@acme.dev' },
      { name: 'cap-table.xlsx', summary: 'amy@acme.dev' },
    ]);
    expect(trace).toEqual(result.trace);
  });

  familyRun('an adapter failure: its message, name and detail, as data', async () => {
    class CrmApiError extends Error {
      readonly status = 409;
      readonly code = 'conflict';
      constructor() {
        super('attio: 409 Conflict');
        this.name = 'CrmApiError';
      }
    }
    const h = roundTrip(['  write crm-[:notes]-> { title: "x" }'], {
      crm: fakeCrm({ createFails: new CrmApiError() }),
    });
    const failure: unknown = await h.run().catch((error: unknown) => error);
    if (!(failure instanceof MovementRunFailed)) throw failure;
    expect(failure.cause).toMatchObject({
      message: 'attio: 409 Conflict',
      name: 'CrmApiError',
      detail: { status: 409, code: 'conflict' },
    });
  });

  familyRun('the call ceiling: answered as data, raised as the engine’s own', async () => {
    const h = roundTrip(['  write crm-[:notes]-> { title: "x" }'], {
      crm: fakeCrm({ createFails: new Error('ceiling') }),
      adapters: {
        classify: (error) =>
          error instanceof Error && error.message === 'ceiling'
            ? { kind: 'call_ceiling', message: 'Affinity call ceiling reached' }
            : adapterErrorOf(error),
      },
    });
    await expect(h.run()).rejects.toMatchObject({
      name: 'AdapterCallCeilingExceeded',
      message: 'Affinity call ceiling reached',
    });
  });

  familyRun('files: a FILE() rendered and READ', async () => {
    const h = roundTrip(
      [
        '  f = FILE("the digest", "text")',
        '  write crm-[:notes]-> { title: COALESCE(READ(f), "unread") }',
      ],
      {
        files: { resolveFileText: async () => ({ text: 'the digest', rawTextId: 'rt-1' }) },
      },
    );
    await h.run();
    expect(h.crm.creates).toEqual([{ recordType: 'note', fields: { title: 'the digest' } }]);
  });

  it('reached every method on the manifest', () => {
    const skipped = [...declared].filter((name) => !ran.has(name));
    if (skipped.length > 0) return;
    expect([...REACHED].sort()).toEqual(hostMethodPaths().sort());
  });
});

// Production results are JSON too: a conformance-style run against the real
// built-in email adapter, through the production host, wrapped the same way.
describe('the production host crosses as JSON', () => {
  // The email instance as the adapter describes itself (its natural names),
  // where the static catalog's stand-in carries a test's own spelling.
  const manifestCatalog = staticCatalogSnapshot({
    credentials: { acme_main: { adapters: ['attio'] } },
    instanceSchemas: {
      attio: CRM_SCHEMA,
      email: {
        positions: {
          Email: { properties: { Subject: 'text', From: 'text', Body: 'text' }, edges: { Attachments: { target: 'Attachment' } } },
          Attachment: { properties: { Name: 'text', 'Content Type': 'text', File: 'file' }, edges: {} },
        },
        collections: { message: { target: 'Email' } },
        writableRoots: {},
      },
    },
  });

  it('reads a real email and walks its attachments', async () => {
    const writes: CapturedWrite[] = [];
    const reached = new Set<string>();
    const host = roundTripHost(
      productionEngineHost({
        teamId: ROUND_TRIP_TEAM,
        resolveLive: ({ adapterType }) =>
          adapterType === 'email'
            ? createEmailAdapter({ teamId: ROUND_TRIP_TEAM })
            : fakeCrm().adapter,
        writeSink: (write) => writes.push(write),
        locks: new InMemoryWriteLocks(),
        rawText: inMemoryRawTextStore(),
      }),
      reached,
    );
    const result = await runMovement({
      source: [
        'import { email, attio } from adapters',
        'import { acme_main } from credentials',
        'inbox = email()',
        'crm = attio(credentials: acme_main)',
        '',
        'movement intake(m: <inbox-[:Email]->>) {',
        '  m-[a:Attachments]-> {',
        '    write crm-[:notes]-> { title: "${m.`Subject`} from ${m.`From`}: ${a.`Name`}" }',
        '  }',
        '}',
      ].join('\n'),
      movementName: 'intake',
      event: roundTripEvent({
        messageId: '<msg-001@sender.example>',
        subject: 'Series A deck',
        sender: 'jane@acme.example',
        attachments: [
          { key: 'att-deck-1', filename: 'deck.pdf', contentType: 'application/pdf', size: 12345 },
          {
            key: 'att-cap-2',
            filename: 'cap-table.xlsx',
            contentType: 'application/vnd.ms-excel',
            size: 6789,
          },
        ],
      }),
      teamId: tenantOfTeam(ROUND_TRIP_TEAM),
      catalog: manifestCatalog,
      credentialIds: { acme_main: 'cred-attio-1' },
      host,
      dryRun: true,
    });
    expect(writes.map((write) => write.fields)).toEqual([
      { title: 'Series A deck from jane@acme.example: deck.pdf' },
      { title: 'Series A deck from jane@acme.example: cap-table.xlsx' },
    ]);
    expect(result.trace.filter((entry) => entry.kind === 'warning')).toEqual([]);
    expect(reached).toEqual(
      new Set([
        'segment.open',
        'adapters.resolve',
        'adapters.call',
        'control.cancel.cancelled',
        'control.cancel.cancelledNow',
        'segment.close',
      ]),
    );
  });
});
