// web-research — the plugin for a record that arrived with nothing but a name.
//
// Every external edge is mocked (the search index, the two model calls, the
// page fetch), so what is under test is the plugin's own contract: what it
// refuses to spend anything on, what it accepts as that company's own site,
// and what it hands back when the page will not load.
//
// The names are the ones a real run left unenriched (run 087d67f7): six that
// arrived with a line of context and three that arrived bare. The contexts are
// plausible reconstructions — no message's text is reproduced here.
//
// Mission: plans/web-research-fallback-2026-09-09/0_mission.md

// ── External dependency mocks (hoisted above the imports) ─────────────────

const mockAnthropicChatStructured = jest.fn();
const mockSearch = jest.fn();
const mockFetchWithTimeout = jest.fn();
const mockLogInfo = jest.fn();

jest.mock('../../../lib/anthropic', () => ({
  anthropicChatStructured: (...args: unknown[]) => mockAnthropicChatStructured(...args),
}));
jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: (...args: unknown[]) => mockLogInfo(...args), warn: jest.fn() },
}));
jest.mock('../../web_search', () => ({
  WebSearchService: {
    search: (...args: unknown[]) => mockSearch(...args),
  },
}));
// The shared fetch plumbing reaches the scraper, the document store and the
// database; the plugin only wants the page back.
jest.mock('../engine/transforms/fetch_resource', () => ({
  fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args),
  emissionOf: (r: { url: string; content: string; documentId: string | null }) => ({
    data: { name: r.url, url: r.url, file: r.documentId, text: r.content },
  }),
  describeError: (e: unknown) => String(e),
}));

// ── Module imports (after mocks) ──────────────────────────────────────────

import type { ContextDependentInput } from '../engine/transforms';
import type { SourcePosition } from 'movement-engine/services/translation_graph/types';

import { webResearchImpl, WEB_RESEARCH_PLUGIN_MANIFEST } from '../engine/transforms/web-research';
import { makeStablePosition } from 'movement-engine/services/translation_graph/types';

// ── Fixtures ──────────────────────────────────────────────────────────────

const sourceNode: SourcePosition = makeStablePosition({
  adapterType: 'fixture',
  recordType: 'fixture.message',
  recordId: 'msg-1',
  data: {},
});

function invoke(config: Record<string, unknown>, extractedContext: unknown = {}) {
  const input: ContextDependentInput = {
    kind: 'context-dependent',
    sourceNode,
    config,
    extractedContext,
  };
  return webResearchImpl.run(input);
}

/** The six that arrived with something to search on, and the site each one
 *  should resolve to. */
const WITH_CONTEXT = [
  {
    name: 'Hollowbrook',
    context: 'AI agents for insurance claims, Copenhagen',
    anchors: ['insurance claims', 'Copenhagen'],
    host: 'hollowbrook.example',
  },
  {
    name: 'Larkfield',
    context: 'canteen software for schools and workplaces, Denmark',
    anchors: ['canteen software', 'Denmark'],
    host: 'larkfield.example',
  },
  {
    name: 'Quillbank',
    context: 'ambient clinical notes for doctors, London',
    anchors: ['clinical notes', 'London'],
    host: 'quillbank.example',
  },
  {
    name: 'Fernway',
    context: 'a coaching marketplace for managers, Amsterdam',
    anchors: ['coaching marketplace', 'Amsterdam'],
    host: 'fernway.example',
  },
  {
    name: 'Tessellate AI',
    context: 'a music production workstation, London',
    anchors: ['music production', 'London'],
    host: 'tessellate.example',
  },
  {
    name: 'Wayfarer',
    context: 'safety infrastructure for model deployments, Berlin',
    anchors: ['safety infrastructure', 'Berlin'],
    host: 'wayfarer.example',
  },
];

/** The three that arrived as a name and nothing else. */
const BARE_NAMES = ['Marlow', 'Orbix', 'Tarrow'];

function planReply(queries: string[], anchors: string[]) {
  return { queries, anchors };
}

/** Route the two model calls by the tool each one forces. */
function models(options: {
  plan: { queries: string[]; anchors: string[] };
  confirm?: { choice: number | null; confidence: 'high' | 'medium' | 'low' };
}) {
  mockAnthropicChatStructured.mockImplementation(async ({ toolName }: { toolName: string }) => {
    if (toolName === 'plan_searches') return options.plan;
    if (toolName === 'confirm_website') return options.confirm ?? { choice: null, confidence: 'low' };
    throw new Error(`unexpected tool ${toolName}`);
  });
}

