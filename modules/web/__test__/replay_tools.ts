// A web plugin's tools, recorded and replayed. The platform's parity test
// records every ask a plugin makes of its tools (and the answer) while it
// runs on the platform's own tools; replaying hands the same answers back,
// in the same order, to the same asks — anything else is a mismatch that
// fails the invocation — so a host that is not the platform (serve-module as
// a process) is held to what the plugin did on the platform.

import type { ProfileFetchBudget, WebTools } from '../tools';

export interface ToolCall {
  tool: string;
  args: unknown;
  /** The plugin's own reader and searcher a web turn called, in order. */
  callbacks?: Array<{ callback: 'searchWeb' | 'fetchPage'; arg: string }>;
  answer?: unknown;
  threw?: string;
}

export interface RecordedInvocation {
  name: string;
  plugin: string;
  config: Record<string, unknown>;
  extractedContext: Record<string, unknown>;
  env?: Record<string, string>;
  tools: ToolCall[];
  answer: unknown;
}

/** JSON-safe and deterministic: a date, a schema, a function and a signal are
 *  named by what they are. */
export function normalised(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(
    JSON.stringify(value, function (this: Record<string, unknown>, key: string, v: unknown) {
      if (typeof v === 'function') return '<function>';
      if (this[key] instanceof Date) return '<date>';
      if (typeof v === 'object' && v !== null) {
        if ('safeParse' in v && typeof (v as { safeParse: unknown }).safeParse === 'function') return '<schema>';
        if (v instanceof AbortSignal) return '<signal>';
      }
      return v;
    }),
  );
}

type Callbacks = { searchWeb?: (q: string) => Promise<unknown>; fetchPage?: (u: string) => Promise<unknown> };

/** `tools`, writing every ask and answer into `calls`. */
export function recordingTools(tools: WebTools, calls: ToolCall[]): WebTools {
  async function noted<T>(tool: string, args: unknown, run: (call: ToolCall) => Promise<T>): Promise<T> {
    const call: ToolCall = { tool, args: normalised(args) };
    calls.push(call);
    try {
      const answer = await run(call);
      call.answer = normalised(answer);
      return answer;
    } catch (error) {
      call.threw = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
  function synced<T>(tool: string, args: unknown, answer: T): T {
    calls.push({ tool, args: normalised(args), answer: normalised(answer) });
    return answer;
  }
  const profiles = tools.profiles;
  return {
    log: tools.log,
    logFields: () => tools.logFields(),
    models: {
      anthropicChat: (options) => noted('anthropicChat', options, () => tools.models.anthropicChat(options)),
      anthropicChatStructured: (options) => noted('anthropicChatStructured', options, () => tools.models.anthropicChatStructured(options)),
      anthropicWebChat: (options) =>
        noted('anthropicWebChat', options, (call) => {
          const seen: NonNullable<ToolCall['callbacks']> = [];
          call.callbacks = seen;
          const watched: Callbacks = {
            ...(options.searchWeb ? { searchWeb: (q: string) => (seen.push({ callback: 'searchWeb', arg: q }), options.searchWeb!(q)) } : {}),
            ...(options.fetchPage ? { fetchPage: (u: string) => (seen.push({ callback: 'fetchPage', arg: u }), options.fetchPage!(u)) } : {}),
          };
          return tools.models.anthropicWebChat({ ...options, ...watched } as typeof options);
        }),
    },
    searchProvider: () => synced('searchProvider', null, tools.searchProvider()),
    search: (query) => noted('search', query, () => tools.search(query)),
    findLinkedIn: (input) => noted('findLinkedIn', input, () => tools.findLinkedIn(input)),
    scrape: (url) => noted('scrape', url, () => tools.scrape(url)),
    missingScraperSettings: () => synced('missingScraperSettings', null, tools.missingScraperSettings()),
    get profiles() {
      calls.push({ tool: 'profiles', args: null, answer: profiles !== undefined });
      return profiles && {
        getProfileTextByUrl: (url: string, budget?: ProfileFetchBudget) => noted('profiles.getProfileTextByUrl', { url, budget }, () => profiles.getProfileTextByUrl(url, budget)),
      };
    },
    isDocumentSource: (url) => synced('isDocumentSource', url, tools.isDocumentSource(url)),
    fetchResource: (url, email, password) => noted('fetchResource', { url, email, password }, () => tools.fetchResource(url, email, password)),
    fileValues: (handles) => noted('fileValues', handles, () => tools.fileValues(handles)),
  };
}

/** Tools that answer `recorded` back, refusing any ask it does not hold next.
 *  `done()` says whether every recorded ask was made. */
export function replayingTools(recorded: readonly ToolCall[], log: WebTools['log']): WebTools & { done(): void } {
  let next = 0;
  function take(tool: string, args: unknown): ToolCall {
    const call = recorded[next];
    const asked = JSON.stringify(normalised(args) ?? null);
    if (call === undefined || call.tool !== tool || JSON.stringify(call.args ?? null) !== asked) {
      throw new Error(`replay: asked ${tool}(${asked.slice(0, 200)}) where the recording holds ${call ? `${call.tool}(${JSON.stringify(call.args).slice(0, 200)})` : 'nothing more'}`);
    }
    next += 1;
    return call;
  }
  async function answered(tool: string, args: unknown): Promise<never> {
    const call = take(tool, args);
    if (call.threw !== undefined) throw new Error(call.threw);
    return call.answer as never;
  }
  return {
    log,
    logFields: () => ({}),
    models: {
      anthropicChat: (options) => answered('anthropicChat', options),
      anthropicChatStructured: (options) => answered('anthropicChatStructured', options),
      anthropicWebChat: async (options) => {
        const call = take('anthropicWebChat', options);
        for (const { callback, arg } of call.callbacks ?? []) {
          const callbacks: Callbacks = options;
          await callbacks[callback]?.(arg);
        }
        if (call.threw !== undefined) throw new Error(call.threw);
        return call.answer as never;
      },
    },
    searchProvider: () => take('searchProvider', null).answer as string,
    search: (query) => answered('search', query),
    findLinkedIn: (input) => answered('findLinkedIn', input),
    scrape: (url) => answered('scrape', url),
    missingScraperSettings: () => take('missingScraperSettings', null).answer as string[],
    get profiles() {
      const present = take('profiles', null).answer === true;
      return present ? { getProfileTextByUrl: (url: string, budget?: ProfileFetchBudget) => answered('profiles.getProfileTextByUrl', { url, budget }) } : undefined;
    },
    isDocumentSource: (url) => take('isDocumentSource', url).answer === true,
    fetchResource: (url, email, password) => answered('fetchResource', { url, email, password }),
    fileValues: (handles) => answered('fileValues', handles),
    done() {
      if (next !== recorded.length) throw new Error(`replay: ${recorded.length - next} recorded ask(s) never made (next: ${recorded[next]?.tool})`);
    },
  };
}
