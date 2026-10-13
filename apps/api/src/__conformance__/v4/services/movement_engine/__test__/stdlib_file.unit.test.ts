// FILE() artifacts + the namespaced stdlib, end-to-end through
// `runMovement`:
//
//   1. The digest idiom feeding FILE(): a block accumulates per-file
//      lines, JOIN over the meta-node edge composes the digest string,
//      and `FILE(digest, "pdf")` renders it through the file_render
//      seam (Playwright mocked at the page boundary — the seam's real
//      code runs). The dry-run sink captures the artifact ref: a
//      branded `FileRef` with a self-contained `data:` URL, the same
//      File-value currency file-typed adapter fields consume.
//   2. `FILE(…, "text")` runs the seam UNmocked — the decoded dataUrl
//      round-trips the composed string exactly.
//   3. Namespaced stdlib fields (CURRENCY.* / DATE.* / TEXT.*) compute
//      deterministically — no LLM anywhere in the run.
//   4. Provenance: the FileRef field carries the content's trail (the
//      event read and the block's per-file reads), transformed.
//   5. An unknown family member fails the save-time check, naming the
//      family's actual functions.

// ── Jest module workarounds (mirrors run.unit.test.ts) ──────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../knowledge_pipeline/output_v3/schemas');

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
jest.mock('../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(() => mockChainable()),
  getAutomationsQb: jest.fn(() => mockChainable()),
  getQb: jest.fn(() => mockChainable()),
  getCoreQb: jest.fn(() => mockChainable()),
}));

jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../context', () => ({
  unsafeCurrentContext: () => undefined,
  currentContext: () => ({
    user: undefined,
    runAsync: async <T>(fn: () => Promise<T>) => fn(),
  }),
}));

