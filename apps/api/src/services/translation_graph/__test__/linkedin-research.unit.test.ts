// linkedin-research — the plugin that starts from a profile address.
//
// Every external edge is mocked (the search index, the two model calls, the
// page fetch, the profile service), so what is under test is the plugin's own
// contract: which steps run, in what order, what the budget stops, and when it
// attaches nothing at all.
//
// No real person's address or name appears here — the slugs are obvious
// fakes, which is also what makes the acceptance-rule cases readable.
//
// Contract: plans/linkedin-research-plugin-2026-09-03/1_contract.md

// ── External dependency mocks (hoisted above the imports) ─────────────────

const mockAnthropicChat = jest.fn();
const mockAnthropicChatStructured = jest.fn();
const mockSearch = jest.fn();
const mockFetchWithTimeout = jest.fn();
const mockGetProfileTextByUrl = jest.fn();
const mockIsSupportedUrl = jest.fn();
const mockLogInfo = jest.fn();

jest.mock('../../../lib/anthropic', () => ({
  anthropicChat: (...args: unknown[]) => mockAnthropicChat(...args),
  anthropicChatStructured: (...args: unknown[]) => mockAnthropicChatStructured(...args),
}));
jest.mock('../../../lib/prompts/execute', () => ({
  parseJson: (raw: string) => JSON.parse(raw),
}));
jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: (...args: unknown[]) => mockLogInfo(...args), warn: jest.fn() },
}));
// The document store reaches Playwright, the crawler and the prompt library;
// all the plugin asks it is whether an address is a document.
jest.mock('../../../lib/document_sources', () => ({
  DocumentSourceService: {
    isSupportedUrl: (...args: unknown[]) => mockIsSupportedUrl(...args),
  },
}));
jest.mock('../../web_search', () => ({
  WebSearchService: {
    search: (...args: unknown[]) => mockSearch(...args),
  },
}));
// The shared fetch plumbing reaches the scraper, the document store and the
// database; the plugin only wants the text back, so the whole module is
// stood in for.
jest.mock('../engine/transforms/fetch_resource', () => ({
  fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args),
  describeError: (e: unknown) => String(e),
}));

// ── Module imports (after mocks) ──────────────────────────────────────────

import {
  linkedinResearchImpl,
  LINKEDIN_RESEARCH_PLUGIN_MANIFEST,
} from '../engine/transforms/linkedin-research';
import { services } from '../../../adapters/registry';
import { makeStablePosition } from '../types';
import type { ContextDependentInput } from '../engine/transforms';
import type { SourcePosition } from '../types';

// ── Fixtures ──────────────────────────────────────────────────────────────

const PROFILE_URL = 'https://www.linkedin.com/in/example-person-1234/';
const PROFILE_LINK = 'https://www.linkedin.com/in/example-person-1234';

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
  return linkedinResearchImpl.run(input);
}

/** The index result for the address itself — a rich LinkedIn title, which is
 *  what makes the profile service unnecessary. */
const RICH_INDEX_RESULT = {
  items: [
    {
      link: PROFILE_LINK,
      title: 'Alex Example - Head of Platform - Northwind Labs | LinkedIn',
      snippet: 'Head of Platform at Northwind Labs. Berlin.',
    },
  ],
};

/** A title with nothing after the name: no role, no organisation, nothing for
 *  the acceptance rule to check against. */
const THIN_INDEX_RESULT = {
  items: [{ link: PROFILE_LINK, title: 'Alex Example | LinkedIn', snippet: 'LinkedIn' }],
};

const ACTIVITY_RESULT = {
  items: [
    {
      link: 'https://news.example.com/northwind-launch',
      title: 'Northwind Labs launches its platform',
      snippet: 'Alex Example, Head of Platform at Northwind Labs, said…',
    },
  ],
};

const PLAN_REPLY = JSON.stringify({
  queries: [
    { query: '"Alex Example" Northwind Labs', worth_reading: true },
    { query: '"Alex Example" podcast', worth_reading: false },
  ],
  terms: ['Northwind Labs', 'Berlin'],
});

