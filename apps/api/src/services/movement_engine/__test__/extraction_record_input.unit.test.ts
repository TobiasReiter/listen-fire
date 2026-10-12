// An extraction prompt renders a RECORD input as its fields — the record's
// readable field values, as a JSON object — never the engine's own object.
// Before, a record in `extract from [ … ]` reached the prompt as
// `JSON.stringify` of the binding: its kind, its write handle, the graph it
// was written to (the connection's schema and credential name). A map holding
// a record renders the record as its fields at that key. Text stays text.

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../knowledge_pipeline/output_v3/schemas');

process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_SALT_BASE64 ??= Buffer.alloc(16, 2).toString('base64');
process.env.DATABASE_URL_TEST ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.DATABASE_URL_TEST_READONLY ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.SCRAPER_API_KEY ??= 'unit-test-unused';

jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../context', () => ({
  unsafeCurrentContext: () => undefined,
  currentContext: () => ({ user: undefined, runAsync: async <T>(fn: () => Promise<T>) => fn() }),
}));

import type { ExtractExpression, Span } from 'movement-lang';
import { binding, type Binding } from '../expression';
import { buildExtractSpec, materializeExtract } from '../extraction';
import { NO_PROVENANCE } from '../provenance';
import type {
  LlmCallInput,
  LlmCallResult,
} from '../../translation_graph/engine/batched_extraction';
import type { WriteRecord } from '../expression';

const span: Span = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };

const extract: ExtractExpression = {
  from: [{ raw: 'input', span }],
  stages: [
    {
      fields: [{ name: 'name', description: { raw: JSON.stringify('the company named'), span }, span }],
      children: [],
      span,
    },
  ],
  span,
};

/** The prompt text the model is sent for one input value. */
async function promptFor(input: unknown): Promise<string> {
  return (await run(extract, input)).prompt;
}

/** One run of `shape` with `input` as its `from` (and any argument) value:
 *  the prompt, and the config each plugin was invoked with. */
async function run(shape: ExtractExpression, input: unknown): Promise<{ prompt: string; configs: unknown[] }> {
  const configs: unknown[] = [];
  const calls: LlmCallInput[] = [];
  const client = {
    async call(call: LlmCallInput): Promise<LlmCallResult> {
      calls.push(call);
      return { parsedJson: { 'x:extract_result#1': [{ name: { evidence: 'q', value: 'Acme' } }] } };
    },
  };
  await materializeExtract({
    extract: shape,
    spec: await buildExtractSpec(shape),
    runtime: {
      llm: client,
      transformInvoker: {
        async invoke({ config }) {
          configs.push(config);
          return { text: 'fetched' };
        },
      },
      evalSlot: async () => ({ value: input, provenance: NO_PROVENANCE }),
    },
  });
  expect(calls).toHaveLength(1);
  return { prompt: calls[0]!.userMessage, configs };
}

/** A record the run synthesised (`node { … }`): its fields in declaration order. */
const synthesised: Binding = binding({
  kind: 'nodePosition',
  fields: { name: 'Acme Inc.', domain: 'acme.example' },
  fieldOrder: ['name', 'domain'],
  fieldProvenance: {},
  edges: {},
});

/** A record the run wrote — a handle, whose graph names the connection. */
const written: Binding = binding({
  kind: 'handle',
  handle: {
    adapterType: 'attio',
    recordType: 'company',
    externalId: 'rec_9',
    created: true,
    committed: true,
    writtenValues: { name: 'Globex' },
    resultData: { externalId: 'rec_9' },
    provenance: {},
  } satisfies WriteRecord,
  targetType: 'company',
  graph: {
    kind: 'instance',
    instance: binding({ kind: 'instance', name: 'crm', adapterSlug: 'attio', credentialName: 'acme_main' }),
  },
});

const INTERNAL = /"(kind|handle|graph|provenance|fieldProvenance|fieldOrder|edges|credentialName|adapterSlug)"/;

describe('an extraction prompt renders a record as its fields', () => {
  it('a synthesised record: its fields as a JSON object, and nothing of the engine', async () => {
    const prompt = await promptFor(synthesised);
    expect(prompt).toContain('{"name":"Acme Inc.","domain":"acme.example"}');
    expect(prompt).not.toMatch(INTERNAL);
  });

  it('a written record: what it was written with and what the system handed back', async () => {
    const prompt = await promptFor(written);
    expect(prompt).toContain('{"name":"Globex","externalId":"rec_9"}');
    expect(prompt).not.toMatch(INTERNAL);
    expect(prompt).not.toContain('acme_main');
  });

  it('a map holding a record renders the record as its fields at its key', async () => {
    const prompt = await promptFor({ lead: synthesised, note: 'met at the fair' });
    expect(prompt).toContain('{"lead":{"name":"Acme Inc.","domain":"acme.example"},"note":"met at the fair"}');
    expect(prompt).not.toMatch(INTERNAL);
  });

  it('a list of records: each as its fields', async () => {
    const prompt = await promptFor([synthesised, written]);
    expect(prompt).toContain('{"name":"Acme Inc.","domain":"acme.example"}');
    expect(prompt).toContain('{"name":"Globex","externalId":"rec_9"}');
    expect(prompt).not.toMatch(INTERNAL);
  });

  it('text stays text', async () => {
    expect(await promptFor('Acme Inc. raised a seed round')).toContain('Acme Inc. raised a seed round');
  });
});

describe('a through stage hands a record argument its fields, as a plain call does', () => {
  const staged: ExtractExpression = {
    ...extract,
    stages: [
      {
        ...extract.stages[0]!,
        through: [{ plugin: 'relay', args: [{ name: 'data', value: { raw: 'input', span } }], span }],
      },
    ],
  };

  it('the record\'s fields, never the engine\'s object', async () => {
    const { configs } = await run(staged, synthesised);
    expect(configs).toEqual([{ data: { name: 'Acme Inc.', domain: 'acme.example' } }]);
  });
});
