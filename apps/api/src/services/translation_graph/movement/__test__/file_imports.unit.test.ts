// File imports end-to-end at the api layer (§G two-file fixture):
//
//   1. RESOLVER CLOSURE — `assembleMovementFileSources` walks the
//      transitive import graph through an injected loader (cycle-safe,
//      diamonds loaded once); `resolverOverSources` serves it to the
//      checker synchronously.
//   2. AUTHORING — `diagnoseMovementSource` with the resolver: the §G
//      consumer validates CLEAN (no MOV_IMPORT_*) — the save verdict,
//      predicted.
//   3. ENGINE PATH — the §G two-file fixture RUNS: the consumer
//      imports `files_to_dropbox` + `Files` from the library, the call
//      executes against the LIBRARY's own file scope (it constructs its
//      own dropbox), and one dropbox create lands per resource. Without
//      a resolver the same program raises MOVENG_UNSUPPORTED naming the
//      missing seam.
//   4. INTERPRETABILITY SCAN — with the resolver, imported library files
//      are scanned too: an unsupported construct inside the library
//      flags the importing file, suffixed with the library path.

// ── Jest module workarounds (mirrors movement_engine/__test__/calls) ────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../../knowledge_pipeline/output_v3/schemas');

process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_SALT_BASE64 ??= Buffer.alloc(16, 2).toString('base64');
process.env.DATABASE_URL_TEST ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.DATABASE_URL_TEST_READONLY ??=
  'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.SCRAPER_API_KEY ??= 'unit-test-unused';

function mockChainable(): object {
  const handler: ProxyHandler<object> = {
    get(_target: object, prop: string | symbol): unknown {
      if (prop === 'execute') return async () => [];
      if (prop === 'executeTakeFirst') return async () => null;
      if (prop === 'then') return undefined;
      return () => mockChainable();
    },
  };
  return new Proxy({}, handler);
}
jest.mock('../../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(() => mockChainable()),
  getAutomationsQb: jest.fn(() => mockChainable()),
  getQb: jest.fn(() => mockChainable()),
  getCoreQb: jest.fn(() => mockChainable()),
}));

jest.mock('../../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../context', () => ({
  unsafeCurrentContext: () => undefined,
  currentContext: () => ({
    user: undefined,
    runAsync: async <T>(fn: () => Promise<T>) => fn(),
  }),
}));

jest.mock('../../adapters/knowledge_graph', () => ({
  KG_ADAPTER_TYPE: 'kg',
  KG_MANIFEST: {
    adapterType: 'kg',
    displayName: 'Knowledge Graph',
    supportedTriggers: ['mutation'],
    methods: [
      'listEntryPoints', 'describe', 'resolveEntity', 'getDedupRules',
      'getFieldValue', 'getRelated', 'createRecord', 'updateRecord',
      'getPriorMatch', 'recordLink',
    ],
    triggerKinds: ['KG_MUTATION'],
  },
  createKnowledgeGraphAdapter: jest.fn(() => ({ adapterType: 'kg' })),
}));

jest.mock('../../../knowledge_pipeline/facts', () => ({
  extractFactsForResource: jest.fn(async () => []),
}));
jest.mock('../../../../lib/anthropic', () => ({
  anthropicChat: jest.fn(async () => '{}'),
  anthropicChatDetailed: jest.fn(async () => ({
    text: '{}',
    stopReason: 'end_turn',
    truncated: false,
  })),
  MAX_CHAT_CONTINUATIONS: 5,
}));

jest.mock('../../adapters/resolve', () => ({
  resolveAdapter: jest.fn(() => {
    throw new Error('test: resolveAdapter must not be called — tests inject a resolver');
  }),
}));

import { runMovement } from '../../../movement_engine/run';
import { MovementEngineError } from '../../../movement_engine/expression';
import { listUnsupportedConstructs } from '../../../movement_engine/interpretable';
import { staticCatalogFromManifests } from '../catalog';
import { diagnoseMovementSource } from '../authoring';
import { assembleMovementFileSources, resolverOverSources } from '../files';
import {
  RESOURCES_REFERENCE_FIELD_ID,
  type Adapter,
  type RuntimeCapabilities,
  type Resource,
} from '../../adapter';
import { containerAssociation } from '../../adapter';
import type { TriggerEvent } from '../../triggers/types';
import { makeUnstablePosition, positionData } from '../../types';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import { makeTestHost } from '../../../movement_engine/host';

