// The services the bundled plugins reach, stubbed: every model call, search,
// scrape, document fetch and storage write a plugin makes is answered from the
// running case's script and written down. A recorded case is what the plugin
// asked of its host and what it answered; replaying it holds a later line (the
// `@lf/web` module, in process) to the same asks and the same answer.

import type { ParityCase } from './cases';

export interface StubCall {
  service: string;
  args: unknown;
}

let current: ParityCase | undefined;
let calls: StubCall[] = [];
let counter = 0;

export function startCase(c: ParityCase): void {
  current = c;
  calls = [];
  counter = 0;
}

export function takeCalls(): StubCall[] {
  const taken = calls;
  calls = [];
  return taken;
}

function script(): ParityCase {
  if (current === undefined) throw new Error('parity stub called outside a case');
  return current;
}

/** JSON-safe, deterministic: a date is a date, a schema is a schema, a
 *  function or signal is named by what it is. */
export function normalised(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, function (this: Record<string, unknown>, key: string, v: unknown) {
      if (typeof v === 'function') return '<function>';
      // Read before `toJSON` has turned it into a string.
      if (this[key] instanceof Date) return '<date>';
      if (typeof v === 'object' && v !== null) {
        if ('safeParse' in v && typeof (v as { safeParse: unknown }).safeParse === 'function') return '<schema>';
        if (typeof AbortSignal !== 'undefined' && v instanceof AbortSignal) return '<signal>';
      }
      return v;
    }) ?? 'null',
  );
}

function note(service: string, args: unknown): void {
  calls.push({ service, args: normalised(args) });
}

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

interface ChatOptions {
  label?: string;
  toolName?: string;
  fetchPage?: (url: string) => Promise<unknown>;
  searchWeb?: (query: string) => Promise<unknown>;
}

export const anthropicModule = {
  anthropicChat: async (options: ChatOptions) => {
    note('anthropicChat', options);
    const answer = script().chat?.[options.label ?? ''];
    if (answer === undefined) throw new Error(`no scripted chat for ${options.label}`);
    return answer;
  },
  anthropicChatStructured: async (options: ChatOptions) => {
    note('anthropicChatStructured', options);
    const answer = script().structured?.[options.toolName ?? ''];
    if (answer === undefined) throw new Error(`no scripted answer for tool ${options.toolName}`);
    return answer;
  },
  anthropicWebChat: async (options: ChatOptions) => {
    note('anthropicWebChat', options);
    const turn = script().webChat;
    if (turn === undefined) throw new Error('no scripted web chat');
    // The turn reads what the script says it reads, through the plugin's own
    // reader and searcher, so their plumbing is on the record too.
    const events: unknown[] = [];
    for (const query of turn.searches ?? []) {
      const found = (await options.searchWeb?.(query)) as { hits?: Array<{ url: string; title: string }> } | undefined;
      events.push({ kind: 'search', query, results: (found?.hits ?? []).map((h) => ({ url: h.url, title: h.title, pageAge: null })) });
    }
    for (const url of turn.fetches ?? []) {
      const page = (await options.fetchPage?.(url)) as { text?: string } | undefined;
      events.push({ kind: 'fetch', url, retrievedAt: null, text: page?.text ?? '' });
    }
    return {
      text: turn.text,
      events,
      stopReason: 'end_turn',
      resumes: 0,
      turns: 1,
      pageReader: 'own',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, searches: events.length, fetches: 0 },
    };
  },
};

export const webSearchModule = {
  resolveWebSearchProvider: () => 'brightdata',
  WebSearchService: {
    search: async (query: string) => {
      note('WebSearchService.search', query);
      return { items: script().search?.[query] ?? script().search?.['*'] ?? [] };
    },
    findLinkedIn: async (input: unknown, options?: unknown) => {
      note('WebSearchService.findLinkedIn', { input, options });
      return script().linkedinSearch ?? [];
    },
  },
};

export const scraperModule = {
  missingBrightDataVars: () => [],
  ScraperService: {
    getWebsite: async (url: string, options: unknown) => {
      note('ScraperService.getWebsite', { url, options });
      return script().pages?.[url] ?? '';
    },
  },
};

export const documentSourcesModule = {
  DocumentSourceService: {
    isSupportedUrl: (url: string) => (script().documentSources ?? []).includes(url),
  },
};

export const pitchDeckModule = {
  pitchDeckUrlTool: async (args: { url: string }) => {
    note('pitchDeckUrlTool', args);
    const deck = script().decks?.[args.url];
    if (deck === undefined) return { type: 'EMPTY' };
    if (deck.kind === 'text') {
      const id = nextId('raw');
      rawTexts.set(id, deck.text);
      return { type: 'TEXT', rawTextId: id };
    }
    return { type: 'DOCUMENT', documentId: deck.documentId };
  },
};

export const extractTextModule = {
  extractDocumentTextTool: async (args: { documentId: string }) => {
    note('extractDocumentTextTool', args);
    const text = script().documentTexts?.[args.documentId];
    if (text === undefined) return { type: 'EMPTY' };
    const id = nextId('raw');
    rawTexts.set(id, text);
    return { type: 'DOCUMENT_WITH_CONTENT', rawTextId: id, documentId: args.documentId };
  },
};

const rawTexts = new Map<string, string>();

export const rawTextModule = {
  RawTextService: {
    getOrCreateFromContent: async (content: string) => {
      note('RawTextService.getOrCreateFromContent', content);
      const id = nextId('raw');
      rawTexts.set(id, content);
      return { id, content };
    },
    getById: async (id: string) => {
      note('RawTextService.getById', id);
      return { id, content: rawTexts.get(id) ?? '' };
    },
  },
};

export const resourceModule = {
  ResourceService: {
    getOrCreate: async (args: unknown) => {
      note('ResourceService.getOrCreate', args);
      return { id: nextId('resource'), documentId: null };
    },
    update: async (id: string, patch: unknown) => {
      note('ResourceService.update', { id, patch });
    },
  },
};

export const documentModule = {
  DocumentService: {
    getById: async (id: string) => {
      note('DocumentService.getById', id);
      const stored = script().storedDocuments?.[id];
      if (stored === undefined) throw new Error(`no document ${id}`);
      return { id, objectUri: stored.objectUri, description: stored.name };
    },
  },
};

export const registryModule = {
  get services() {
    const profiles = current?.profiles;
    if (profiles === undefined) return {};
    return {
      linkedin: {
        getProfileTextByUrl: async (url: string, budget?: unknown) => {
          note('linkedin.getProfileTextByUrl', { url, budget });
          const text = profiles[url];
          return text === undefined ? null : { text };
        },
      },
    };
  },
};