jest.mock('../../translation_graph/adapters/knowledge_graph', () => ({
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

jest.mock('../../knowledge_pipeline/facts', () => ({
  extractFactsForResource: jest.fn(async () => []),
}));
jest.mock('../../../lib/anthropic', () => ({
  anthropicChat: jest.fn(async () => '{}'),
  anthropicChatDetailed: jest.fn(async () => ({
    text: '{}',
    stopReason: 'end_turn',
    truncated: false,
  })),
  MAX_CHAT_CONTINUATIONS: 5,
}));
jest.mock('../../translation_graph/adapters/acting_user/resolve', () => ({
  resolveActingUser: jest.fn(async () => null),
}));
jest.mock('../../translation_graph/adapters/resolve', () => ({
  resolveAdapter: jest.fn(() => {
    throw new Error('test: resolveAdapter must not be called — tests inject a resolver');
  }),
}));

// The PDF boundary: file_render's REAL code runs (escaping, page
// driving, FileRef minting); only Chromium is stubbed. `page.pdf`
// returns bytes derived from the html `setContent` received, so the
// assertion can see the composed digest INSIDE the artifact bytes.
jest.mock('../../playwright', () => ({
  PlaywrightService: {
    withPage: async <T>(fn: (page: unknown) => Promise<T>): Promise<T> => {
      let html = '';
      const page = {
        setContent: async (content: string) => {
          html = content;
        },
        pdf: async () => Buffer.from(`PDF(${html})`),
      };
      return fn(page);
    },
  },
}));

import { runMovement } from '../run';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import type { CapturedWrite } from '../../translation_graph/engine/dry_run_adapter';
import type {
  Adapter,
  ExternalRecordRef,
  FileRef,
  RuntimeCapabilities,
} from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { makeStablePosition, positionData } from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';
import { Readable } from 'node:stream';
import { services } from '../../../adapters/registry';

const TEAM_ID = '00000000-0000-0000-0000-000000000010' as TeamId;

// FILE() now persists its bytes to the document store on creation (the artifact
// becomes a durable, source-backed FileRef — async user interaction §4.1), so
// the run needs a document store. An in-memory one keeps the test hermetic; the
// FileRef's retrieve() reads back through it, exactly as production does.
const docStore = new Map<string, { bytes: Buffer; contentType?: string }>();
beforeAll(() => {
  let n = 0;
  services.document = {
    async upload(readable: Readable, { mimeType }: { mimeType?: string }) {
      const chunks: Buffer[] = [];
      for await (const c of readable) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const objectUri = `mem://${n++}`;
      docStore.set(objectUri, { bytes: Buffer.concat(chunks), contentType: mimeType });
      return { objectUri, checksum: 'x' };
    },
    async getFileNodeStream({ objectUri }: { objectUri: string }) {
      const entry = docStore.get(objectUri);
      if (!entry) throw new Error(`no such doc ${objectUri}`);
      const stream = Readable.from(entry.bytes) as Readable & { size: number; contentType?: string };
      stream.size = entry.bytes.byteLength;
      stream.contentType = entry.contentType;
      return stream;
    },
  } as unknown as typeof services.document;
});

// ── Fakes (the run.unit.test.ts pattern) ─────────────────────────────────────

function permissiveCaps(): RuntimeCapabilities {
  return {
    traversal: { incoming: true, edgeProperties: true },
    resources: true,
  };
}

function makeFakeAdapter(
  adapterType: string,
  opts: {
    resolveCandidates?: (record: Record<string, unknown>) => ExternalRecordRef[];
  } = {},
): { adapter: Adapter; creates: Array<{ recordType: string; fields: Record<string, unknown> }> } {
  const creates: Array<{ recordType: string; fields: Record<string, unknown> }> = [];
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
    async resolveEntity({ record }) {
      return { candidates: opts.resolveCandidates?.(record) ?? [] };
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated() {
      return [];
    },
    async createRecord(input) {
      creates.push({ recordType: input.recordType, fields: input.fields });
      return { adapterType, externalId: `ext-${adapterType}-${creates.length}`, data: {} };
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

/** A slack source whose `files` edge yields one position per entry of
 *  the payload's `files` array (the §7 run.unit.test.ts fake). */
function slackWithFiles(): Adapter {
  const base = makeFakeAdapter('slack');
  base.adapter.getRelated = async ({ position, fieldId }) => {
    if (fieldId !== 'files') return [];
    const data = positionData(position) as { files?: Array<Record<string, unknown>> } | undefined;
    return (data?.files ?? []).map((file, i) => ({
      position: makeStablePosition({
        adapterType: 'slack',
        recordType: 'file',
        recordId: `file-${i + 1}`,
        data: file,
      }),
    }));
  };
  return base.adapter;
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
    pipelineInputId: 'pi-stdlib-file',
    adapterType,
    triggerType: 'webhook',
    payload,
  };
}

// ── Catalog / fixture ────────────────────────────────────────────────────────

const catalog = staticCatalogFromManifests({
  credentials: {
    dev_slack: { adapters: ['slack'] },
    acme_drive: { adapters: ['affinity'] }, // no thin schema → untyped target (checker silent)
  },
});

const CREDENTIAL_IDS: Record<string, string> = {
  dev_slack: 'cred-slack-1',
  acme_drive: 'cred-affinity-1',
};

const PRELUDE = [
  'import { slack, affinity } from adapters',
  'import { dev_slack, acme_drive } from credentials',
  '',
  'inbox = slack(credentials: dev_slack)',
  'drive = affinity(credentials: acme_drive)',
].join('\n');

function digestMovement(artifactType: 'pdf' | 'text'): string {
  return [
    PRELUDE,
    '',
    'movement weekly_report(msg: <inbox-[:message]->>) {',
    '  items = msg-[f:files]-> {',
    '    return "- ${f.`name`}"',
    '  }',
    '  digest = "Files from ${msg.`user`}: ${JOIN(items, ", ")}"',
    '  write drive-[:report]-> {',
    '    slug:   TEXT.SLUG(msg.`user`)',
    '    amount: CURRENCY.GET_NUMBER_FROM_FIGURE(msg.`text`)',
    '    code:   CURRENCY.GET_CODE_FROM_FIGURE(msg.`text`)',
    '    due:    DATE.ADD_DAYS("2026-03-12", 7)',
    `    report: FILE(digest, "${artifactType}")`,
    '  }',
    '}',
  ].join('\n');
}

const EVENT = webhookEvent('slack', {
  user: 'Ops Team',
  text: 'raised £1.2m this round',
  files: [{ name: 'deck.pdf' }, { name: 'notes.txt' }],
});

const EXPECTED_DIGEST = 'Files from Ops Team: - deck.pdf, - notes.txt';

async function runDigest(artifactType: 'pdf' | 'text') {
  const captured: CapturedWrite[] = [];
  const result = await runMovement({
    source: digestMovement(artifactType),
    event: EVENT,
    teamId: TEAM_ID,
    catalog,
    resolveCredentialId: (name) => CREDENTIAL_IDS[name],
    resolveAdapter: makeResolver({
      slack: slackWithFiles(),
      affinity: makeFakeAdapter('affinity').adapter,
    }),
    dryRun: true,
    writeSink: (w) => captured.push(w),
  });
  return { captured, result };
}

async function refBytes(ref: FileRef): Promise<Buffer> {
  expect(typeof ref.retrieve).toBe('function');
  const { stream } = await ref.retrieve!();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// ── 1 + 3. The pdf artifact and the stdlib fields, dry-run captured ──────────

describe('FILE(digest, "pdf") + namespaced stdlib fields through runMovement', () => {
  it('captures the artifact ref and the deterministic stdlib values', async () => {
    const { captured } = await runDigest('pdf');

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      kind: 'create',
      adapterType: 'affinity',
      recordType: 'report',
      fields: {
        slug: 'ops-team',
        amount: 1_200_000,
        code: 'GBP',
        due: '2026-03-19',
      },
    });

    const ref = captured[0].fields?.report as FileRef;
    expect(ref).toMatchObject({
      __brand: 'FileRef',
      name: 'movement-artifact.pdf',
      contentType: 'application/pdf',
    });
    expect(typeof ref.retrieve).toBe('function');
    expect(ref.size).toBeGreaterThan(0);

    // The rendered bytes (the seam's real path; Chromium stubbed at the
    // page boundary) carry the composed digest, escaped into the html.
    const bytes = (await refBytes(ref)).toString('utf8');
    expect(bytes).toMatch(/^PDF\(/);
    expect(bytes).toContain(EXPECTED_DIGEST);
  });

  // ── 4. Provenance: the FileRef carries the content's trail ──
  it("the artifact field's trail unions the digest's reads (transformed — no quote claim)", async () => {
    const { result } = await runDigest('pdf');
    expect(result.writes).toHaveLength(1);
    const trail = result.writes[0].provenance.report;
    expect(trail).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'source_field',
          instance: 'inbox',
          adapterType: 'slack',
          field: 'user',
        }),
        expect.objectContaining({
          kind: 'source_field',
          recordType: 'file',
          externalId: 'file-1',
          field: 'name',
        }),
      ]),
    );
    // Stdlib transforms keep the taint union too.
    expect(result.writes[0].provenance.amount).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'source_field', field: 'text' }),
      ]),
    );
  });
});

