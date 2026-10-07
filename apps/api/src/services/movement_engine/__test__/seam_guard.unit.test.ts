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
import type { Adapter } from '../../translation_graph/adapter';
import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import { CURRENT_LANGUAGE_VERSION } from 'movement-lang';

import type { AwaitWakeRequest, EngineHost, RenderFile, ResolveFileText } from '../host';
import { makeFakeParkSink, makeTestHost } from '../test_host';
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
  'host_adapter.ts',
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
  'host_kit.ts',
  'join_pending.ts',
  'limit_pause.ts',
  'park_sink.ts',
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
  // Shared engine helpers that are pure computation over engine data:
  // resource stamping and filtering, the model choice for an extraction's
  // size.
  (m) => m === 'services/translation_graph/engine/files/resources',
  (m) => m === 'services/translation_graph/engine/batched_extraction/schema_synthesis',
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

  // The engine never holds a live adapter: it resolves an instance to data
  // and an opaque id, and calls it by method name with one JSON argument.
  it('adapter instances are resolved and called with plain data only', async () => {
    const teamId = '00000000-0000-0000-0000-000000000044' as TeamId;
    const calls: Array<{ call: string; method?: string; input: unknown; output: unknown }> = [];
    const manual = createManualAdapter({ teamId });
    const kg: Adapter = {
      adapterType: 'kg',
      supportedTriggers: ['webhook'],
      runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
      listEntryPoints: async () => [],
      describe: async () => null,
      resolveEntity: async () => ({ candidates: [] }),
      getFieldValue: async () => null,
      getRelated: async () => [],
      createRecord: async () => ({ adapterType: 'kg', externalId: 'note-1', data: {} }),
      updateRecord: async (input) => ({ adapterType: 'kg', externalId: input.externalId, data: {}, association: 'none' }),
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
      teamId,
      catalog: staticCatalogSnapshot({
        credentials: { kg_cred: { adapters: ['kg'] } },
        instanceSchemas: {
          kg: {
            positions: { note: { properties: { body: 'text' }, edges: {} } },
            collections: { note: { target: 'note' } },
            writableRoots: { note: { fields: { body: 'text' }, resultShape: { externalId: 'text' } } },
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
      runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
      listEntryPoints: async () => [],
      describe: async () => null,
      resolveEntity: async () => ({ candidates: [] }),
      getFieldValue: async () => null,
      getRelated: async () => [],
      createRecord: async () => ({ adapterType: 'kg', externalId: 'note-1', data: {} }),
      updateRecord: async (input) => ({ adapterType: 'kg', externalId: input.externalId, data: {}, association: 'none' }),
      deleteRecord: async () => ({}),
    };
    const parks = makeFakeParkSink();
    const appended: unknown[] = [];
    const inner = makeTestHost({
      adapters: { resolve: ({ adapterType }) => (adapterType === 'kg' ? kg : manual) },
      park: {
        sink: parks.sink,
        callbacks: { mint: async () => ({ id: 'cb_1', url: 'https://api.test/api/cb/cb_1' }), calls: async () => [] },
      },
      lookup: { resolveActingUser: async () => ({ id: 'user-1', email: 'amy@acme.dev', name: 'Amy' }) },
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
          commitTimerPark: (input) => record('park.sink.commitTimerPark', input, sink.commitTimerPark(input)),
        },
        callbacks: { ...callbacks, mint: (input) => record('park.callbacks.mint', input, callbacks.mint(input)) },
      },
      lookup: {
        resolveActingUser: (input) => record('lookup.resolveActingUser', input, inner.lookup.resolveActingUser(input)),
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
      teamId,
      firedAt: '2026-10-07T09:00:00.000Z',
      catalog: staticCatalogSnapshot({
        credentials: { kg_cred: { adapters: ['kg'] } },
        instanceSchemas: {
          kg: {
            positions: { note: { properties: { body: 'text' }, edges: {} } },
            collections: { note: { target: 'note' } },
            writableRoots: { note: { fields: { body: 'text' }, resultShape: { externalId: 'text' } } },
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
    expect(lookup?.input).toMatchObject({ teamId, segmentId: expect.any(String), instance: expect.any(String) });
    expect(calls.find((c) => c.call === 'park.callbacks.mint')?.input).toMatchObject({ expiresAt: expect.any(String) });
    expect(calls.find((c) => c.call === 'park.sink.commitTimerPark')?.input).toMatchObject({
      wakeAt: expect.any(String),
    });
    // What the host was handed of the trace is the run's whole trace.
    expect(appended).toEqual(result.trace);
    expect(JSON.parse(JSON.stringify(calls))).toEqual(calls);
  });
});
