// web_search — the provider switch and the Bright Data SERP mapping.
//
// `findLinkedIn`/`findTwitter` aren't under test here (they're the same
// regardless of provider); only `.search()`, which is where the provider
// switch and the Bright Data request/response live. `lib/prompts` and
// `lib/anthropic` are mocked purely to keep the module import cheap — nothing
// under test touches them.

jest.mock('../../lib/prompts', () => ({ Prompt: { matchSearchResult: jest.fn() } }));
jest.mock('../../lib/anthropic', () => ({ anthropicChat: jest.fn() }));
jest.mock('../../lib/web_search', () => ({
  webSearch: jest.fn(),
  isAvailable: () => false,
}));

import {
  parseBrightDataSerpPerMinute,
  RollingMinuteLimiter,
  WebSearchService,
} from '../web_search';

const fetchMock = jest.fn();
global.fetch = fetchMock as never;

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  // Only the retry wait's `setTimeout` is faked; `Date` stays real so the
  // per-attempt duration is still wall-clock time.
  jest.useFakeTimers({ doNotFake: ['Date'] });
  fetchMock.mockReset();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.WEB_SEARCH_PROVIDER;
  process.env.GOOGLE_CUSTOM_SEARCH_API_KEY = 'google-key';
  process.env.GOOGLE_CX = 'google-cx';
  delete process.env.BRIGHT_DATA_ACCESS_TOKEN;
  delete process.env.BRIGHT_DATA_SERP_ZONE;
  // Every Bright Data request in this process shares one pacing queue, and
  // these tests make more than a default minute's worth between them; the
  // pacing itself is under test below.
  process.env.BRIGHT_DATA_SERP_PER_MINUTE = '1000';
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

// The two retry waits in web_search.ts. Advancing fake timers by these
// flushes a wait without sleeping the suite.
const RETRY_DELAY_MS = 15_000;
const RATE_LIMIT_RETRY_DELAY_MS = 30_000;

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

describe('WebSearchService.search — provider switch', () => {
  it('defaults to google when WEB_SEARCH_PROVIDER is unset', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));

    await WebSearchService.search('acme');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toContain('https://www.googleapis.com/customsearch/v1');
  });

  it('routes to google explicitly', async () => {
    process.env.WEB_SEARCH_PROVIDER = 'google';
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));

    await WebSearchService.search('acme');

    expect(String(fetchMock.mock.calls[0][0])).toContain('googleapis.com');
  });

  it('routes to brightdata', async () => {
    process.env.WEB_SEARCH_PROVIDER = 'brightdata';
    process.env.BRIGHT_DATA_ACCESS_TOKEN = 'token-123';
    process.env.BRIGHT_DATA_SERP_ZONE = 'serp_zone';
    fetchMock.mockResolvedValueOnce(jsonResponse({ organic: [] }));

    await WebSearchService.search('acme');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.brightdata.com/request');
  });

  it('rejects an unrecognised value naming the variable and the values', async () => {
    process.env.WEB_SEARCH_PROVIDER = 'bing';

    await expect(WebSearchService.search('acme')).rejects.toThrow(
      'WEB_SEARCH_PROVIDER must be "google" or "brightdata" (got "bing")',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Google answers a refused request (bad key, unknown cx, API not enabled on
// the key's project, exhausted quota) with an `error` envelope and no
// `items`. Passed through, that reads downstream as "nobody found", so it
// has to fail instead.
describe('WebSearchService.search — google refusals', () => {
  it('returns a normal result unchanged', async () => {
    const items = [{ link: 'https://example.com/', title: 'Example', snippet: 'An example' }];
    fetchMock.mockResolvedValueOnce(jsonResponse({ items }));

    const result = await WebSearchService.search('example');

    expect(result.items).toEqual(items);
  });

  it('a 403 refusal fails naming the API to enable', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            code: 403,
            message: 'This project does not have the access to Custom Search JSON API.',
            status: 'PERMISSION_DENIED',
            errors: [{ reason: 'forbidden' }],
          },
        },
        { status: 403 },
      ),
    );

    await expect(WebSearchService.search('acme')).rejects.toThrow(
      /Google Custom Search refused the request \(403 PERMISSION_DENIED\): This project does not have the access to Custom Search JSON API\..*Custom Search JSON API is enabled/,
    );
  });

  it('a 200 carrying an error envelope fails with its message', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        error: {
          code: 429,
          message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per day'.",
          status: 'RESOURCE_EXHAUSTED',
          errors: [{ reason: 'rateLimitExceeded' }],
        },
      }),
    );

    await expect(WebSearchService.search('acme')).rejects.toThrow(
      /\(429 RESOURCE_EXHAUSTED\): Quota exceeded for quota metric 'Queries'/,
    );
  });
});

