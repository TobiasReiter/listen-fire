import { logger } from 'movement-engine/public/log';

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

function isAvailable(): boolean {
  return !!TAVILY_API_KEY;
}

async function webSearch(query: string, maxResults = 5): Promise<SearchResult[]> {
  if (!TAVILY_API_KEY) throw new Error('Web search not configured (TAVILY_API_KEY missing)');

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      max_results: Math.min(maxResults, 10),
      search_depth: 'basic',
      include_answer: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    logger.warn('[web_search] Tavily API error', { status: response.status, body: text });
    throw new Error(`Search failed (${response.status})`);
  }

  const data = (await response.json()) as {
    results: Array<{
      title: string;
      url: string;
      content: string;
      published_date?: string;
    }>;
  };

  return data.results.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
    publishedDate: r.published_date,
  }));
}

export { webSearch, isAvailable, type SearchResult };
