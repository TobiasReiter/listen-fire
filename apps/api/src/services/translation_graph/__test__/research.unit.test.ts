// research — one plugin, two engines, one contract.
//
// Every external edge is mocked (the search index, the page fetch, the model's
// structured replies, and Anthropic's client for the server-tool turn), so
// what is under test is what the plugin itself decides: what it refuses to
// spend anything on, which route an entry takes from what it carries, and
// what each outcome means.
//
// The two engines are held to the SAME assertions wherever the contract is
// what is being tested — that is the whole point of a contract they share.
//
// No real person's address or name appears here. The company names are the
// ones a real run left unenriched; the contexts are plausible reconstructions.
//
// Contract: plans/research-plugin-2026-09-10/1_contract.md

// ── External dependency mocks (hoisted above the imports) ─────────────────

const mockStructured = jest.fn();
const mockSearch = jest.fn();
const mockFetchWithTimeout = jest.fn();
const mockIsSupportedUrl = jest.fn((_url: string) => false);
const mockLogInfo = jest.fn();

// The client double: one `finalMessage()` per queued server-tool reply. The
// wrapper itself is REAL, so the agentic engine is tested over the block
// shapes Anthropic actually returns rather than over a convenient summary of
// them.
const finalMessage = jest.fn();
// The second argument is the SDK's request options, which is where the abort
// signal travels — so a case can assert the wall clock CANCELLED the request
// rather than walked away from it.
const stream = jest.fn(
  (_params: Record<string, unknown>, _options?: { signal?: AbortSignal }) => ({ finalMessage }),
);
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { stream } })),
}));
// The same double on Vertex, where the engine reads pages with our
// own fetcher instead of Anthropic's.
jest.mock('@anthropic-ai/vertex-sdk', () => ({
  __esModule: true,
  AnthropicVertex: jest.fn().mockImplementation(() => ({ messages: { stream } })),
}));

// The page fetcher behind the client-side page reader. The real one reaches
// Bright Data; all the engine wants back is the page's text — or the news that
// it has none.
const mockGetWebsite = jest.fn(async (_url: string, _options: unknown) => 'Canteen ordering.');
const mockMissingBrightData = jest.fn((): string[] => []);
jest.mock('../../scraper', () => ({
  ScraperService: { getWebsite: (...args: unknown[]) => mockGetWebsite(...(args as [string, unknown])) },
  missingBrightDataVars: () => mockMissingBrightData(),
  looksLikeSpaShell: () => false,
}));

jest.mock('../../../lib/llm_usage', () => ({
  recordLlmUsage: jest.fn().mockResolvedValue(undefined),
  runFields: jest.fn().mockReturnValue({}),
}));

// Only the forced-tool calls are stood in for — the planner, the confirmation,
// the synthesis and the shaping. Everything else in the wrapper is the real
// thing.
jest.mock('../../../lib/anthropic', () => ({
  ...jest.requireActual('../../../lib/anthropic'),
  anthropicChatStructured: (...args: unknown[]) => mockStructured(...args),
}));

jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: (...args: unknown[]) => mockLogInfo(...args), warn: jest.fn() },
}));
jest.mock('../../web_search', () => ({
  WebSearchService: { search: (...args: unknown[]) => mockSearch(...args) },
}));
// The document store reaches Playwright, the crawler and the prompt library;
// all the engine asks it is whether an address is a document.
jest.mock('../../../lib/document_sources', () => ({
  DocumentSourceService: { isSupportedUrl: (url: string) => mockIsSupportedUrl(url) },
}));
// The shared fetch plumbing reaches the scraper, the document store and the
// database; the engine only wants the page back. `normaliseUrl` is pure and
// kept as it is — the plugin reads addresses through it.
jest.mock('../engine/transforms/fetch_resource', () => ({
  ...jest.requireActual('../engine/transforms/fetch_resource'),
  fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args),
}));
// The profile service is an adapter, reached only when the index came back
// with nothing to check a result against. The double is the registry itself,
// so a case that wants the service puts one there and every other case runs
// with none.
jest.mock('../../../adapters/registry', () => ({ services: {} }));

// ── Module imports (after mocks) ──────────────────────────────────────────

import type { ResearchEngineName } from '../engine/transforms/research';
import type { ContextDependentInput } from '../engine/transforms';
import type { SourcePosition } from '../types';

import { services } from '../../../adapters/registry';
import {
  configuredEngine,
  configuredWallClockMs,
  research,
  usageWasNotMeasured,
  researchImpl,
  RESEARCH_PLUGIN_MANIFEST,
} from '../engine/transforms/research';
import { makeStablePosition } from '../types';

// ── Fixtures ──────────────────────────────────────────────────────────────

const sourceNode: SourcePosition = makeStablePosition({
  adapterType: 'fixture',
  recordType: 'fixture.message',
  recordId: 'msg-1',
  data: {},
});

const ENGINES: ResearchEngineName[] = ['constrained', 'agentic'];

function invoke(config: Record<string, unknown>) {
  const input: ContextDependentInput = {
    kind: 'context-dependent',
    sourceNode,
    config,
    extractedContext: {},
  };
  return researchImpl.run(input);
}

function hit(link: string, title: string, snippet = '') {
  return { link, title, snippet };
}

function searchReply(...items: Array<{ link: string; title: string; snippet: string }>) {
  return { items };
}

/** The constrained engine's three forced-tool calls, answered by tool name so
 *  a case says only what it cares about. */
function structuredBy(answers: {
  plan?: unknown;
  confirm?: unknown;
  synthesis?: unknown;
  shape?: unknown;
}) {
  mockStructured.mockImplementation(async (options: { toolName: string }) => {
    switch (options.toolName) {
      case 'plan_searches':
        return answers.plan ?? { queries: [], anchors: [] };
      case 'confirm_website':
        return answers.confirm ?? { choice: null, confidence: 'low' };
      case 'report_research':
        return (
          answers.synthesis ?? {
            found: true,
            answers_everything: true,
            confidence: 'high',
            summary: 'It sells canteen software. [1]',
            dossier: 'https://larkfield.example\n"Canteen ordering for schools."',
            sources: ['https://larkfield.example'],
          }
        );
      case 'file_research':
        return (
          answers.shape ?? {
            found: true,
            answers_everything: true,
            confidence: 'high',
            summary: 'It sells canteen software. [1]',
            dossier: 'https://larkfield.example\n"Canteen ordering for schools."',
            sources: ['https://larkfield.example'],
            website: 'https://larkfield.example',
            linkedin: 'none',
          }
        );
      default:
        throw new Error(`unexpected tool ${options.toolName}`);
    }
  });
}