describe('WebSearchService.search — brightdata request shape', () => {
  beforeEach(() => {
    process.env.WEB_SEARCH_PROVIDER = 'brightdata';
    process.env.BRIGHT_DATA_ACCESS_TOKEN = 'token-123';
    process.env.BRIGHT_DATA_SERP_ZONE = 'serp_zone';
  });

  it('encodes a query with spaces and quotes into the google search url, bearer auth, and the SERP zone', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ organic: [] }));

    await WebSearchService.search('site:linkedin.com/in "Jane Doe" Acme Inc');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.brightdata.com/request');
    expect(options.method).toBe('POST');
    expect(options.headers).toMatchObject({
      Authorization: 'Bearer token-123',
      'Content-Type': 'application/json',
    });

    const body = JSON.parse(options.body as string);
    expect(body.zone).toBe('serp_zone');
    expect(body.format).toBe('raw');

    const requestedUrl = new URL(body.url);
    expect(requestedUrl.origin + requestedUrl.pathname).toBe('https://www.google.com/search');
    expect(requestedUrl.searchParams.get('q')).toBe('site:linkedin.com/in "Jane Doe" Acme Inc');
    expect(requestedUrl.searchParams.get('brd_json')).toBe('1');
  });

  it('missing variables fail naming them, without making a request', async () => {
    delete process.env.BRIGHT_DATA_ACCESS_TOKEN;
    delete process.env.BRIGHT_DATA_SERP_ZONE;

    await expect(WebSearchService.search('acme')).rejects.toThrow(
      'Bright Data web search requires BRIGHT_DATA_ACCESS_TOKEN and BRIGHT_DATA_SERP_ZONE to be set',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('missing only the zone names just the zone', async () => {
    delete process.env.BRIGHT_DATA_SERP_ZONE;

    await expect(WebSearchService.search('acme')).rejects.toThrow(
      'Bright Data web search requires BRIGHT_DATA_SERP_ZONE to be set',
    );
  });
});

describe('WebSearchService.search — brightdata response mapping', () => {
  beforeEach(() => {
    process.env.WEB_SEARCH_PROVIDER = 'brightdata';
    process.env.BRIGHT_DATA_ACCESS_TOKEN = 'token-123';
    process.env.BRIGHT_DATA_SERP_ZONE = 'serp_zone';
  });

  it('maps a realistic parsed reply into the shared result type', async () => {
    // Shape documented at https://docs.brightdata.com/scraping-automation/serp-api/
    // (organic[].link/title/description/rank/global_rank; only the three
    // fields callers read — title, link, snippet — are mapped).
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        general: { search_engine: 'google', query: 'Basecamp company', results_cnt: 12_400_000 },
        organic: [
          {
            rank: 1,
            global_rank: 1,
            title: 'Basecamp — Project management software',
            link: 'https://basecamp.com/',
            description: 'A simpler way to work. Basecamp puts everything in one place.',
          },
          {
            rank: 2,
            global_rank: 2,
            title: 'Basecamp (company) - Wikipedia',
            link: 'https://en.wikipedia.org/wiki/Basecamp_(company)',
            description: 'Basecamp, formerly 37signals, is an American software company.',
          },
        ],
        people_also_ask: [{ question: 'Who owns Basecamp?' }],
      }),
    );

    const result = await WebSearchService.search('Basecamp company');

    expect(result.items).toEqual([
      {
        link: 'https://basecamp.com/',
        title: 'Basecamp — Project management software',
        snippet: 'A simpler way to work. Basecamp puts everything in one place.',
      },
      {
        link: 'https://en.wikipedia.org/wiki/Basecamp_(company)',
        title: 'Basecamp (company) - Wikipedia',
        snippet: 'Basecamp, formerly 37signals, is an American software company.',
      },
    ]);
  });

  it('an empty organic array is a real "no results", not an error', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ general: { search_engine: 'google', query: 'no such thing' }, organic: [] }),
    );

    const result = await WebSearchService.search('no such thing');

    expect(result.items).toEqual([]);
  });

  it('an unexpected shape (no organic array) is retried, then the result returned', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'zone not found', status: 'failed' }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ organic: [] }));

    const promise = WebSearchService.search('acme');
    await jest.advanceTimersByTimeAsync(RETRY_DELAY_MS);

    expect((await promise).items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a non-JSON body is retried, then the result returned', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>not json</html>', { status: 200 }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ organic: [] }));

    const promise = WebSearchService.search('acme');
    await jest.advanceTimersByTimeAsync(RETRY_DELAY_MS);

    expect((await promise).items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a non-2xx configuration error (403) fails at once, naming the status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('zone unauthorized', { status: 403 }));

    await expect(WebSearchService.search('acme')).rejects.toThrow(/403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// Measured against a live SERP zone: a render failure (the zone's own
// selector wait timing out) and the zone's own rate limit both arrive as
// HTTP 200 with the real outcome in `x-brd-status-code` and an empty body.
describe('WebSearchService.search — brightdata retries', () => {
  beforeEach(() => {
    process.env.WEB_SEARCH_PROVIDER = 'brightdata';
    process.env.BRIGHT_DATA_ACCESS_TOKEN = 'token-123';
    process.env.BRIGHT_DATA_SERP_ZONE = 'serp_zone';
  });

  const timeoutError = () =>
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

  const brdRenderFailure = () =>
    new Response('', {
      status: 200,
      headers: {
        'x-brd-status-code': '502',
        'x-brd-error': 'waiting for selector "#main" failed',
      },
    });

  it('recovers from a Bright Data 502 with an empty body', async () => {
    fetchMock.mockResolvedValueOnce(brdRenderFailure());
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ organic: [{ link: 'https://example.com/', title: 'Example' }] }),
    );

    const promise = WebSearchService.search('acme');
    await jest.advanceTimersByTimeAsync(RETRY_DELAY_MS);

    expect((await promise).items).toEqual([
      { link: 'https://example.com/', title: 'Example', snippet: undefined },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers from a timeout', async () => {
    fetchMock.mockRejectedValueOnce(timeoutError());
    fetchMock.mockResolvedValueOnce(jsonResponse({ organic: [] }));

    const promise = WebSearchService.search('acme');
    await jest.advanceTimersByTimeAsync(RETRY_DELAY_MS);

    expect((await promise).items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers from an HTTP 500', async () => {
    fetchMock.mockResolvedValueOnce(new Response('internal error', { status: 500 }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ organic: [] }));

    const promise = WebSearchService.search('acme');
    await jest.advanceTimersByTimeAsync(RETRY_DELAY_MS);

    expect((await promise).items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits the longer rate-limit delay after a Bright Data 429', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('', { status: 200, headers: { 'x-brd-status-code': '429' } }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ organic: [] }));

    const promise = WebSearchService.search('acme');

    await jest.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_DELAY_MS - RETRY_DELAY_MS);
    expect((await promise).items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a Bright Data 403 fails at once, without retrying', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('', { status: 200, headers: { 'x-brd-status-code': '403' } }),
    );

    await expect(WebSearchService.search('acme')).rejects.toThrow(/Bright Data reported 403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails after three transient failures, naming each attempt', async () => {
    fetchMock.mockRejectedValueOnce(timeoutError());
    fetchMock.mockResolvedValueOnce(brdRenderFailure());
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));

    const expectation = expect(WebSearchService.search('acme')).rejects.toThrow(
      /^Bright Data SERP request failed after 3 attempts: #1 timed out \(\d+ms\); #2 Bright Data reported 502: waiting for selector "#main" failed \(\d+ms\); #3 response was not JSON \(200, 0 bytes\) \(\d+ms\)$/,
    );
    await jest.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    await jest.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('BRIGHT_DATA_SERP_PER_MINUTE', () => {
  it('defaults to 14 when unset or blank', () => {
    expect(parseBrightDataSerpPerMinute(undefined)).toBe(14);
    expect(parseBrightDataSerpPerMinute('  ')).toBe(14);
  });

  it('reads a positive whole number', () => {
    expect(parseBrightDataSerpPerMinute('30')).toBe(30);
  });

  it.each(['fourteen', '0', '-5', '1.5', '14/min'])(
    'refuses %p naming the variable',
    (raw) => {
      expect(() => parseBrightDataSerpPerMinute(raw)).toThrow(
        `BRIGHT_DATA_SERP_PER_MINUTE="${raw}" is not a positive whole number`,
      );
    },
  );
});

// Measured in production: thirty-odd searches demanded at once, and Bright
// Data refusing most of them with "Please decrease your request rate to
// 14/min". Requests now wait their turn instead.
describe('Bright Data SERP pacing', () => {
  const MINUTE_MS = 60_000;

  beforeEach(() => {
    // `Date` is faked too here: the limiter measures its minute with it.
    jest.useFakeTimers();
  });

  it('N requests at once take at least (N - 14) / 14 minutes, and no longer', async () => {
    const limiter = new RollingMinuteLimiter(() => 14);
    const start = Date.now();
    const grantedAt: number[] = [];
    const turns = Array.from({ length: 42 }, () =>
      limiter.take().then(() => grantedAt.push(Date.now() - start)),
    );

    await jest.advanceTimersByTimeAsync(0);
    expect(grantedAt).toHaveLength(14);

    await jest.advanceTimersByTimeAsync(MINUTE_MS - 1);
    expect(grantedAt).toHaveLength(14);
    await jest.advanceTimersByTimeAsync(1);
    expect(grantedAt).toHaveLength(28);

    await jest.advanceTimersByTimeAsync(MINUTE_MS);
    await Promise.all(turns);
    expect(grantedAt).toHaveLength(42);
    // (42 - 14) / 14 = two minutes for the last turn.
    expect(Math.max(...grantedAt)).toBe(2 * MINUTE_MS);
  });

  it('serves callers in the order they arrived', async () => {
    const limiter = new RollingMinuteLimiter(() => 1);
    const order: number[] = [];
    const turns = [1, 2, 3].map((n) => limiter.take().then(() => order.push(n)));

    await jest.advanceTimersByTimeAsync(2 * MINUTE_MS);
    await Promise.all(turns);
    expect(order).toEqual([1, 2, 3]);
  });

  it('every search, retries included, goes through the shared queue', async () => {
    await jest.isolateModulesAsync(async () => {
      const { WebSearchService: isolated } = await import('../web_search');
      process.env.WEB_SEARCH_PROVIDER = 'brightdata';
      process.env.BRIGHT_DATA_ACCESS_TOKEN = 'token-123';
      process.env.BRIGHT_DATA_SERP_ZONE = 'serp_zone';
      process.env.BRIGHT_DATA_SERP_PER_MINUTE = '2';
      fetchMock.mockImplementation(async () => jsonResponse({ organic: [] }));

      const searches = ['a', 'b', 'c'].map((q) => isolated.search(q));
      await jest.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(MINUTE_MS);
      await Promise.all(searches);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});