const TEAM_ID = '00000000-0000-0000-0000-000000000021' as TeamId;

// ── Fake adapters (the calls-suite harness) ──────────────────────────────────

function permissiveCaps(): RuntimeCapabilities {
  return {
    traversal: { incoming: true, edgeProperties: true },
    resources: true,
  };
}

interface RecordedWrite {
  recordType: string;
  externalId?: string;
  fields: Record<string, unknown>;
}

function makeFakeAdapter(
  adapterType: string,
  opts: { resources?: Resource[] } = {},
): { adapter: Adapter; creates: RecordedWrite[] } {
  const creates: RecordedWrite[] = [];
  const adapter: Adapter = {
    adapterType,
    supportedTriggers: [] as never[],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated({ fieldId }) {
      if (fieldId === RESOURCES_REFERENCE_FIELD_ID && opts.resources) {
        return opts.resources.map((resource) => ({
          position: makeUnstablePosition({ adapterType, recordType: null, data: resource }),
        }));
      }
      return [];
    },
    async createRecord(input) {
      creates.push({ recordType: input.recordType, fields: input.fields });
      return {
        adapterType,
        externalId: `ext-${adapterType}-${creates.length}`,
        data: {},
      };
    },
    async updateRecord(input) {
      return { adapterType, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates };
}

function makeResolver(byType: Record<string, Adapter>) {
  return ({ adapterType }: { adapterType: string }) => {
    const adapter = byType[adapterType];
    if (!adapter) throw new Error(`test: no fake adapter for '${adapterType}'`);
    return adapter;
  };
}

function webhookEvent(adapterType: string, payload: Record<string, unknown>): TriggerEvent {
  return {
    pipelineInputId: 'pi-movement-file-imports',
    adapterType,
    triggerType: 'webhook',
    payload,
    // A real event names what fired — via an address, or this. Omitting it made
    // the seeded position TYPELESS, which every other engine fixture avoids and
    // which the engine now refuses outright: an untyped position is not a
    // weaker guarantee, it is none.
    rootRecordType: 'message',
  };
}

// ── Catalog / fixtures ───────────────────────────────────────────────────────

const catalog = staticCatalogFromManifests({
  credentials: {
    dealflow_inbox: { adapters: ['email'] },
    team_drive: { adapters: ['dropbox'] },
  },
});

const CREDENTIAL_IDS: Record<string, string> = {
  dealflow_inbox: 'cred-email-1',
  team_drive: 'cred-dropbox-1',
};

// The §G library file — saved as the movement row named "lib/file-routines".
const FILES_LIB = [
  'import { dropbox } from adapters',
  'import { team_drive } from credentials',
  '',
  'export node Files {',
  '  name: <text>',
  '  data: <text>',
  '}',
  '',
  'export movement files_to_dropbox(f: <Files>) {',
  '  drive = dropbox(credentials: team_drive)',
  '  write drive-[:file]-> {',
  '    name: f.`name`',
  '    data: f.`data`',
  '  }',
  '}',
].join('\n');

// The §G consumer — a separate file importing the library.
const CONSUMER = [
  'import { email } from adapters',
  'import { files_to_dropbox, Files } from "lib/file-routines"',
  '',
  'inbox = email()',
  '',
  'movement intake(msg: <inbox-[:message]->>) {',
  '  msg-[f:#resources]-> {',
  '    files_to_dropbox(f: node { name: f.`filename`, data: f.`data` })',
  '  }',
  '}',
  '',
  'listen to inbox { key: "intake" } fire intake',
].join('\n');

const FILES = new Map([['lib/file-routines', FILES_LIB]]);
const resolveFile = resolverOverSources(FILES);

// ── 1. Resolver closure ──────────────────────────────────────────────────────

describe('assembleMovementFileSources', () => {
  it('walks the import graph transitively through the injected loader', async () => {
    const sources = new Map([
      ['lib/a', 'import { B } from "lib/b"\nmovement a_m(x: <B>) {\n  y = x.`name`\n}'],
      ['lib/b', 'node B {\n  name: <text>\n}'],
    ]);
    const loaded: string[] = [];
    const result = await assembleMovementFileSources({
      rootSource: 'import { a_m } from "lib/a"',
      load: async (path) => {
        loaded.push(path);
        return sources.get(path) ?? null;
      },
    });
    expect([...result.keys()].sort()).toEqual(['lib/a', 'lib/b']);
    expect(loaded.sort()).toEqual(['lib/a', 'lib/b']);
  });

  it('is cycle-safe and skips unresolvable paths', async () => {
    const sources = new Map([
      ['lib/a', 'import { b } from "lib/b"\nimport { x } from "lib/missing"'],
      ['lib/b', 'import { a } from "lib/a"'],
    ]);
    const result = await assembleMovementFileSources({
      rootSource: 'import { a } from "lib/a"',
      load: async (path) => sources.get(path) ?? null,
    });
    expect([...result.keys()].sort()).toEqual(['lib/a', 'lib/b']);
  });
});

// ── 2. Authoring — the validation verdict predicts the save ─────────────────

describe('diagnoseMovementSource with resolved file imports', () => {
  it('the §G consumer validates clean — imports resolve, nothing engine-unsupported', () => {
    const validation = diagnoseMovementSource(CONSUMER, {
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveFile,
    });
    expect(validation.diagnostics.map((d) => d.code)).not.toEqual(
      expect.arrayContaining([expect.stringContaining('MOV_IMPORT')]),
    );
    expect(validation.ok).toBe(true);
    expect(validation.firedMovements).toEqual(['intake']);
  });

  it('an unsupported construct in an imported library fails the verdict, named', () => {
    const badLib = FILES_LIB.replace(
      "  write drive-[:file]-> {",
      "  movement nested(g: <Files>) {\n    h = g.`name`\n  }\n  write drive-[:file]-> {",
    );
    const validation = diagnoseMovementSource(CONSUMER, {
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveFile: resolverOverSources(new Map([['lib/file-routines', badLib]])),
    });
    expect(validation.ok).toBe(false);
    expect(validation.diagnostics.map((d) => d.code)).toContain('MOV_ENGINE_UNSUPPORTED');
    expect(validation.diagnostics.map((d) => d.message).join('\n')).toContain(
      'nested movement declarations',
    );
  });
});

// ── 3. Engine path — the §G two-file fixture RUNS ───────────────────────────

describe('runMovement with resolveFile (the §G two-file fixture)', () => {
  it('an imported movement executes against its own library file scope', async () => {
    const email = makeFakeAdapter('email', {
      resources: [
        {
          externalId: 'att-1',
          name: 'pitch.pdf',
          data: { filename: 'pitch.pdf', data: 'BYTES-1' },
        },
        {
          externalId: 'att-2',
          name: 'model.xlsx',
          data: { filename: 'model.xlsx', data: 'BYTES-2' },
        },
      ],
    });
    const dropbox = makeFakeAdapter('dropbox');

    const result = await runMovement({
      source: CONSUMER,
      movementName: 'intake',
      event: webhookEvent('email', { subject: 'Acme deck' }),
      teamId: TEAM_ID,
      catalog,
      host: makeTestHost({
        adapters: {
          credentialId: (name) => CREDENTIAL_IDS[name],
          resolve: makeResolver({ email: email.adapter, dropbox: dropbox.adapter }),
        },
        files: { resolveFile },
      }),
    });

    // One dropbox create per resource — the callee constructed ITS OWN
    // dropbox from the library's imports (team_drive), invisible to the
    // consumer file.
    expect(dropbox.creates).toEqual([
      { recordType: 'file', fields: { name: 'pitch.pdf', data: 'BYTES-1' } },
      { recordType: 'file', fields: { name: 'model.xlsx', data: 'BYTES-2' } },
    ]);
    expect(result.writes.map((w) => w.adapterType)).toEqual(['dropbox', 'dropbox']);
    // Provenance crossed the file boundary: the written fields trail back
    // to the consumer's resource reads.
    expect(result.writes[0].provenance['name']).toEqual([
      { kind: 'resource', externalId: 'att-1', name: 'pitch.pdf', field: 'filename' },
    ]);
  });

  it('an aliased import is callable under its local name', async () => {
    const email = makeFakeAdapter('email', {
      resources: [
        { externalId: 'att-1', name: 'a.pdf', data: { filename: 'a.pdf', data: 'B' } },
      ],
    });
    const dropbox = makeFakeAdapter('dropbox');
    await runMovement({
      source: CONSUMER.replace(
        'import { files_to_dropbox, Files } from "lib/file-routines"',
        'import { files_to_dropbox as send, Files } from "lib/file-routines"',
      ).replace('files_to_dropbox(f: node', 'send(f: node'),
      movementName: 'intake',
      event: webhookEvent('email', { subject: 'x' }),
      teamId: TEAM_ID,
      catalog,
      host: makeTestHost({
        adapters: {
          credentialId: (name) => CREDENTIAL_IDS[name],
          resolve: makeResolver({ email: email.adapter, dropbox: dropbox.adapter }),
        },
        files: { resolveFile },
      }),
    });
    expect(dropbox.creates).toHaveLength(1);
  });

  it("an imported callee's VALUE crosses the file boundary — what it returned", async () => {
    // A call has a value wherever the callee lives: the shaping movement is in
    // the library, and the consumer reads what it RETURNED. The type comes from
    // the library's own scope (`movementReturnType` caches on the library
    // symbol), so the consumer never has to spell the library's internals.
    const LIB = [
      'export movement shape_it(f: <Files>) {',
      '  return node { label: f.`name` }',
      '}',
    ].join('\n');
    const email = makeFakeAdapter('email', {
      resources: [{ externalId: 'att-1', name: 'a.pdf', data: { filename: 'a.pdf', data: 'B' } }],
    });
    const dropbox = makeFakeAdapter('dropbox');
    const consumer = [
      'import { email, dropbox } from adapters',
      'import { team_drive } from credentials',
      'import { shape_it, Files } from "lib/shaping"',
      '',
      'inbox = email()',
      '',
      'movement intake(msg: <inbox-[:message]->>) {',
      '  drive = dropbox(credentials: team_drive)',
      '  msg-[f:#resources]-> {',
      '    r = shape_it(f: node { name: f.`filename`, data: f.`data` })',
      '    write drive-[:file]-> {',
      '      name: r.label',
      '      data: f.`data`',
      '    }',
      '  }',
      '}',
      '',
      'listen to inbox { key: "intake" } fire intake',
    ].join('\n');

    await runMovement({
      source: consumer,
      movementName: 'intake',
      event: webhookEvent('email', { subject: 'x' }),
      teamId: TEAM_ID,
      catalog,
      host: makeTestHost({
        adapters: {
          credentialId: (name) => CREDENTIAL_IDS[name],
          resolve: makeResolver({ email: email.adapter, dropbox: dropbox.adapter }),
        },
        files: {
          resolveFile: resolverOverSources(
            new Map([['lib/shaping', `${FILES_LIB}\n\n${LIB}`]]),
          ),
        },
      }),
    });

    expect(dropbox.creates).toEqual([
      { recordType: 'file', fields: { name: 'a.pdf', data: 'B' } },
    ]);
  });

  it('without a resolver the run refuses cleanly, naming the seam', async () => {
    const email = makeFakeAdapter('email');
    await expect(
      runMovement({
        source: CONSUMER,
        movementName: 'intake',
        event: webhookEvent('email', { subject: 'x' }),
        teamId: TEAM_ID,
        catalog,
        host: makeTestHost({
          adapters: { resolve: makeResolver({ email: email.adapter }) },
        }),
      }),
    ).rejects.toThrow(MovementEngineError);
    await expect(
      runMovement({
        source: CONSUMER,
        movementName: 'intake',
        event: webhookEvent('email', { subject: 'x' }),
        teamId: TEAM_ID,
        catalog,
        host: makeTestHost({
          adapters: { resolve: makeResolver({ email: email.adapter }) },
        }),
      }),
    ).rejects.toThrow(/file import|resolver|MOV_IMPORT/i);
  });
});

// ── 4. The dry interpretability scan walks imported libraries ───────────────

describe('listUnsupportedConstructs with resolveFile', () => {
  it('the §G two-file fixture scans clean', () => {
    expect(listUnsupportedConstructs(CONSUMER, { resolveFile })).toEqual([]);
  });

  it('an unsupported construct INSIDE the library flags the importer, path-suffixed', () => {
    const badLib = [
      'node B {',
      '  name: <text>',
      '}',
      '',
      'movement b_m(x: <B>) {',
      '  movement nested(y: <B>) {',
      '    z = y.`name`',
      '  }',
      '}',
    ].join('\n');
    const flags = listUnsupportedConstructs('import { b_m } from "lib/bad"', {
      resolveFile: resolverOverSources(new Map([['lib/bad', badLib]])),
    });
    expect(flags).toEqual([
      'nested movement declarations inside a movement body (in "lib/bad")',
    ]);
  });

  it('without a resolver, file imports no longer flag (the engine runs them)', () => {
    expect(listUnsupportedConstructs(CONSUMER)).toEqual([]);
  });
});
