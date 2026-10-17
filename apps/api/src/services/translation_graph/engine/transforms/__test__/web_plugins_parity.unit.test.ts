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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { noCredential, pluginsInProcess, refusingFiles, refusingKv } from 'module-kit';
import { webModuleWith } from '@listen-fire/web';
import { recordingTools, type RecordedInvocation, type ToolCall } from '@listen-fire/web/__test__/replay_tools';
import { logger } from 'movement-engine/public/log';
import { hostedWebTools } from '../hosted_tools';

import { NO_BUDGET_LIMIT } from 'movement-engine/public/models';

import { PARITY_CASES, type ParityCase } from './parity/cases';
import { normalised, startCase, takeCalls, type StubCall } from './parity/stub_services';
import { BUILTIN_MODULES, builtinPluginModule } from '../../../adapters/builtin_modules';
import { registryTransformInvoker, transformInvokerFor } from '../../../movement/transform_invoker';
import type { TeamId } from '../../../../../generated/kysely/core/Team';

const FIXTURE = join(__dirname, '__fixtures__/web_plugins_parity.json');
const RECORD = process.env.WEB_PARITY_RECORD === '1';
// What each plugin asked of its tools on this platform, and the module's
// answer: the recording @lf/web's own tests replay in process and as a
// process (serve-module), where the platform's services do not exist.
const TOOLS_FIXTURE = join(__dirname, '../../../../../../../../modules/web/__test__/__fixtures__/web_tools_parity.json');

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
  registryTransformInvoker.invoke({ plugin: c.plugin, config: c.config, extractedContext: c.extractedContext, budget: NO_BUDGET_LIMIT });

if (process.env.WEB_TOOLS_RECORD === '1') {
  it('records what the plugins ask of their tools on this platform', async () => {
    const recorded: RecordedInvocation[] = [];
    for (const c of PARITY_CASES) {
      const tools: ToolCall[] = [];
      const module = pluginsInProcess(webModuleWith(() => recordingTools(hostedWebTools, tools)), {
        tenant: 'team-parity',
        credential: noCredential('the platform passes the web plugins no credential'),
        log: logger,
        files: refusingFiles('no files'),
        kv: refusingKv('no kv'),
        validateResults: true,
      });
      const { result: answer } = await play(c, () => module.invoke({ name: c.plugin, config: c.config, extractedContext: c.extractedContext }));
      recorded.push({
        name: c.name,
        plugin: c.plugin,
        config: c.config,
        extractedContext: c.extractedContext,
        ...(c.env !== undefined ? { env: c.env } : {}),
        tools,
        answer,
      });
    }
    mkdirSync(dirname(TOOLS_FIXTURE), { recursive: true });
    writeFileSync(TOOLS_FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`);
  });
}

if (RECORD) {
  it('records the legacy plugins', async () => {
    const recorded: Recorded[] = [];
    for (const c of PARITY_CASES) recorded.push(await play(c, legacy));
    writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`);
  });
} else {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Recorded[];
  const team = 'team-parity' as TeamId;
  const moduleLine: Invoke = (c) =>
    transformInvokerFor(team).invoke({ plugin: c.plugin, config: c.config, extractedContext: c.extractedContext, budget: NO_BUDGET_LIMIT });
  const subjects: Array<[string, Invoke]> = [
    ['the legacy line', legacy],
    ['the module line (@lf/web in process)', moduleLine],
  ];

  it('every bundled plugin is on the module line', () => {
    for (const c of PARITY_CASES) expect(builtinPluginModule(c.plugin, { teamId: team }, BUILTIN_MODULES)).toBeDefined();
  });

  describe.each(subjects)('%s', (_subject, invoke) => {
    it.each(PARITY_CASES.map((c) => [c.name, c] as const))('%s', async (name, c) => {
      const expected = fixture.find((r) => r.name === name);
      expect(expected).toBeDefined();
      expect(await play(c, invoke)).toEqual(expected);
    });
  });
}
