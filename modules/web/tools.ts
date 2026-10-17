// What the web plugins need from whoever runs them: models, a web search, a
// page scrape, a profile reader, a fetch that turns one address into a stored
// resource, and somewhere to log. The plugins decide what to look at and what
// to make of it; the tools are how they look.
//
// Two sets of tools exist. The platform passes its own services (the hosted
// model routing and billing, its search and scrape providers, its browser
// for gated documents and its document store), so moving the plugins into
// this module changed nothing they ask of the platform. Every other host runs
// the module's standalone tools (`standalone.ts`), built from the context the
// host hands a module: its fetch, its credential, its files.
//
// A plugin reads the tools of the invocation it is serving from an async
// scope rather than through every function's arguments: the bodies were
// written against ambient services, and threading a parameter through every
// helper of research would have rewritten them while moving them.

import { AsyncLocalStorage } from 'node:async_hooks';

import type { ModuleLog } from 'module-kit';
import type { AnthropicClient } from 'movement-engine/public/anthropic';

/** One search result, as a search provider gives it. */
export interface SearchResult {
  link?: string | null;
  title?: string | null;
  snippet?: string | null;
}

/** A profile page's text, as a profile reader gives it. */
export interface ProfileText {
  text?: string | null;
}

/** How long a profile reader may keep collecting before it answers. */
export interface ProfileFetchBudget {
  maxWaitMs?: number;
}

export interface ProfileReader {
  getProfileTextByUrl(url: string, budget?: ProfileFetchBudget): Promise<ProfileText | null>;
}

/**
 * One address fetched and kept. `content` is the text read from it (empty
 * when it was a document none of whose text could be read). `file` is the
 * host's handle on a stored document, when the address was one: what a
 * plugin's record carries until `fileValues` turns it into a file value.
 */
export interface FetchedResource {
  url: string;
  content: string;
  file: unknown;
}

export interface WebTools {
  log: ModuleLog;
  /** Who the current call is for, put on every log line. */
  logFields(): Record<string, unknown>;
  models: Pick<AnthropicClient, 'anthropicChat' | 'anthropicChatStructured' | 'anthropicWebChat'>;
  /** Which search provider answers `search` (said on the log lines). */
  searchProvider(): string;
  search(query: string): Promise<{ items?: SearchResult[] }>;
  /** A person's profile address, found by search. */
  findLinkedIn(input: { name: string; company: string | null; description: string | null }): Promise<SearchResult[]>;
  /** A page's text, read through the scrape provider. Empty when it had none. */
  scrape(url: string): Promise<string>;
  /** The settings the scrape provider is missing; empty when it can run. */
  missingScraperSettings(): string[];
  /** The profile reader, when this host has one. */
  profiles: ProfileReader | undefined;
  /** An address a document source (a deck host, a data room) serves. */
  isDocumentSource(url: string): boolean;
  /** One address fetched — a gated document, a profile, or a page — and kept.
   *  Null when nothing came back. */
  fetchResource(url: string, email: string | null, password?: string | null): Promise<FetchedResource | null>;
  /** The file value each handle `fetchResource` gave stands for, in order;
   *  undefined where the stored document can no longer be found. */
  fileValues(handles: readonly unknown[]): Promise<unknown[]>;
  /** What this invocation's model calls and services cost, for a host whose
   *  meters do not see them; absent where they are metered as they happen. */
  spentMicrodollars?(): number;
}

const scope = new AsyncLocalStorage<WebTools>();

/** Run `body` with `tools` as the tools every plugin call inside it reads. */
export function withTools<T>(tools: WebTools, body: () => Promise<T>): Promise<T> {
  return scope.run(tools, body);
}

/** The tools of the invocation being served. */
export function tools(): WebTools {
  const current = scope.getStore();
  if (current === undefined) throw new Error('@lf/web: a plugin ran outside an invocation (no tools in scope)');
  return current;
}

/** The invocation's logger. */
export const logger: ModuleLog = {
  debug: (message, meta) => tools().log.debug(message, meta),
  info: (message, meta) => tools().log.info(message, meta),
  warn: (message, meta) => tools().log.warn(message, meta),
  error: (message, meta) => tools().log.error(message, meta),
};

/** Who the invocation is for, for a log line. */
export function runFields(): Record<string, unknown> {
  return tools().logFields();
}

export const anthropicChat: WebTools['models']['anthropicChat'] = (options) => tools().models.anthropicChat(options);
export const anthropicChatStructured: WebTools['models']['anthropicChatStructured'] = (options) =>
  tools().models.anthropicChatStructured(options);
export const anthropicWebChat: WebTools['models']['anthropicWebChat'] = (options) => tools().models.anthropicWebChat(options);

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