// ── 2. The text artifact round-trips the composed string exactly ─────────────

describe('FILE(digest, "text") — the unmocked seam', () => {
  it('streams text/plain bytes that are the digest verbatim', async () => {
    const { captured } = await runDigest('text');
    const ref = captured[0].fields?.report as FileRef;
    expect(ref).toMatchObject({
      __brand: 'FileRef',
      name: 'movement-artifact.txt',
      contentType: 'text/plain',
      size: Buffer.byteLength(EXPECTED_DIGEST, 'utf8'),
    });
    expect((await refBytes(ref)).toString('utf8')).toBe(EXPECTED_DIGEST);
  });
});

// ── 5. Unknown family member fails the save-time check, precisely ────────────

describe('unknown stdlib members fail checking with the family inventory', () => {
  it('CURRENCY.PARSE(…) is refused naming GET_NUMBER_FROM_FIGURE / GET_CODE_FROM_FIGURE', async () => {
    const source = [
      PRELUDE,
      '',
      'movement m(msg: <inbox-[:message]->>) {',
      '  write drive-[:report]-> {',
      '    amount: CURRENCY.PARSE(msg.`text`)',
      '  }',
      '}',
    ].join('\n');
    await expect(
      runMovement({
        source,
        event: EVENT,
        teamId: TEAM_ID,
        catalog,
        resolveCredentialId: (name) => CREDENTIAL_IDS[name],
        resolveAdapter: makeResolver({
          slack: slackWithFiles(),
          affinity: makeFakeAdapter('affinity').adapter,
        }),
        dryRun: true,
      }),
    ).rejects.toThrow(
      /MOVENG_CHECK[\s\S]*CURRENCY has no function PARSE\(\)[\s\S]*GET_NUMBER_FROM_FIGURE/,
    );
  });
});

