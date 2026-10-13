// The `extract … from … through` keyword's prompts, held byte for byte.
//
// The extraction CALL (`extract(content, Shape)`) is a second engine path, and
// the ruling is that building it changes nothing the keyword sends. This file
// is that ruling as a test: every LLM call a handful of keyword movements make
// — system prompt, user message, label, model, effort, ceiling — compared with
// the copy recorded before the call existed (`__fixtures__/`).
//
// Regenerate only when a change to the KEYWORD's prompt is the point:
// `UPDATE_EXTRACT_KEYWORD_FIXTURE=1` and the scoped test command.

// ── Jest module workarounds (mirrors declared_shape_reuse.unit.test.ts) ─────

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

jest.mock('../../translation_graph/adapters/resolve', () => ({
  resolveAdapter: jest.fn(() => {
    throw new Error('test: resolveAdapter must not be called — tests inject a resolver');
  }),
}));

import * as fs from 'node:fs';
import * as path from 'node:path';

import { mockCatalog, type InstanceSchema } from 'movement-lang';
import { runMovement } from '../run';
import type {
  LlmCallInput,
  LlmCallResult,
} from '../../translation_graph/engine/batched_extraction';
import type { FileTextResolution } from '../extraction';
import type { Adapter, FileRef } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { positionData } from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000052' as TeamId;
const FIXTURE = path.join(__dirname, '__fixtures__', 'extract_keyword_prompts.json');

function emailAdapter(): Adapter {
  return {
    adapterType: 'email',
    supportedTriggers: [] as never[],
    runtimeCapabilities: () => ({ traversal: { incoming: true, edgeProperties: true }, resources: true }),
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
    async getRelated() {
      return [];
    },
    async createRecord() {
      throw new Error('test: no writes');
    },
    async updateRecord() {
      throw new Error('test: no writes');
    },
    async deleteRecord() {
      return {};
    },
  };
}

const emailSchema: InstanceSchema = {
  positions: {
    message: { properties: { subject: 'text', text: 'text', deck: 'file' }, edges: {} },
  },
  collections: {},
  writableRoots: {},
};

const catalog = mockCatalog({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
  },
  credentials: { dealflow_inbox: { adapters: ['email'] } },
});

const PRELUDE = [
  'import { email } from adapters',
  'import { dealflow_inbox } from credentials',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  'type Thesis = <"Consumer" | "Infra">',
  'rules = "route infra to Infra"',
  'node Entry: "each company pitched in this message" {',
  '  name: <text> "the company\'s name"',
  '  raised: <number> "the round size in dollars"',
  '  thesis: <Thesis> "the thesis it routes to. ${rules}"',
  '  site: <text | null> "the website"',
  '  node founder: "each founder named" { first: <text> "given names" }',
  '}',
].join('\n');

/** Each keyword movement the fixture holds, by name. */
const MOVEMENTS: Record<string, string[]> = {
  declared_shape: [
    '  found = extract from [msg.`text`] {',
    '    node entry: <Entry>',
    '  }',
  ],
  inline_tree_with_tier: [
    '  found = extract "careful" from [msg.`subject`, msg.`text`] {',
    '    summary: "one line on the message"',
    '    node company: "each company named" {',
    '      name: "its name"',
    '      employees: <number> "headcount"',
    '      node person: "each person at it" { role: <text | null> "their role" }',
    '    }',
    '  }',
  ],
  file_source: [
    '  found = extract "thorough" from [msg.`text`, msg.`deck`] {',
    '    node entry: <Entry> "each company in the deck"',
    '  }',
  ],
};

const DECK: FileRef = {
  __brand: 'FileRef',
  name: 'deck.pdf',
  contentType: 'application/pdf',
  size: 1234,
  source: { ownerAdapterType: 'email', handle: 'attachment-1' },
};

function event(): TriggerEvent {
  return {
    pipelineInputId: 'pi-extract-keyword',
    adapterType: 'email',
    triggerType: 'webhook',
    payload: {
      subject: 'Deals this week',
      text: 'Acme (Ada) is raising $5M for infra tooling; see acme.dev.',
      deck: DECK,
    },
  };
}

async function promptsOf(lines: string[]): Promise<LlmCallInput[]> {
  const calls: LlmCallInput[] = [];
  const llm = {
    async call(input: LlmCallInput): Promise<LlmCallResult> {
      calls.push(input);
      const key = /`(x:[^`]+)`/.exec(input.system)?.[1] ?? 'missing';
      return { parsedJson: { [key]: [] } };
    },
  };
  await runMovement({
    source: [PRELUDE, 'movement m(msg: <inbox-[:message]->>) {', ...lines, '}'].join('\n'),
    event: event(),
    teamId: TEAM_ID,
    catalog,
    resolveAdapter: () => emailAdapter(),
    llm,
    resolveFileText: async (): Promise<FileTextResolution> => ({
      text: 'ACME DECK\nWe build infra tooling. Raising $5M.',
      rawTextId: 'rt-1',
    }),
    dryRun: true,
  });
  return calls;
}

describe('the extract keyword sends exactly what it sent before the extraction call existed', () => {
  it('matches the recorded prompts, byte for byte', async () => {
    const recorded: Record<string, LlmCallInput[]> = {};
    for (const [name, lines] of Object.entries(MOVEMENTS)) recorded[name] = await promptsOf(lines);
    for (const calls of Object.values(recorded)) expect(calls.length).toBeGreaterThan(0);
    if (process.env.UPDATE_EXTRACT_KEYWORD_FIXTURE === '1') {
      fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`);
    }
    const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as unknown;
    expect(JSON.parse(JSON.stringify(recorded))).toEqual(expected);
  });
});