/** The synthesiser answers through a forced tool call, so its reply is an
 *  object rather than text to parse. */
const SYNTHESIS_REPLY = {
  found: true,
  confidence: 'high',
  current_role: 'Head of Platform',
  current_organisation: 'Northwind Labs',
  summary: 'Runs platform at Northwind Labs and launched it in June [1].',
  sources: ['https://news.example.com/northwind-launch', PROFILE_LINK],
};

const NOTHING_CONSISTENT = {
  found: false,
  confidence: 'low',
  current_role: '',
  current_organisation: '',
  summary: '',
  sources: [],
};

/** Say what each model call replied, rather than counting calls. */
function replies({ plan, synthesis }: { plan?: string; synthesis?: unknown }) {
  mockAnthropicChat.mockResolvedValue(plan ?? '{}');
  mockAnthropicChatStructured.mockResolvedValue(synthesis ?? NOTHING_CONSISTENT);
}

beforeEach(() => {
  mockAnthropicChat.mockReset();
  mockAnthropicChatStructured.mockReset();
  mockSearch.mockReset();
  mockFetchWithTimeout.mockReset();
  mockGetProfileTextByUrl.mockReset();
  mockIsSupportedUrl.mockReset();
  mockLogInfo.mockReset();
  mockIsSupportedUrl.mockReturnValue(false);
  services.linkedin = undefined;
  mockFetchWithTimeout.mockResolvedValue(null);
});

// ── The signature ─────────────────────────────────────────────────────────

describe('linkedin-research signature', () => {
  it('declares a required url and the five properties it attaches', () => {
    const sig = linkedinResearchImpl.signature;
    expect(sig.name).toBe('linkedin-research');
    expect(sig.dataDependency).toBe('extracted_context');
    expect(sig.effects).toEqual({ reads: ['the web'], ai: true });

    const url = sig.params.find((p) => p.name === 'url');
    expect(url?.required).toBe(true);
    expect(url?.type.kind).toBe('string');

    expect(Object.keys(sig.additions.properties ?? {}).sort()).toEqual([
      'activity_confidence',
      'activity_sources',
      'activity_summary',
      'current_organisation',
      'current_role',
    ]);
  });

  it('is imported as linkedin_research', () => {
    expect(LINKEDIN_RESEARCH_PLUGIN_MANIFEST.importName).toBe('linkedin_research');
    expect(LINKEDIN_RESEARCH_PLUGIN_MANIFEST.displayName).toBe('LinkedIn activity');
  });
});

// ── The address ───────────────────────────────────────────────────────────

describe('the address is the anchor', () => {
  it.each([
    ['a company page', 'https://www.linkedin.com/company/northwind'],
    ['a bare name', 'Alex Example'],
    ['nothing at all', ''],
    ['not a string', 42],
  ])('attaches nothing when the url is %s', async (_case, url) => {
    expect(await invoke({ url })).toEqual({});
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockAnthropicChat).not.toHaveBeenCalled();
  });

  it.each([
    ['no scheme', 'linkedin.com/in/example-person-1234'],
    ['a country subdomain', 'https://de.linkedin.com/in/example-person-1234'],
    ['a trailing path and query', 'https://www.linkedin.com/in/example-person-1234/?trk=abc'],
  ])('researches an address written with %s', async (_case, url) => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    const out = await invoke({ url });
    expect(out.properties?.activity_confidence).toBe('high');
  });
});

// ── Identity ──────────────────────────────────────────────────────────────