/** One server-tool turn, as the wire returns it. */
function webReply(options: {
  text: string;
  blocks?: unknown[];
  stopReason?: string;
  searches?: number;
  fetches?: number;
}) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    stop_reason: options.stopReason ?? 'end_turn',
    stop_sequence: null,
    content: [...(options.blocks ?? []), { type: 'text', text: options.text }],
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: {
        web_search_requests: options.searches ?? 0,
        web_fetch_requests: options.fetches ?? 0,
      },
    },
  };
}

const SEARCHED = [
  { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: '"Larkfield" canteen' } },
  {
    type: 'web_search_tool_result',
    tool_use_id: 's1',
    content: [
      {
        type: 'web_search_result',
        url: 'https://larkfield.example',
        title: 'Larkfield',
        page_age: null,
        encrypted_content: 'x',
      },
    ],
  },
];

const FETCHED = [
  { type: 'server_tool_use', id: 'f1', name: 'web_fetch', input: { url: 'https://larkfield.example' } },
  {
    type: 'web_fetch_tool_result',
    tool_use_id: 'f1',
    content: {
      type: 'web_fetch_result',
      url: 'https://larkfield.example',
      retrieved_at: '2026-09-10T00:00:00Z',
      content: {
        type: 'document',
        title: 'Larkfield',
        citations: null,
        source: { type: 'text', media_type: 'text/plain', data: 'Canteen ordering for schools.' },
      },
    },
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  // `clearAllMocks` empties the CALL log and leaves the queued one-shot
  // replies where they are, so a turn a case queued and never spent is served
  // to the next case that asks — which reads as "the model answered" in a
  // case whose whole point is that it did not.
  finalMessage.mockReset();
  mockIsSupportedUrl.mockReturnValue(false);
  mockSearch.mockResolvedValue(searchReply());
  mockFetchWithTimeout.mockResolvedValue(null);
  structuredBy({});
  services.linkedin = undefined;
  delete process.env.RESEARCH_ENGINE;
  delete process.env.RESEARCH_WALL_CLOCK_MS;
  delete process.env.RESEARCH_AGENTIC_EFFORT;
  delete process.env.RESEARCH_AGENTIC_SEARCHES;
  delete process.env.RESEARCH_AGENTIC_FETCHES;
  mockGetWebsite.mockResolvedValue('Canteen ordering.');
  mockMissingBrightData.mockReturnValue([]);
});

// ── The gate, before either engine ────────────────────────────────────────