function hit(host: string, title: string, snippet = title) {
  return { link: `https://${host}/about`, title, snippet };
}

function searchReturns(...items: Array<ReturnType<typeof hit>>) {
  mockSearch.mockResolvedValue({ items });
}

function fetched(url: string, content = 'the homepage text') {
  return { url, content, rawTextId: 'raw-1', resourceId: 'res-1', documentId: null };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchWithTimeout.mockResolvedValue(null);
});

// ── The record that already has somewhere to go ───────────────────────────

describe('a record that already carries a link', () => {
  it.each([
    ['a website', { website: 'https://acme.example' }],
    ['a profile address', { linkedin: 'https://www.linkedin.com/company/acme' }],
  ])('stands down when it has %s', async (_which, links) => {
    const output = await invoke({ name: 'Acme', context: 'rockets, Berlin', ...links });

    expect(output).toEqual({ outcome: 'has_link' });
    expect(mockAnthropicChatStructured).not.toHaveBeenCalled();
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  it('researches a record whose link fields are blank', async () => {
    models({ plan: planReply(['Acme rockets Berlin'], ['rockets']), confirm: { choice: 1, confidence: 'high' } });
    searchReturns(hit('acme.example', 'Acme — rockets'));
    mockFetchWithTimeout.mockResolvedValue(fetched('https://acme.example'));

    const output = await invoke({ name: 'Acme', context: 'rockets, Berlin', website: '', linkedin: null });

    expect(output.outcome).toBe('resolved');
  });
});

// ── Rule 1: no anchor, no search ──────────────────────────────────────────

describe('a bare name with nothing to anchor a search on', () => {
  it.each(BARE_NAMES)('refuses to search for %s', async (name) => {
    const output = await invoke({ name, context: '' });

    expect(output).toEqual({ outcome: 'no_anchor' });
    expect(mockSearch).not.toHaveBeenCalled();
    // Nothing is spent at all — not even the planner.
    expect(mockAnthropicChatStructured).not.toHaveBeenCalled();
  });

  it('refuses when the planner’s anchors are not in the context', async () => {
    models({ plan: planReply(['Marlow healthcare Zurich'], ['healthcare', 'Zurich']) });

    const output = await invoke({ name: 'Marlow', context: 'a company worth a look' });

    expect(output).toEqual({ outcome: 'no_anchor' });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('drops a query that names the company but nothing from the context', async () => {
    models({ plan: planReply(['Hollowbrook'], ['insurance claims']) });

    const output = await invoke({
      name: 'Hollowbrook',
      context: 'AI agents for insurance claims, Copenhagen',
    });

    expect(output).toEqual({ outcome: 'no_anchor' });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('drops a query that names the context but not the company', async () => {
    models({ plan: planReply(['insurance claims automation Copenhagen'], ['insurance claims']) });

    const output = await invoke({
      name: 'Hollowbrook',
      context: 'AI agents for insurance claims, Copenhagen',
    });

    expect(output).toEqual({ outcome: 'no_anchor' });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('sends the name to the index as an exact phrase', async () => {
    models({
      plan: planReply(['Larkfield canteen software Denmark'], ['canteen software']),
      confirm: { choice: null, confidence: 'low' },
    });
    searchReturns(hit('larkfield.example', 'Larkfield — canteen software'));

    await invoke({ name: 'Larkfield', context: 'canteen software for schools, Denmark' });

    expect(mockSearch).toHaveBeenCalledWith('"Larkfield" canteen software Denmark');
  });

  it('searches at most twice however many queries were planned', async () => {
    models({
      plan: planReply(
        ['Hollowbrook insurance claims', 'Hollowbrook Copenhagen', 'Hollowbrook insurance claims Copenhagen'],
        ['insurance claims', 'Copenhagen'],
      ),
      confirm: { choice: null, confidence: 'low' },
    });
    searchReturns(hit('hollowbrook.example', 'Hollowbrook — claims agents'));

    await invoke({ name: 'Hollowbrook', context: 'AI agents for insurance claims, Copenhagen' });

    expect(mockSearch).toHaveBeenCalledTimes(2);
  });
});

// ── The six that should resolve ───────────────────────────────────────────

describe('a name with context, and a site that is confidently theirs', () => {
  it.each(WITH_CONTEXT.map((c) => [c.name, c] as const))(
    'resolves %s to its own site and hands back the page',
    async (_name, company) => {
      models({
        plan: planReply([`${company.name} ${company.anchors[0]}`], company.anchors),
        confirm: { choice: 1, confidence: 'high' },
      });
      searchReturns(hit(company.host, `${company.name} — ${company.context}`));
      mockFetchWithTimeout.mockResolvedValue(
        fetched(`https://${company.host}`, `${company.name} homepage`),
      );

      const output = await invoke({ name: company.name, context: company.context });

      expect(output.outcome).toBe('resolved');
      // The site ROOT, not the page the search happened to land on.
      expect(output.properties).toEqual({ website: `https://${company.host}` });
      expect(mockFetchWithTimeout).toHaveBeenCalledWith(`https://${company.host}`, null);
      expect(output.edges?.fetchedUrl).toEqual({
        data: {
          name: `https://${company.host}`,
          url: `https://${company.host}`,
          file: null,
          text: `${company.name} homepage`,
        },
      });
    },
  );

  it('shows the confirming model the domain that spells the name first', async () => {
    models({
      plan: planReply(['Larkfield canteen software'], ['canteen software']),
      confirm: { choice: 1, confidence: 'high' },
    });
    searchReturns(
      hit('news.example', 'Larkfield raises for canteen software'),
      hit('larkfield.example', 'Larkfield — canteen software'),
    );
    mockFetchWithTimeout.mockResolvedValue(fetched('https://larkfield.example'));

    const output = await invoke({
      name: 'Larkfield',
      context: 'canteen software for schools and workplaces, Denmark',
    });

    const confirm = mockAnthropicChatStructured.mock.calls
      .map(([args]) => args)
      .find((args) => args.toolName === 'confirm_website');
    expect(confirm.userMessage).toMatch(/1\. larkfield\.example/);
    expect(output.properties).toEqual({ website: 'https://larkfield.example' });
  });
});

// ── Rule 2: only a confident match on their own site ──────────────────────

describe('a search that found nobody’s own site', () => {
  it('ignores a candidate whose address names a file rather than a page', async () => {
    models({ plan: planReply(['Wayfarer safety infrastructure'], ['safety infrastructure']) });
    mockSearch.mockResolvedValue({
      items: [
        {
          link: 'https://conference.example/programme/Wayfarer-companies.pdf',
          title: 'Wayfarer — safety infrastructure',
          snippet: 'Wayfarer — safety infrastructure',
        },
      ],
    });

    const output = await invoke({
      name: 'Wayfarer',
      context: 'safety infrastructure for model deployments, Berlin',
    });

    expect(output).toEqual({ outcome: 'no_match' });
  });

  it('emits nothing when every hit is an aggregator', async () => {
    models({ plan: planReply(['Hollowbrook insurance claims'], ['insurance claims']) });
    searchReturns(
      hit('www.linkedin.com', 'Hollowbrook | LinkedIn'),
      hit('www.crunchbase.com', 'Hollowbrook - Crunchbase Company Profile'),
      hit('pitchbook.com', 'Hollowbrook Company Profile'),
      hit('en.wikipedia.org', 'Hollowbrook'),
      hit('apps.apple.com', 'Hollowbrook on the App Store'),
      hit('techcrunch.com', 'Hollowbrook raises a seed round'),
    );

    const output = await invoke({
      name: 'Hollowbrook',
      context: 'AI agents for insurance claims, Copenhagen',
    });

    expect(output).toEqual({ outcome: 'no_match' });
    // Nothing survived the gate, so there was nothing to confirm.
    expect(
      mockAnthropicChatStructured.mock.calls.filter(([a]) => a.toolName === 'confirm_website'),
    ).toHaveLength(0);
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  it('emits nothing when no hit names the company', async () => {
    models({ plan: planReply(['Quillbank clinical notes'], ['clinical notes']) });
    searchReturns(hit('scribe.example', 'Ambient clinical notes for doctors'));

    const output = await invoke({
      name: 'Quillbank',
      context: 'ambient clinical notes for doctors, London',
    });

    expect(output).toEqual({ outcome: 'no_match' });
  });

  it.each([
    ['the model picked nobody', { choice: null, confidence: 'high' as const }],
    ['the model was only fairly sure', { choice: 1, confidence: 'medium' as const }],
    ['the model was unsure', { choice: 1, confidence: 'low' as const }],
  ])('emits nothing when %s', async (_why, confirm) => {
    models({ plan: planReply(['Wayfarer safety infrastructure'], ['safety infrastructure']), confirm });
    searchReturns(hit('wayfarer.example', 'Wayfarer — safety infrastructure'));

    const output = await invoke({
      name: 'Wayfarer',
      context: 'safety infrastructure for model deployments, Berlin',
    });

    expect(output).toEqual({ outcome: 'no_match' });
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });
});

// ── The address is worth having even when the page is not ─────────────────

describe('a confirmed site that will not load', () => {
  it('hands back the address anyway', async () => {
    models({
      plan: planReply(['Tessellate AI music production'], ['music production']),
      confirm: { choice: 1, confidence: 'high' },
    });
    searchReturns(hit('tessellate.example', 'Tessellate AI — music production workstation'));
    mockFetchWithTimeout.mockResolvedValue(null);

    const output = await invoke({
      name: 'Tessellate AI',
      context: 'a music production workstation, London',
    });

    expect(output).toEqual({
      properties: { website: 'https://tessellate.example' },
      outcome: 'fetch_failed',
    });
  });

  it('hands back the address when the fetch throws', async () => {
    models({
      plan: planReply(['Tessellate AI music production'], ['music production']),
      confirm: { choice: 1, confidence: 'high' },
    });
    searchReturns(hit('tessellate.example', 'Tessellate AI — music production workstation'));
    mockFetchWithTimeout.mockRejectedValue(new Error('scraper is down'));

    const output = await invoke({
      name: 'Tessellate AI',
      context: 'a music production workstation, London',
    });

    expect(output.outcome).toBe('fetch_failed');
    expect(output.properties).toEqual({ website: 'https://tessellate.example' });
  });
});

// ── What the run record says ──────────────────────────────────────────────

describe('the log trail', () => {
  it('names the outcome and the queries, and never the page text', async () => {
    models({
      plan: planReply(['Hollowbrook insurance claims'], ['insurance claims']),
      confirm: { choice: 1, confidence: 'high' },
    });
    searchReturns(hit('hollowbrook.example', 'Hollowbrook — claims agents'));
    mockFetchWithTimeout.mockResolvedValue(fetched('https://hollowbrook.example', 'SECRET PAGE TEXT'));

    await invoke({ name: 'Hollowbrook', context: 'AI agents for insurance claims, Copenhagen' });

    const outcomeLine = mockLogInfo.mock.calls.find(([message]) =>
      String(message).includes('resolved'),
    );
    expect(outcomeLine[1]).toMatchObject({
      name: 'Hollowbrook',
      outcome: 'resolved',
      url: 'https://hollowbrook.example',
      // The name goes to the index as an exact phrase, whatever the planner wrote.
      queries: ['"Hollowbrook" insurance claims'],
    });
    expect(JSON.stringify(mockLogInfo.mock.calls)).not.toContain('SECRET PAGE TEXT');
  });
});

// ── The manifest ──────────────────────────────────────────────────────────

describe('the plugin manifest', () => {
  it('offers the four arguments an author writes, one of them required', () => {
    expect(WEB_RESEARCH_PLUGIN_MANIFEST.importName).toBe('web_research');
    expect(WEB_RESEARCH_PLUGIN_MANIFEST.params.map((p) => p.name)).toEqual([
      'name',
      'context',
      'website',
      'linkedin',
    ]);
    expect(WEB_RESEARCH_PLUGIN_MANIFEST.params.filter((p) => p.required).map((p) => p.name)).toEqual(
      ['name'],
    );
  });

  it('declares that it reads the web and consults a model, and runs only as a stage', () => {
    expect(webResearchImpl.signature.effects).toEqual({ reads: ['the web'], ai: true });
    expect(webResearchImpl.signature.dataDependency).toBe('extracted_context');
  });
});