describe('identity', () => {
  it('skips the profile service when the index snippet is rich', async () => {
    services.linkedin = { getProfileTextByUrl: mockGetProfileTextByUrl };
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    await invoke({ url: PROFILE_URL });
    expect(mockGetProfileTextByUrl).not.toHaveBeenCalled();
  });

  it('reads the profile when the index snippet is thin and the service is there', async () => {
    services.linkedin = { getProfileTextByUrl: mockGetProfileTextByUrl };
    mockGetProfileTextByUrl.mockResolvedValue({
      text: 'Alex Example\nHead of Platform at Northwind Labs\nBerlin',
    });
    mockSearch.mockResolvedValueOnce(THIN_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    const out = await invoke({ url: PROFILE_URL });
    expect(mockGetProfileTextByUrl).toHaveBeenCalledWith(
      PROFILE_LINK,
      expect.objectContaining({ maxWaitMs: expect.any(Number) }),
    );
    expect(out.properties?.activity_summary).toBeDefined();
  });

  it('carries on at low confidence when the snippet is thin and no service is configured', async () => {
    mockSearch.mockResolvedValueOnce(THIN_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    const out = await invoke({ url: PROFILE_URL });
    // The synthesiser said `high`; a headline that told us nothing to check
    // against cannot support more than a hedge.
    expect(out.properties?.activity_confidence).toBe('low');
  });

  it('asks the index about the slug when the first search returns somebody else', async () => {
    mockSearch
      .mockResolvedValueOnce({
        items: [{ link: 'https://www.linkedin.com/in/someone-else-9999', title: 'Someone Else' }],
      })
      .mockResolvedValueOnce(RICH_INDEX_RESULT)
      .mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    const out = await invoke({ url: PROFILE_URL });
    expect(mockSearch.mock.calls[1][0]).toBe('site:linkedin.com/in/example-person-1234');
    expect(out.properties?.current_organisation).toBe('Northwind Labs');
  });

  it('attaches nothing when the index knows the address and no service can help', async () => {
    mockSearch.mockResolvedValue({ items: [] });

    expect(await invoke({ url: PROFILE_URL })).toEqual({});
    // Two identity searches, then it gives up before spending a model call.
    expect(mockSearch).toHaveBeenCalledTimes(2);
    expect(mockAnthropicChat).not.toHaveBeenCalled();
  });
});

// ── Budget ────────────────────────────────────────────────────────────────

describe('the budget', () => {
  it('runs one activity query however many the planner returns', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue({ items: [] });
    replies({
        plan: JSON.stringify({
          // Each names the person, which is what a query has to do to be run
          // at all.
          queries: [
            '"Alex Example" q1',
            '"Alex Example" q2',
            '"Alex Example" q3',
          ],
          terms: ['Northwind Labs'],
        }),
        synthesis: SYNTHESIS_REPLY,
      });

    await invoke({ url: PROFILE_URL });
    // 1 identity + 1 activity + 1 organisation, which the activity search
    // left uncovered.
    expect(mockSearch).toHaveBeenCalledTimes(3);
    const queries = mockSearch.mock.calls.map((c) => c[0]);
    expect(queries[1]).toBe('"Alex Example" q1');
    expect(queries[2]).toContain('site:crunchbase.com');
  });

  it('skips the organisation search when the activity search already named the organisation', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    await invoke({ url: PROFILE_URL });
    // 1 identity + 1 activity; the activity result names Northwind Labs.
    expect(mockSearch).toHaveBeenCalledTimes(2);
    const queries: string[] = mockSearch.mock.calls.map((c) => c[0]);
    expect(queries.some((q) => q.includes('site:crunchbase.com'))).toBe(false);
  });

  it('reads at most two pages, and never a LinkedIn one', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue({
      items: [
        { link: 'https://www.linkedin.com/posts/example-person-1234_a-post', title: 'A post' },
        { link: 'https://a.example.com/one', title: 'Northwind Labs one' },
        { link: 'https://b.example.com/two', title: 'Northwind Labs two' },
        { link: 'https://c.example.com/three', title: 'Northwind Labs three' },
      ],
    });
    mockFetchWithTimeout.mockResolvedValue({ content: 'page text' });
    replies({
        plan: JSON.stringify({
          queries: [{ query: '"Alex Example" q1', worth_reading: true }],
          terms: ['Northwind Labs'],
        }),
        synthesis: SYNTHESIS_REPLY,
      });

    await invoke({ url: PROFILE_URL });
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
    const fetched = mockFetchWithTimeout.mock.calls.map((c) => c[0]);
    expect(fetched).toEqual(['https://a.example.com/one', 'https://b.example.com/two']);
  });

  it('degrades rather than throwing when the index fails', async () => {
    mockSearch.mockRejectedValue(new Error('search is down'));

    expect(await invoke({ url: PROFILE_URL })).toEqual({});
  });
});