describe('the gate that costs nothing', () => {
  it.each(ENGINES)('refuses a bare name outright (%s)', async (engine) => {
    const result = await research({ name: 'Marlow' }, { engine });

    expect(result).toEqual({
      outcome: 'no_anchor',
      usage: expect.objectContaining({ searches: 0, fetches: 0, modelCalls: 0 }),
    });
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockStructured).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it.each(ENGINES)('refuses a context with nothing distinctive in it (%s)', async (engine) => {
    const result = await research({ name: 'Marlow', context: 'a new company' }, { engine });

    expect(result.outcome).toBe('no_anchor');
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it.each(ENGINES)('refuses a placeholder where a name should be (%s)', async (engine) => {
    const result = await research(
      { name: 'Stealth Startup', context: 'building something in Copenhagen' },
      { engine },
    );

    expect(result.outcome).toBe('no_anchor');
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it.each(ENGINES)('does NOT refuse a bare name that arrived with a link (%s)', async (engine) => {
    finalMessage.mockResolvedValue(webReply({ text: 'nothing found' }));
    mockStructured.mockImplementation(async () => ({
      found: false,
      answers_everything: false,
      confidence: 'low',
      summary: '',
      dossier: '',
      sources: [],
      website: '',
      linkedin: '',
    }));

    const result = await research(
      { name: 'Marlow', urls: ['https://marlow.example'] },
      { engine },
    );

    expect(result.outcome).not.toBe('no_anchor');
  });
});

// ── The constrained engine's routes ───────────────────────────────────────

describe('the constrained engine routes on what arrived', () => {
  it('takes the profile route for a lone address, and anchors on the headline', async () => {
    mockSearch.mockImplementation(async (query: string) => {
      if (query.includes('linkedin.com/in/')) {
        return searchReply(
          hit(
            'https://www.linkedin.com/in/example-person-1234',
            'Ada Example - Chief Technologist - Northwind | LinkedIn',
          ),
        );
      }
      return searchReply(
        hit('https://northwind.example/team', 'Ada Example joins Northwind', 'Northwind hires'),
        hit('https://stranger.example', 'Ada Example wins a race', 'a different Ada'),
      );
    });
    mockFetchWithTimeout.mockResolvedValue({ content: 'Ada Example leads engineering.' });

    const result = await research(
      { name: 'Ada Example', urls: ['https://www.linkedin.com/in/example-person-1234'] },
      { engine: 'constrained' },
    );

    expect(result.outcome).toBe('resolved');
    expect(result.linkedin).toBe('https://www.linkedin.com/in/example-person-1234');
    // The consistent result is opened; the namesake's stays a snippet.
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(mockFetchWithTimeout.mock.calls[0][0]).toBe('https://northwind.example/team');
    // No query planner on this route — the headline is the plan.
    expect(mockStructured.mock.calls.map((c) => c[0].toolName)).toEqual(['report_research']);
  });

  it('resolves a website for a name with context and no address', async () => {
    structuredBy({
      plan: { queries: ['Larkfield canteen software Denmark'], anchors: ['canteen', 'Denmark'] },
      confirm: { choice: 1, confidence: 'high' },
    });
    mockSearch.mockResolvedValue(
      searchReply(
        hit('https://larkfield.example/about', 'Larkfield — canteen software', 'for schools in Denmark'),
      ),
    );
    mockFetchWithTimeout.mockResolvedValue({ content: 'Canteen ordering for schools.' });

    const result = await research(
      {
        name: 'Larkfield',
        context: 'canteen software for schools and workplaces, Denmark',
        questions: 'what it does, which sector',
      },
      { engine: 'constrained' },
    );

    expect(result.outcome).toBe('resolved');
    // The site ROOT, not the page the search landed on.
    expect(result.website).toBe('https://larkfield.example');
    expect(result.confidence).toBe('high');
    expect(result.sources).toEqual(['https://larkfield.example']);
    expect(result.dossier).toContain('Canteen ordering');
    expect(result.usage.searches).toBe(1);
    expect(result.usage.fetches).toBe(1);
  });

  it('reads the address an entry brought rather than searching for one', async () => {
    mockFetchWithTimeout.mockResolvedValue({ content: 'Warehouse-native analytics.' });

    const result = await research(
      {
        name: 'Northwind Analytics',
        context: 'warehouse-native analytics for retail, Manchester',
        urls: ['northwindanalytics.example'],
      },
      { engine: 'constrained' },
    );

    expect(result.outcome).toBe('resolved');
    expect(result.website).toBe('https://northwindanalytics.example');
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockStructured.mock.calls.map((c) => c[0].toolName)).toEqual(['report_research']);
  });

  it('resolves nothing when no candidate is confirmed', async () => {
    structuredBy({
      plan: { queries: ['Orbix AI Copenhagen'], anchors: ['Copenhagen'] },
      confirm: { choice: null, confidence: 'low' },
      synthesis: {
        found: false,
        answers_everything: false,
        confidence: 'low',
        summary: '',
        dossier: '',
        sources: [],
      },
    });
    mockSearch.mockResolvedValue(searchReply(hit('https://other.example', 'Orbix', 'something')));

    const result = await research(
      { name: 'Orbix', context: 'a payments company in Copenhagen' },
      { engine: 'constrained' },
    );

    expect(result.outcome).toBe('no_match');
    expect(result.website).toBeUndefined();
    expect(result.summary).toBeUndefined();
  });

  it('keeps the address it resolved when the page will not load', async () => {
    mockFetchWithTimeout.mockResolvedValue(null);

    const result = await research(
      {
        name: 'Northwind Analytics',
        context: 'warehouse-native analytics for retail',
        urls: ['https://northwindanalytics.example'],
      },
      { engine: 'constrained' },
    );

    expect(result.outcome).toBe('fetch_failed');
    expect(result.website).toBe('https://northwindanalytics.example');
  });

  it('says partial when some questions are answered and some are not', async () => {
    structuredBy({
      synthesis: {
        found: true,
        answers_everything: false,
        confidence: 'medium',
        summary: 'It sells canteen software. [1]',
        dossier: 'https://larkfield.example\n"Canteen ordering."',
        sources: ['https://larkfield.example'],
      },
    });
    mockFetchWithTimeout.mockResolvedValue({ content: 'Canteen ordering.' });

    const result = await research(
      {
        name: 'Larkfield',
        context: 'canteen software, Denmark',
        questions: 'what it does, who founded it, how much it raised',
        urls: ['https://larkfield.example'],
      },
      { engine: 'constrained' },
    );

    expect(result.outcome).toBe('partial');
    expect(result.confidence).toBe('medium');
  });

  // The synthesis call that files gathered evidence into fields. These cases
  // run the REAL `synthesisSchema` — the mock calls `options.schema.parse(...)`
  // itself, the same as `anthropicChatStructured` does live — so what is
  // under test is the schema's own tolerance and the retry/fallback wiring
  // around it, mirroring the agentic engine's equivalent cases below.
  describe('filing a finished synthesis', () => {
    function synthesisInput(overrides: Record<string, unknown> = {}) {
      return {
        found: true,
        answers_everything: true,
        confidence: 'high',
        summary: 'It sells canteen software. [1]',
        sources: ['https://larkfield.example'],
        dossier: 'https://larkfield.example\n"Canteen ordering for schools."',
        ...overrides,
      };
    }

    function invokeResearch() {
      return research(
        { name: 'Larkfield', context: 'canteen software, Denmark', urls: ['https://larkfield.example'] },
        { engine: 'constrained' },
      );
    }

    beforeEach(() => {
      mockFetchWithTimeout.mockResolvedValue({ content: 'Canteen ordering for schools.' });
    });

    it('defaults a missing dossier to an empty string rather than throwing', async () => {
      mockStructured.mockImplementation(async (options: { schema: { parse: (v: unknown) => unknown } }) => {
        const { dossier: _omitted, ...rest } = synthesisInput();
        return options.schema.parse(rest);
      });

      const result = await invokeResearch();

      expect(result.outcome).toBe('resolved');
      expect(result.dossier).toBeUndefined();
    });

    it('salvages a bare source string into a one-element array', async () => {
      mockStructured.mockImplementation(async (options: { schema: { parse: (v: unknown) => unknown } }) =>
        options.schema.parse(synthesisInput({ sources: 'https://larkfield.example' })),
      );

      const result = await invokeResearch();

      expect(result.sources).toEqual(['https://larkfield.example']);
    });

    it('retries the synthesis call once with the validation message appended', async () => {
      let call = 0;
      mockStructured.mockImplementation(
        async (options: { schema: { parse: (v: unknown) => unknown }; userMessage: string }) => {
          call += 1;
          if (call === 1) {
            // A required field missing is a real ZodError, as
            // `anthropicChatStructured` would throw live.
            return options.schema.parse(synthesisInput({ confidence: undefined }));
          }
          expect(options.userMessage).toContain('rejected');
          return options.schema.parse(synthesisInput());
        },
      );

      const result = await invokeResearch();

      expect(call).toBe(2);
      expect(result.outcome).toBe('resolved');
      expect(result.confidence).toBe('high');
    });

    it('files the raw evidence at low confidence when synthesis fails twice, never no_match', async () => {
      mockStructured.mockImplementation(async () => {
        throw new Error('the model did not call report_research');
      });

      const result = await invokeResearch();

      expect(mockStructured).toHaveBeenCalledTimes(2);
      expect(result.outcome).not.toBe('no_match');
      expect(result.outcome).toBe('partial');
      expect(result.confidence).toBe('low');
      expect(result.summary).toContain('Canteen ordering for schools.');
      expect(result.usage.notes?.[0]).toContain('synthesis failed after a retry');
    });
  });
});

// ── The agentic engine ────────────────────────────────────────────────────

describe('the agentic engine', () => {
  it('searches and reads through the server tools, then files the answer', async () => {
    finalMessage.mockResolvedValueOnce(
      webReply({
        blocks: [...SEARCHED, ...FETCHED],
        text: 'Larkfield sells canteen software.\n\nWEBSITE: https://larkfield.example\nLINKEDIN: none\nCONFIDENCE: high',
        searches: 1,
        fetches: 1,
      }),
    );

    const result = await research(
      {
        name: 'Larkfield',
        context: 'canteen software for schools, Denmark',
        questions: 'what it does, which sector',
      },
      { engine: 'agentic' },
    );

    expect(result.outcome).toBe('resolved');
    expect(result.website).toBe('https://larkfield.example');
    expect(result.confidence).toBe('high');
    expect(result.usage).toMatchObject({
      searches: 1,
      fetches: 1,
      inputTokens: 1000,
      outputTokens: 200,
    });
    // The research turn is one request. (The call that files the answer is
    // stood in for here, so the meter cannot see it.)
    expect(result.usage.modelCalls).toBe(1);
    // The entry's own links go into the prompt: the page reader can only open
    // an address already in the conversation.
    const prompt = String(
      (stream.mock.calls[0][0].messages as Array<{ content: string }>)[0].content,
    );
    expect(prompt).toContain('canteen software for schools, Denmark');
  });

  it('puts the entry’s addresses where the page reader can reach them', async () => {
    finalMessage.mockResolvedValueOnce(webReply({ text: 'ok', blocks: FETCHED }));

    await research(
      { name: 'Larkfield', urls: ['https://larkfield.example', 'https://www.linkedin.com/in/ada'] },
      { engine: 'agentic' },
    );

    const prompt = String(
      (stream.mock.calls[0][0].messages as Array<{ content: string }>)[0].content,
    );
    expect(prompt).toContain('https://larkfield.example');
    expect(prompt).toContain('https://www.linkedin.com/in/ada');
  });

  it('stays partial, not fetch_failed, when some questions are answered despite a fetch failure', async () => {
    finalMessage.mockResolvedValueOnce(
      webReply({
        blocks: [
          {
            type: 'server_tool_use',
            id: 'f1',
            name: 'web_fetch',
            input: { url: 'https://larkfield.example' },
          },
          {
            type: 'web_fetch_tool_result',
            tool_use_id: 'f1',
            content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' },
          },
        ],
        text: 'I could not read their site.\n\nWEBSITE: none\nLINKEDIN: none\nCONFIDENCE: low',
      }),
    );
    structuredBy({
      shape: {
        found: true,
        answers_everything: false,
        confidence: 'low',
        summary: 'I could not read their site. [1]',
        dossier: '',
        sources: ['https://larkfield.example'],
        website: 'none',
        linkedin: 'none',
      },
    });

    const result = await research(
      { name: 'Larkfield', context: 'canteen software, Denmark' },
      { engine: 'agentic' },
    );

    expect(result.outcome).toBe('partial');
    expect(result.website).toBeUndefined();
    expect(result.usage.notes?.join(' ')).toMatch(/fetch failed/i);
  });

  it('resumes a paused turn and keeps both halves of the answer', async () => {
    finalMessage
      .mockResolvedValueOnce(
        webReply({ blocks: SEARCHED, text: 'Still looking. ', stopReason: 'pause_turn', searches: 1 }),
      )
      .mockResolvedValueOnce(
        webReply({
          blocks: FETCHED,
          text: 'Larkfield sells canteen software.\n\nWEBSITE: https://larkfield.example\nLINKEDIN: none\nCONFIDENCE: high',
          fetches: 1,
        }),
      );

    const result = await research(
      { name: 'Larkfield', context: 'canteen software, Denmark' },
      { engine: 'agentic' },
    );

    expect(result.outcome).toBe('resolved');
    expect(stream).toHaveBeenCalledTimes(2);
    // Both turns' server-tool requests are on the bill, and a resumed turn is
    // another request rather than a free continuation.
    expect(result.usage).toMatchObject({ searches: 1, fetches: 1, modelCalls: 2 });
    const filed = mockStructured.mock.calls[0][0] as { userMessage: string };
    expect(filed.userMessage).toContain('Still looking.');
    expect(filed.userMessage).toContain('Larkfield sells canteen software.');
  });

  it('attaches nothing when nothing consistent turned up', async () => {
    finalMessage.mockResolvedValueOnce(
      webReply({ blocks: SEARCHED, text: 'Every result is a different company.', searches: 1 }),
    );
    structuredBy({
      shape: {
        found: false,
        answers_everything: false,
        confidence: 'low',
        summary: '',
        dossier: '',
        sources: [],
        website: '',
        linkedin: '',
      },
    });

    const result = await research(
      { name: 'Marlow', context: 'a scheduling tool in Berlin' },
      { engine: 'agentic' },
    );

    expect(result.outcome).toBe('no_match');
    expect(result.summary).toBeUndefined();
  });

  it('reports a profile address only when it is one', async () => {
    finalMessage.mockResolvedValueOnce(webReply({ text: 'ok' }));
    structuredBy({
      shape: {
        found: true,
        answers_everything: true,
        confidence: 'medium',
        summary: 'They lead engineering. [1]',
        dossier: '',
        sources: ['https://northwind.example'],
        website: '',
        // A company page is not a profile.
        linkedin: 'https://www.linkedin.com/company/northwind',
      },
    });

    const result = await research(
      { name: 'Ada Example', urls: ['https://www.linkedin.com/in/example-person-1234'] },
      { engine: 'agentic' },
    );

    expect(result.linkedin).toBe('https://www.linkedin.com/in/example-person-1234');
  });

  // ── The profile pre-read ────────────────────────────────────────────────
  //
  // Anthropic's server fetcher refuses linkedin.com, so the address that
  // anchors identity is the one address this engine cannot open. It is read
  // in code first, with the constrained engine's own primitives, and handed
  // into the prompt.

  describe('the profile it cannot open, read for it', () => {
    it('puts what the index says about the profile into the research prompt', async () => {
      mockSearch.mockResolvedValue(
        searchReply(
          hit(
            'https://www.linkedin.com/in/example-person-1234',
            'Ada Example - Chief Technologist - Northwind | LinkedIn',
          ),
        ),
      );
      finalMessage.mockResolvedValueOnce(webReply({ text: 'ok', searches: 1 }));

      const result = await research(
        { name: 'Ada Example', urls: ['https://www.linkedin.com/in/example-person-1234'] },
        { engine: 'agentic' },
      );

      const prompt = String(
        (stream.mock.calls[0][0].messages as Array<{ content: string }>)[0].content,
      );
      expect(prompt).toContain('THE PROFILE, AS READ');
      expect(prompt).toContain('Ada Example');
      expect(prompt).toContain('Chief Technologist - Northwind');
      // One search spent before the turn; the turn's own allowance is four,
      // and the pre-read came out of the shared ceiling rather than out of it.
      expect(result.usage.searches).toBe(2);
      const tools = stream.mock.calls[0][0].tools as Array<{ name: string; max_uses: number }>;
      expect(tools.find((t) => t.name === 'web_search')?.max_uses).toBe(4);
    });

    it('falls through to the profile service when the index is thin', async () => {
      const getProfileTextByUrl = jest
        .fn()
        .mockResolvedValue({ text: 'Ada Example\nChief Technologist at Northwind\nCopenhagen' });
      services.linkedin = { getProfileTextByUrl } as unknown as typeof services.linkedin;
      // A title with no role and no organisation is nothing to check a later
      // result against — which is the only thing the paid read is for.
      mockSearch.mockResolvedValue(
        searchReply(hit('https://www.linkedin.com/in/example-person-1234', 'Ada Example | LinkedIn')),
      );
      finalMessage.mockResolvedValueOnce(webReply({ text: 'ok' }));

      const result = await research(
        { name: 'Ada Example', urls: ['https://www.linkedin.com/in/example-person-1234'] },
        { engine: 'agentic' },
      );

      expect(getProfileTextByUrl).toHaveBeenCalledWith(
        'https://www.linkedin.com/in/example-person-1234',
        expect.objectContaining({ maxWaitMs: expect.any(Number) }),
      );
      const prompt = String(
        (stream.mock.calls[0][0].messages as Array<{ content: string }>)[0].content,
      );
      expect(prompt).toContain('Chief Technologist at Northwind');
      // The read is a page read, and it comes out of the entry's own budget.
      expect(result.usage.fetches).toBe(1);
      const tools = stream.mock.calls[0][0].tools as Array<{ name: string; max_uses: number }>;
      expect(tools.find((t) => t.name === 'web_fetch')?.max_uses).toBe(2);
    });

    it('does not pre-read a company page, which is not a profile', async () => {
      const getProfileTextByUrl = jest.fn();
      services.linkedin = { getProfileTextByUrl } as unknown as typeof services.linkedin;
      finalMessage.mockResolvedValueOnce(webReply({ text: 'ok' }));

      await research(
        { name: 'Northwind', urls: ['https://www.linkedin.com/company/northwind'] },
        { engine: 'agentic' },
      );

      expect(mockSearch).not.toHaveBeenCalled();
      expect(getProfileTextByUrl).not.toHaveBeenCalled();
      const prompt = String(
        (stream.mock.calls[0][0].messages as Array<{ content: string }>)[0].content,
      );
      expect(prompt).not.toContain('THE PROFILE, AS READ');
    });
  });

  // The shaping call that files a finished write-up into fields. These cases
  // run the REAL `shapeSchema` — the mock calls `options.schema.parse(...)`
  // itself, the same as `anthropicChatStructured` does live — so what is
  // under test is the schema's own tolerance and the retry/fallback wiring
  // around it, not a convenient stand-in for either.
  describe('filing a finished write-up', () => {
    function shapeInput(overrides: Record<string, unknown> = {}) {
      return {
        found: true,
        answers_everything: true,
        confidence: 'high',
        summary: 'It sells canteen software. [1]',
        website: 'https://larkfield.example',
        linkedin: 'none',
        sources: ['https://larkfield.example'],
        dossier: 'https://larkfield.example\n"Canteen ordering for schools."',
        ...overrides,
      };
    }

    function writeUp() {
      return webReply({
        text: 'Larkfield sells canteen software.\n\nWEBSITE: https://larkfield.example\nLINKEDIN: none\nCONFIDENCE: high',
      });
    }

    it('defaults a missing dossier to an empty string rather than throwing', async () => {
      finalMessage.mockResolvedValueOnce(writeUp());
      mockStructured.mockImplementation(async (options: { schema: { parse: (v: unknown) => unknown } }) => {
        const { dossier: _omitted, ...rest } = shapeInput();
        return options.schema.parse(rest);
      });

      const result = await research(
        { name: 'Larkfield', context: 'canteen software, Denmark' },
        { engine: 'agentic' },
      );

      expect(result.outcome).toBe('resolved');
      expect(result.dossier).toBeUndefined();
    });

    it('salvages a bare source string into a one-element array', async () => {
      finalMessage.mockResolvedValueOnce(writeUp());
      mockStructured.mockImplementation(async (options: { schema: { parse: (v: unknown) => unknown } }) =>
        options.schema.parse(shapeInput({ sources: 'https://larkfield.example' })),
      );

      const result = await research(
        { name: 'Larkfield', context: 'canteen software, Denmark' },
        { engine: 'agentic' },
      );

      expect(result.sources).toEqual(['https://larkfield.example']);
    });

    it('retries the shaping call once with the validation message appended', async () => {
      finalMessage.mockResolvedValueOnce(writeUp());
      let call = 0;
      mockStructured.mockImplementation(
        async (options: { schema: { parse: (v: unknown) => unknown }; userMessage: string }) => {
          call += 1;
          if (call === 1) {
            // A required field missing is a real ZodError, as
            // `anthropicChatStructured` would throw live.
            return options.schema.parse(shapeInput({ confidence: undefined }));
          }
          expect(options.userMessage).toContain('rejected');
          return options.schema.parse(shapeInput());
        },
      );

      const result = await research(
        { name: 'Larkfield', context: 'canteen software, Denmark' },
        { engine: 'agentic' },
      );

      expect(call).toBe(2);
      expect(result.outcome).toBe('resolved');
      expect(result.confidence).toBe('high');
    });

    it('files the raw write-up at low confidence when shaping fails twice, never no_match', async () => {
      finalMessage.mockResolvedValueOnce(writeUp());
      mockStructured.mockImplementation(async () => {
        throw new Error('the model did not call file_research');
      });

      const result = await research(
        { name: 'Larkfield', context: 'canteen software, Denmark' },
        { engine: 'agentic' },
      );

      expect(mockStructured).toHaveBeenCalledTimes(2);
      expect(result.outcome).not.toBe('no_match');
      expect(result.outcome).toBe('partial');
      expect(result.confidence).toBe('low');
      expect(result.summary).toContain('Larkfield sells canteen software.');
      expect(result.usage.notes?.[0]).toContain('shaping failed after a retry');
    });
  });
});

// ── The plugin: config in, additions out ──────────────────────────────────

// ── The opener ────────────────────────────────────────────────────────────
//
// Both engines are told at length that the first sentence answers the
// question. Both still open on the identification now and then, so the rule
// is also enforced where a prompt cannot leak: in code, on the filed summary.

describe('a summary that opens on the identification', () => {
  it.each(ENGINES)('drops the opening sentence and says it did (%s)', async (engine) => {
    const filed = {
      found: true,
      answers_everything: true,
      confidence: 'high' as const,
      summary:
        'This matches strongly: UK-based, venture-backed, early-stage. Wayfarer builds photonic ' +
        'interconnects for data centres. [1]',
      dossier: '',
      sources: ['https://wayfarer.example'],
      website: 'https://wayfarer.example',
      linkedin: 'none',
    };
    structuredBy({ synthesis: filed, shape: filed });
    finalMessage.mockResolvedValueOnce(webReply({ text: 'a write-up', blocks: FETCHED, fetches: 1 }));
    mockFetchWithTimeout.mockResolvedValue({ content: 'Wayfarer builds photonic interconnects.' });

    const result = await research({ name: 'Wayfarer', urls: ['https://wayfarer.example'] }, { engine });

    expect(result.summary).toBe(
      'Wayfarer builds photonic interconnects for data centres. [1]',
    );
    expect(result.usage.notes).toEqual([
      'dropped a verification opener: This matches strongly: UK-based, venture-backed, early-stage.',
    ]);
  });

  it.each(ENGINES)('leaves a one-sentence summary alone, whatever it opens on (%s)', async (engine) => {
    const filed = {
      found: true,
      answers_everything: true,
      confidence: 'high' as const,
      summary: 'Larkfield matches school canteens with their suppliers. [1]',
      dossier: '',
      sources: ['https://larkfield.example'],
      website: 'https://larkfield.example',
      linkedin: 'none',
    };
    structuredBy({ synthesis: filed, shape: filed });
    finalMessage.mockResolvedValueOnce(webReply({ text: 'a write-up', blocks: FETCHED, fetches: 1 }));
    mockFetchWithTimeout.mockResolvedValue({ content: 'Larkfield matches canteens with suppliers.' });

    const result = await research({ name: 'Larkfield', urls: ['https://larkfield.example'] }, { engine });

    expect(result.summary).toBe('Larkfield matches school canteens with their suppliers. [1]');
    expect(result.usage.notes).toBeUndefined();
  });
});

describe('the plugin', () => {
  // These cases mock the constrained engine's collaborators, so name it: the
  // default is agentic.
  beforeEach(() => {
    process.env.RESEARCH_ENGINE = 'constrained';
  });

  it('reads the record’s three address fields as the entry’s addresses', async () => {
    mockFetchWithTimeout.mockResolvedValue({ content: 'Canteen ordering.' });

    const out = await invoke({
      name: 'Larkfield',
      context: 'canteen software, Denmark',
      questions: 'what it does',
      website: 'larkfield.example',
      linkedin: '',
      url: '',
    });

    expect(out.outcome).toBe('resolved');
    expect(out.properties).toEqual({
      summary: 'It sells canteen software. [1]',
      confidence: 'high',
      sources: '1. https://larkfield.example',
      website: 'https://larkfield.example',
      dossier: expect.stringContaining('Canteen ordering'),
    });
  });

  it('attaches nothing but an outcome for a record it refused', async () => {
    expect(await invoke({ name: 'Marlow', context: '', website: '', linkedin: '', url: '' })).toEqual(
      { outcome: 'no_anchor' },
    );
  });

  it('numbers the sources so the record carries one address per line', async () => {
    structuredBy({
      synthesis: {
        found: true,
        answers_everything: true,
        confidence: 'medium',
        summary: 'It sells canteen software. [1][2]',
        dossier: '',
        sources: ['https://larkfield.example', 'https://news.example/larkfield'],
      },
    });
    mockFetchWithTimeout.mockResolvedValue({ content: 'Canteen ordering.' });

    const out = await invoke({
      name: 'Larkfield',
      context: 'canteen software, Denmark',
      questions: 'what it does',
      website: 'https://larkfield.example',
    });

    expect(out.properties?.sources).toBe(
      '1. https://larkfield.example\n2. https://news.example/larkfield',
    );
  });

  it('refuses a pre-extraction call — the record’s own fields are the input', async () => {
    await expect(
      researchImpl.run({ kind: 'pre-extraction', sourceNode, config: { name: 'Larkfield' } }),
    ).rejects.toThrow('expected context-dependent input');
  });
});

// ── The declared surface ──────────────────────────────────────────────────

describe('the declared surface', () => {
  it('declares every property the engines can attach', () => {
    expect(Object.keys(researchImpl.signature.additions.properties ?? {}).sort()).toEqual([
      'confidence',
      'dossier',
      'linkedin',
      'sources',
      'summary',
      'website',
    ]);
  });

  it('declares its effects truthfully — it reads the web and uses a model', () => {
    expect(researchImpl.signature.effects).toEqual({ reads: ['the web'], ai: true });
  });

  it('is a stage of an extraction, because its arguments are extracted fields', () => {
    expect(researchImpl.signature.dataDependency).toBe('extracted_context');
  });

  it('keeps its manifest in lockstep with the signature', () => {
    expect(RESEARCH_PLUGIN_MANIFEST.pluginName).toBe(researchImpl.signature.name);
    expect(RESEARCH_PLUGIN_MANIFEST.importName).toBe('research');
    expect(RESEARCH_PLUGIN_MANIFEST.params).toBe(researchImpl.signature.params);
    expect(RESEARCH_PLUGIN_MANIFEST.additions).toBe(researchImpl.signature.additions);
  });

  it('takes the addresses as three named arguments, not as a list', () => {
    // A list literal of field names checks clean and throws at run time, so
    // the surface an author can actually write is three named addresses.
    expect(researchImpl.signature.params.map((p) => p.name)).toEqual([
      'name',
      'context',
      'questions',
      'website',
      'linkedin',
      'url',
    ]);
    expect(researchImpl.signature.params.every((p) => p.type.kind === 'string')).toBe(true);
  });
});

// ── The engine a run uses when nobody names one ──────────────────────────

describe('the configured engine', () => {
  it('is agentic when nothing is set', () => {
    delete process.env.RESEARCH_ENGINE;
    expect(configuredEngine()).toBe('agentic');
  });

  it('is constrained only when asked for by name', () => {
    process.env.RESEARCH_ENGINE = 'constrained';
    expect(configuredEngine()).toBe('constrained');
    process.env.RESEARCH_ENGINE = 'something-else';
    expect(configuredEngine()).toBe('agentic');
  });
});

// ── What the agentic engine is allowed to spend ──────────────────────────
//
// A production run spent the whole allowance on every entry and took five and
// a half minutes doing it, so the allowance and the clock are both asserted
// on the request rather than trusted to the prompt.

describe('the agentic engine’s allowance', () => {
  function toolsSent() {
    return stream.mock.calls[0][0].tools as Array<Record<string, unknown>>;
  }

  it('caps the turn at four searches, three reads, and a small slice of any page', async () => {
    finalMessage.mockResolvedValueOnce(webReply({ text: 'ok', blocks: FETCHED }));

    await research({ name: 'Larkfield', urls: ['https://larkfield.example'] }, { engine: 'agentic' });

    expect(toolsSent()).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 4 },
      {
        type: 'web_fetch_20260209',
        name: 'web_fetch',
        max_uses: 3,
        max_content_tokens: 6000,
      },
    ]);
  });

  it('takes the allowance from the environment, and ignores one that is not a count', async () => {
    process.env.RESEARCH_AGENTIC_SEARCHES = '2';
    process.env.RESEARCH_AGENTIC_FETCHES = '1';
    finalMessage.mockResolvedValueOnce(webReply({ text: 'ok', blocks: FETCHED }));
    await research({ name: 'Larkfield', urls: ['https://larkfield.example'] }, { engine: 'agentic' });
    expect(toolsSent()[0].max_uses).toBe(2);
    expect(toolsSent()[1].max_uses).toBe(1);

    // A mistyped allowance must not become the allowance: a fraction, a
    // negative, and a typo'd order of magnitude all fall back.
    for (const bad of ['2.5', '-1', '30', 'lots', '']) {
      jest.clearAllMocks();
      process.env.RESEARCH_AGENTIC_SEARCHES = bad;
      finalMessage.mockResolvedValueOnce(webReply({ text: 'ok', blocks: FETCHED }));
      await research({ name: 'Larkfield', urls: ['https://larkfield.example'] }, { engine: 'agentic' });
      expect(toolsSent()[0].max_uses).toBe(4);
    }
  });

  it('never exceeds the shared ceiling the profile pre-read has already eaten into', async () => {
    finalMessage.mockResolvedValueOnce(webReply({ text: 'ok', blocks: FETCHED }));

    await research(
      { name: 'Larkfield', urls: ['https://larkfield.example'] },
      { engine: 'agentic', budget: { maxSearches: 1, maxFetches: 1 } },
    );

    expect(toolsSent()[0].max_uses).toBe(1);
    expect(toolsSent()[1].max_uses).toBe(1);
  });

  it('reasons at medium unless the environment names another depth', async () => {
    finalMessage.mockResolvedValueOnce(webReply({ text: 'ok', blocks: FETCHED }));
    await research({ name: 'Larkfield', urls: ['https://larkfield.example'] }, { engine: 'agentic' });
    expect(stream.mock.calls[0][0].output_config).toEqual({ effort: 'medium' });

    jest.clearAllMocks();
    process.env.RESEARCH_AGENTIC_EFFORT = 'low';
    finalMessage.mockResolvedValueOnce(webReply({ text: 'ok', blocks: FETCHED }));
    await research({ name: 'Larkfield', urls: ['https://larkfield.example'] }, { engine: 'agentic' });
    expect(stream.mock.calls[0][0].output_config).toEqual({ effort: 'low' });

    jest.clearAllMocks();
    process.env.RESEARCH_AGENTIC_EFFORT = 'ludicrous';
    finalMessage.mockResolvedValueOnce(webReply({ text: 'ok', blocks: FETCHED }));
    await research({ name: 'Larkfield', urls: ['https://larkfield.example'] }, { engine: 'agentic' });
    expect(stream.mock.calls[0][0].output_config).toEqual({ effort: 'medium' });
  });
});

// ── The page reader, where Anthropic has none ────────────────────────────
//
// On Vertex there is no hosted page reader, so the turn gets a
// client-side `web_fetch` tool answered by the same scraper the rest of the
// engine uses. A run must read the same either way: the same events, the same
// counts, the same outcomes — and, where the scraper is not configured, a
// refusal that names the setting instead of a subject with no signal.

describe('the page reader on a provider with no hosted one', () => {
  async function onVertex<T>(fn: () => Promise<T>): Promise<T> {
    const restore = { ...process.env };
    Object.assign(process.env, {
      MODEL_MAP: JSON.stringify({ 'claude-sonnet-5': 'vertex/claude-sonnet-5' }),
      GOOGLE_PRIVATE_KEY: 'pk',
      GOOGLE_CLIENT_EMAIL: 'robot@example.iam.gserviceaccount.com',
      GOOGLE_PROJECT_ID: 'a-project',
    });
    try {
      return await fn();
    } finally {
      process.env = restore;
    }
  }

  it('reads the page with the scraper and files the dossier as usual', async () => {
    finalMessage
      .mockResolvedValueOnce(
        webReply({
          text: '',
          stopReason: 'tool_use',
          blocks: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'web_fetch',
              input: { url: 'https://larkfield.example' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(webReply({ text: 'It sells canteen software. [1]' }));

    const result = await onVertex(() =>
      research({ name: 'Larkfield', urls: ['https://larkfield.example'] }, { engine: 'agentic' }),
    );

    expect(mockGetWebsite).toHaveBeenCalledWith('https://larkfield.example', {
      provider: 'brightdata',
    });
    expect(result.outcome).toBe('resolved');
    // The page the turn opened is on the record, exactly as a hosted read is.
    expect(result.sources).toEqual(['https://larkfield.example']);
    expect(result.usage.fetches).toBe(1);
  });

  it('refuses the entry before any spend when the scraper is not configured', async () => {
    mockMissingBrightData.mockReturnValue(['BRIGHT_DATA_ACCESS_TOKEN']);

    const result = await onVertex(() =>
      research({ name: 'Larkfield', urls: ['https://larkfield.example'] }, { engine: 'agentic' }),
    );

    expect(result.outcome).toBe('fetch_failed');
    expect(result.usage.notes?.join(' ')).toContain('BRIGHT_DATA_ACCESS_TOKEN');
    expect(stream).not.toHaveBeenCalled();
    expect(mockGetWebsite).not.toHaveBeenCalled();
  });

  it('leaves the hosted reader alone on Anthropic', async () => {
    finalMessage.mockResolvedValueOnce(webReply({ text: 'ok', blocks: FETCHED, fetches: 1 }));

    const result = await research(
      { name: 'Larkfield', urls: ['https://larkfield.example'] },
      { engine: 'agentic' },
    );

    expect(mockGetWebsite).not.toHaveBeenCalled();
    expect(result.usage.fetches).toBe(1);
  });
});

// ── The wall clock ───────────────────────────────────────────────────────

describe('the wall clock', () => {
  /** A turn that only ever ends when the request is aborted — which is what
   *  the SDK does with an abort signal, and the only way to tell an ABORTED
   *  call apart from an abandoned one. */
  function turnThatOnlyEndsWhenAborted() {
    finalMessage.mockImplementationOnce(() => {
      const [, options] = stream.mock.calls[stream.mock.calls.length - 1];
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('Request was aborted.')));
      });
    });
  }

  it('is three minutes unless the environment says otherwise', () => {
    expect(configuredWallClockMs()).toBe(180000);
    process.env.RESEARCH_WALL_CLOCK_MS = '5000';
    expect(configuredWallClockMs()).toBe(5000);
    // Neither a zero deadline nor nonsense refuses every entry silently.
    process.env.RESEARCH_WALL_CLOCK_MS = '0';
    expect(configuredWallClockMs()).toBe(180000);
    process.env.RESEARCH_WALL_CLOCK_MS = 'soon';
    expect(configuredWallClockMs()).toBe(180000);
  });

  it('aborts a research turn that runs past it, and says so on the record', async () => {
    process.env.RESEARCH_WALL_CLOCK_MS = '1000';
    turnThatOnlyEndsWhenAborted();

    const result = await research(
      { name: 'Larkfield', context: 'canteen software, Denmark' },
      { engine: 'agentic' },
    );

    expect(result.outcome).toBe('no_match');
    // The second note is what stops a reader taking the zeroes at face value:
    // an aborted stream returns no usage row, so nothing was measured.
    expect(result.usage.notes).toEqual([
      'timed out after 1s',
      'usage not measured (aborted)',
    ]);
    expect(usageWasNotMeasured(result.usage)).toBe(true);
    // Aborted, not merely abandoned: the request itself was cancelled.
    const requestOptions = stream.mock.calls[0][1] as { signal: AbortSignal };
    expect(requestOptions.signal.aborted).toBe(true);
  });

  it('files a finished write-up raw when only the filing call was still running', async () => {
    process.env.RESEARCH_WALL_CLOCK_MS = '1000';
    finalMessage.mockResolvedValueOnce(
      webReply({
        blocks: [...SEARCHED, ...FETCHED],
        text: 'Larkfield sells canteen software.\n\nWEBSITE: https://larkfield.example\nLINKEDIN: none\nCONFIDENCE: high',
        searches: 1,
        fetches: 1,
      }),
    );
    mockStructured.mockImplementation(() => new Promise(() => {}));

    const result = await research(
      { name: 'Larkfield', context: 'canteen software, Denmark', questions: 'what it does' },
      { engine: 'agentic' },
    );

    // The research is DONE — only the clerical call was outstanding — so the
    // write-up is filed rather than thrown away.
    expect(result.outcome).toBe('partial');
    expect(result.summary).toContain('Larkfield sells canteen software.');
    expect(result.confidence).toBe('low');
    expect(result.sources).toContain('https://larkfield.example');
    // Nothing was aborted here — the turn's own usage came back — so the
    // numbers on this record are real.
    expect(result.usage.notes).toEqual(['timed out after 1s']);
    expect(usageWasNotMeasured(result.usage)).toBe(false);
  });

  it('leaves a run inside its budget alone', async () => {
    finalMessage.mockResolvedValueOnce(
      webReply({
        blocks: [...SEARCHED, ...FETCHED],
        text: 'Larkfield sells canteen software.\n\nWEBSITE: https://larkfield.example\nLINKEDIN: none\nCONFIDENCE: high',
        searches: 1,
        fetches: 1,
      }),
    );

    const result = await research(
      { name: 'Larkfield', context: 'canteen software, Denmark', questions: 'what it does' },
      { engine: 'agentic' },
    );

    expect(result.outcome).toBe('resolved');
    expect(result.usage.notes).toBeUndefined();
  });
});
