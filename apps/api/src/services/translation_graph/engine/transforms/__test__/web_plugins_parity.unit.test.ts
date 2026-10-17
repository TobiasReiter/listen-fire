// Recorded parity for the bundled plugins. The fixture was recorded from the
// legacy plugins (the transform registry) BEFORE they moved into `@lf/web`:
// for each case, every ask of the host (model calls, searches, scrapes,
// document fetches, storage writes) and the answer the run received. Each
// subject below replays the same scripted host and must ask the same things
// and answer the same.
//
// Re-record only deliberately: WEB_PARITY_RECORD=1, then read the diff.

jest.mock('../../../../../lib/anthropic', () => {
  const actual = jest.requireActual('movement-engine/lib/anthropic');
  return { ...actual, ...require('./parity/stub_services').anthropicModule };
});
jest.mock('../../../../web_search', () => require('./parity/stub_services').webSearchModule);
jest.mock('../../../../scraper', () => require('./parity/stub_services').scraperModule);
jest.mock('../../../../raw_text', () => require('./parity/stub_services').rawTextModule);
jest.mock('../../../../resource', () => require('./parity/stub_services').resourceModule);
jest.mock('../../../../document', () => require('./parity/stub_services').documentModule);
jest.mock('../../../../../lib/document_sources', () => require('./parity/stub_services').documentSourcesModule);
jest.mock('../../../../../lib/agent/tools/pitch_deck_url', () => require('./parity/stub_services').pitchDeckModule);
jest.mock('../../../../../lib/agent/tools/extract_document_text', () => require('./parity/stub_services').extractTextModule);
jest.mock('../../../../../adapters/registry', () => require('./parity/stub_services').registryModule);
jest.mock('../../../../../lib/llm_usage', () => ({ runFields: () => ({}), recordLlmUsage: () => undefined }));
jest.mock('movement-engine/services/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PARITY_CASES, type ParityCase } from './parity/cases';
import { normalised, startCase, takeCalls, type StubCall } from './parity/stub_services';
import { registryTransformInvoker } from '../../../movement/transform_invoker';

const FIXTURE = join(__dirname, '__fixtures__/web_plugins_parity.json');
const RECORD = process.env.WEB_PARITY_RECORD === '1';

interface Recorded {
  name: string;
  calls: StubCall[];
  result: unknown;
}

type Invoke = (c: ParityCase) => Promise<unknown>;

async function play(c: ParityCase, invoke: Invoke): Promise<Recorded> {
  const saved = { ...process.env };
  Object.assign(process.env, c.env ?? {});
  startCase(c);
  try {
    const result = normalised(await invoke(c));
    return { name: c.name, calls: takeCalls(), result };
  } finally {
    process.env = saved;
  }
}

const legacy: Invoke = (c) =>
  registryTransformInvoker.invoke({ plugin: c.plugin, config: c.config, extractedContext: c.extractedContext });

if (RECORD) {
  it('records the legacy plugins', async () => {
    const recorded: Recorded[] = [];
    for (const c of PARITY_CASES) recorded.push(await play(c, legacy));
    writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`);
  });
} else {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Recorded[];
  const subjects: Array<[string, Invoke]> = [['the legacy line', legacy]];

  describe.each(subjects)('%s', (_subject, invoke) => {
    it.each(PARITY_CASES.map((c) => [c.name, c] as const))('%s', async (name, c) => {
      const expected = fixture.find((r) => r.name === name);
      expect(expected).toBeDefined();
      expect(await play(c, invoke)).toEqual(expected);
    });
  });
}