// ── Only distinctive things are searched for, or read ─────────────────────

/** "Stealth Startup" is where an employer's name would go, and is thousands of
 *  unrelated people's answer to the same question. */
const STEALTH_INDEX_RESULT = {
  items: [
    {
      link: PROFILE_LINK,
      title: 'Alex Example - Founder - Stealth Startup | LinkedIn',
      snippet: 'Founder at Stealth Startup. Berlin.',
    },
  ],
};

describe('the distinctiveness gate', () => {
  it('never anchors a search on a placeholder organisation', async () => {
    mockSearch.mockResolvedValueOnce(STEALTH_INDEX_RESULT).mockResolvedValue({ items: [] });
    replies({
      plan: JSON.stringify({
        queries: [
          { query: '"Alex Example" founder', worth_reading: true },
          { query: '"Stealth Startup" funding', worth_reading: true },
        ],
        terms: ['Stealth Startup', 'Berlin'],
        organisation: 'Stealth Startup',
      }),
      synthesis: SYNTHESIS_REPLY,
    });

    await invoke({ url: PROFILE_URL });

    const queries: string[] = mockSearch.mock.calls.map((c) => c[0]);
    // One identity search and one activity query: the placeholder query is
    // dropped and the aggregator expansion never runs.
    expect(queries).toEqual([PROFILE_LINK, '"Alex Example" founder']);
    expect(queries.some((q) => q.includes('site:crunchbase.com'))).toBe(false);
    expect(queries.some((q) => q.toLowerCase().includes('stealth'))).toBe(false);
    // Nor is the placeholder a consistency term the synthesiser is told to
    // accept results against: only the distinctive term survives.
    const synthesisInput = mockAnthropicChatStructured.mock.calls[0][0] as { userMessage: string };
    expect(synthesisInput.userMessage).toContain('Consistency terms (the acceptance rule): Berlin');
  });

  it('still reports the placeholder as the organisation it read', async () => {
    mockSearch.mockResolvedValueOnce(STEALTH_INDEX_RESULT).mockResolvedValue({ items: [] });
    replies({
      plan: JSON.stringify({ queries: [], terms: [], organisation: 'Stealth Startup' }),
      synthesis: { ...SYNTHESIS_REPLY, current_organisation: '' },
    });

    const out = await invoke({ url: PROFILE_URL });
    expect(out.properties?.current_organisation).toBe('Stealth Startup');
  });

  it('drops a planned query that names neither the person nor their organisation', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue({ items: [] });
    replies({
      plan: JSON.stringify({
        queries: ['graphene in vaccines', '"Alex Example" recent talks'],
        terms: ['Northwind Labs'],
      }),
      synthesis: SYNTHESIS_REPLY,
    });

    await invoke({ url: PROFILE_URL });

    const queries: string[] = mockSearch.mock.calls.map((c) => c[0]);
    expect(queries).not.toContain('graphene in vaccines');
    expect(queries).toContain('"Alex Example" recent talks');
  });

  it('never reads a page whose title and snippet name neither, however promising the query', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue({
      items: [
        {
          link: 'https://county.gov/notices/tax-sale',
          title: 'Municipal tax sale notice',
          // Consistent with a headline term, and still about nobody we asked
          // about: the acceptance rule alone lets this through.
          snippet: 'Berlin township tax sale, parcels listed by lot number.',
        },
      ],
    });
    replies({
      plan: JSON.stringify({
        queries: [{ query: '"Alex Example" news', worth_reading: true }],
        terms: ['Berlin'],
      }),
      synthesis: SYNTHESIS_REPLY,
    });

    await invoke({ url: PROFILE_URL });
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  it('reads a page that names the person even when the organisation is a placeholder', async () => {
    mockSearch.mockResolvedValueOnce(STEALTH_INDEX_RESULT).mockResolvedValue({
      items: [
        {
          link: 'https://news.example.com/interview',
          title: 'Alex Example on what comes next',
          snippet: 'A conversation with Alex Example, in Berlin.',
        },
      ],
    });
    mockFetchWithTimeout.mockResolvedValue({ content: 'page text' });
    replies({
      plan: JSON.stringify({
        queries: [{ query: '"Alex Example" interview', worth_reading: true }],
        terms: ['Berlin'],
        organisation: 'Stealth Startup',
      }),
      synthesis: SYNTHESIS_REPLY,
    });

    await invoke({ url: PROFILE_URL });
    expect(mockFetchWithTimeout).toHaveBeenCalledWith('https://news.example.com/interview', null);
  });
});