// ── 6. DATE.TODAY / DATETIME.AT — the pinned clock and the anchored window ───
//
// The idiom the handbook teaches, run end to end: take the day in a place,
// move whole DAYS on it, and anchor each end of the window separately. The
// firing instant is pinned, so the day it computes is the day the run fired in
// Berlin — not the UTC day, which is a different one at 00:30 there.

describe('DATE.TODAY / DATETIME.AT through runMovement', () => {
  const WINDOW = [
    PRELUDE,
    '',
    'movement window(msg: <inbox-[:message]->>) {',
    '  today = DATE.TODAY("Europe/Berlin")',
    '  write drive-[:report]-> {',
    '    day:   today',
    '    ends:   DATETIME.AT(today, "07:00", "Europe/Berlin")',
    '    starts: DATETIME.AT(DATE.ADD_DAYS(today, -1), "07:00", "Europe/Berlin")',
    '  }',
    '}',
  ].join('\n');

  async function runWindow(firedAt: Date): Promise<Record<string, unknown>> {
    const affinity = makeFakeAdapter('affinity');
    await runMovement({
      source: WINDOW,
      event: EVENT,
      teamId: TEAM_ID,
      catalog,
      firedAt,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ slack: slackWithFiles(), affinity: affinity.adapter }),
    });
    return affinity.creates[0].fields;
  }

  it('the day is the day in Berlin, and the window is 24h on an ordinary day', async () => {
    // 23:30Z on the 11th is already the 12th in Berlin.
    const fields = await runWindow(new Date('2026-03-11T23:30:00.000Z'));
    expect(fields.day).toBe('2026-03-12');
    expect(fields.starts).toBe('2026-03-11T06:00:00.000Z');
    expect(fields.ends).toBe('2026-03-12T06:00:00.000Z');
  });

  it('the same window is 23 hours across the spring-forward day, unasked', async () => {
    const fields = await runWindow(new Date('2026-03-29T12:00:00.000Z'));
    expect(fields.day).toBe('2026-03-29');
    expect(fields.starts).toBe('2026-03-28T06:00:00.000Z');
    expect(fields.ends).toBe('2026-03-29T05:00:00.000Z');
    const hours =
      (Date.parse(String(fields.ends)) - Date.parse(String(fields.starts))) / 3_600_000;
    expect(hours).toBe(23);
  });

  it('and 25 hours across the fall-back day', async () => {
    const fields = await runWindow(new Date('2026-10-25T12:00:00.000Z'));
    const hours =
      (Date.parse(String(fields.ends)) - Date.parse(String(fields.starts))) / 3_600_000;
    expect(hours).toBe(25);
  });
});