// ── The answer ────────────────────────────────────────────────────────────

describe('the answer', () => {
  it('attaches nothing when the synthesiser found nothing consistent', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: PLAN_REPLY, synthesis: NOTHING_CONSISTENT });

    expect(await invoke({ url: PROFILE_URL })).toEqual({});
  });

  it('attaches the five properties with numbered sources', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    const out = await invoke({ url: PROFILE_URL }, { name: 'Alex Example' });
    expect(out.properties).toEqual({
      activity_summary: 'Runs platform at Northwind Labs and launched it in June [1].',
      activity_confidence: 'high',
      current_role: 'Head of Platform',
      current_organisation: 'Northwind Labs',
      activity_sources: `1. https://news.example.com/northwind-launch\n2. ${PROFILE_LINK}`,
    });
  });

  it('attaches nothing when the synthesiser call fails outright', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    mockAnthropicChat.mockResolvedValue(PLAN_REPLY);
    // The forced tool call raises rather than handing back a half-answer.
    mockAnthropicChatStructured.mockRejectedValue(new Error('the tool call was truncated'));

    expect(await invoke({ url: PROFILE_URL })).toEqual({});
  });

  it('attaches nothing when the query planner returns something unreadable', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue({ items: [] });
    replies({ plan: 'not json at all', synthesis: NOTHING_CONSISTENT });

    // No plan means no activity queries; the headline alone is what the
    // synthesiser sees, and it found nothing consistent.
    expect(await invoke({ url: PROFILE_URL })).toEqual({});
  });
});

// ── The site's own name is not an employer ────────────────────────────────

/** What the index returns now: the site appended after a dash rather than a
 *  pipe, so the naive read takes "LinkedIn" for the organisation. */
const DASHED_INDEX_RESULT = {
  items: [
    {
      link: PROFILE_LINK,
      title: 'Alex Example - Co-Founder at NewCo - LinkedIn',
      snippet: 'Co-Founder at NewCo. Berlin.',
    },
  ],
};

describe('the trailing site name', () => {
  it('is stripped whichever punctuation precedes it, so it never becomes the organisation', async () => {
    mockSearch.mockResolvedValueOnce(DASHED_INDEX_RESULT).mockResolvedValue({ items: [] });
    replies({
      plan: JSON.stringify({ queries: ['"Alex Example" news'], terms: ['NewCo'] }),
      synthesis: { ...SYNTHESIS_REPLY, current_organisation: 'NewCo' },
    });

    const out = await invoke({ url: PROFILE_URL });

    const queries: string[] = mockSearch.mock.calls.map((c) => c[0]);
    // The headline is everything after the name, and the site is no part of it.
    expect(queries).toEqual([PROFILE_LINK, '"Alex Example" news']);
    expect(queries.some((q) => q.includes('site:crunchbase.com'))).toBe(false);
    expect(out.properties?.current_organisation).toBe('NewCo');
  });

  it('is a placeholder even when the planner hands it back as the organisation', async () => {
    mockSearch.mockResolvedValueOnce(DASHED_INDEX_RESULT).mockResolvedValue({
      items: [
        {
          link: 'https://directory.example.com/profiles',
          title: 'LinkedIn profiles directory',
          snippet: 'A directory of LinkedIn pages.',
        },
      ],
    });
    replies({
      plan: JSON.stringify({
        queries: [{ query: '"Alex Example" news', worth_reading: true }],
        terms: ['LinkedIn'],
        organisation: 'LinkedIn',
      }),
      synthesis: SYNTHESIS_REPLY,
    });

    await invoke({ url: PROFILE_URL });

    const queries: string[] = mockSearch.mock.calls.map((c) => c[0]);
    // No `"LinkedIn" site:crunchbase.com` expansion…
    expect(queries).toEqual([PROFILE_LINK, '"Alex Example" news']);
    // …and a page that names only the site is not about this person, so it is
    // never opened.
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });
});

// ── A document is never a page to read ────────────────────────────────────

describe('what the plugin will open', () => {
  /** One planned query, one result set, and a fetch that always succeeds —
   *  so whatever comes back in `items` is what the fetch decision saw. */
  function planOneQueryOver(items: Array<Record<string, string>>) {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue({ items });
    mockFetchWithTimeout.mockResolvedValue({ content: 'page text' });
    replies({
      plan: JSON.stringify({
        queries: [{ query: '"Alex Example" q1', worth_reading: true }],
        terms: ['Northwind Labs'],
      }),
      synthesis: SYNTHESIS_REPLY,
    });
  }

  it('skips an address that names a file, and reads the page beside it', async () => {
    planOneQueryOver([
      {
        link: 'https://example.org/reports/annual-2025.pdf',
        title: 'Northwind Labs annual report',
        snippet: 'Alex Example, Head of Platform.',
      },
      {
        link: 'https://a.example.com/one',
        title: 'Northwind Labs one',
        snippet: 'Alex Example, Head of Platform.',
      },
    ]);

    await invoke({ url: PROFILE_URL });

    expect(mockFetchWithTimeout.mock.calls.map((c) => c[0])).toEqual([
      'https://a.example.com/one',
    ]);
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.stringContaining('Skipped a result that is not a page'),
      expect.objectContaining({
        url: 'https://example.org/reports/annual-2025.pdf',
        reason: 'an address that names a file',
      }),
    );
  });

  it('skips a document source whose address looks like any other page', async () => {
    mockIsSupportedUrl.mockImplementation((url: unknown) => String(url).includes('docsend.com'));
    planOneQueryOver([
      {
        link: 'https://docsend.com/view/abcdef',
        title: 'Northwind Labs deck',
        snippet: 'Alex Example, Head of Platform.',
      },
    ]);

    await invoke({ url: PROFILE_URL });

    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.stringContaining('Skipped a result that is not a page'),
      expect.objectContaining({
        url: 'https://docsend.com/view/abcdef',
        reason: 'a document source, not a page',
      }),
    );
  });

  it('skips a document the organisation expansion turns up too', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue({
      items: [
        {
          link: 'https://city.example.gov/unclaimed-property.xlsx',
          title: 'Northwind Labs unclaimed property',
          snippet: 'Alex Example listed among holders.',
        },
      ],
    });
    mockFetchWithTimeout.mockResolvedValue({ content: 'page text' });
    replies({ plan: JSON.stringify({ queries: [], terms: ['Northwind Labs'] }), synthesis: SYNTHESIS_REPLY });

    await invoke({ url: PROFILE_URL });

    // The aggregator expansion ran and still opened nothing.
    expect(mockSearch.mock.calls.map((c) => c[0])[1]).toContain('site:crunchbase.com');
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });
});
