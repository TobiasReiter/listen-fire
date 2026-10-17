// The platform's tools for the web plugins (`@lf/web`): the hosted model
// routing and billing, the configured search and scrape providers, the
// profile reader, the gated-document browser and the document store. These
// are exactly the services the plugins called before they moved into the
// module, so either line — the legacy registry or the module — asks the
// platform the same things.

import type { FileRef } from 'engine-contracts';
import type { TransformImpl } from './registry';

import { runWebPlugin, withTools, type WebPlugin, type WebTools } from '@listen-fire/web';
import { documentStoreFileRef } from 'movement-engine/public/files';
import { logger } from 'movement-engine/public/log';
import { services } from '../../../../adapters/registry';
import { anthropicChat, anthropicChatStructured, anthropicWebChat } from '../../../../lib/anthropic';
import { DocumentSourceService } from '../../../../lib/document_sources';
import { runFields } from '../../../../lib/llm_usage';
import { DocumentService } from '../../../document';
import { missingBrightDataVars, ScraperService } from '../../../scraper';
import { resolveWebSearchProvider, WebSearchService } from '../../../web_search';
import { fetchWithTimeout } from './fetch_resource';
import { implementing } from './registry';

export const hostedWebTools: WebTools = {
  // Each reaches its service at call time, so a test that replaces one is
  // heard by the plugins.
  log: {
    debug: (message, meta) => logger.debug(message, meta),
    info: (message, meta) => logger.info(message, meta),
    warn: (message, meta) => logger.warn(message, meta),
    error: (message, meta) => logger.error(message, meta),
  },
  logFields: () => runFields(),
  models: {
    anthropicChat: (options) => anthropicChat(options),
    anthropicChatStructured: (options) => anthropicChatStructured(options),
    anthropicWebChat: (options) => anthropicWebChat(options),
  },
  searchProvider: () => resolveWebSearchProvider(),
  search: (query) => WebSearchService.search(query),
  findLinkedIn: (input) => WebSearchService.findLinkedIn(input),
  scrape: (url) => ScraperService.getWebsite(url, { provider: 'brightdata' }),
  missingScraperSettings: () => missingBrightDataVars(),
  get profiles() {
    return services.linkedin;
  },
  isDocumentSource: (url) => DocumentSourceService.isSupportedUrl(url),
  async fetchResource(url, email, password) {
    const fetched = password === undefined ? await fetchWithTimeout(url, email) : await fetchWithTimeout(url, email, password);
    return fetched === null ? null : { url: fetched.url, content: fetched.content, file: fetched.documentId };
  },
  fileValues: (handles) => storedDocumentFiles(handles),
};

/**
 * Stored documents by id, as file values. The loads go through the document
 * service's batching loader, so several ids are one query. A document that
 * can no longer be found is undefined: its record keeps its text and drops
 * the file.
 */
async function storedDocumentFiles(ids: readonly unknown[]): Promise<Array<FileRef | undefined>> {
  const loaded = await Promise.allSettled(
    ids.map((id) => (typeof id === 'string' ? DocumentService.getById(id) : Promise.reject(new Error('not a document id')))),
  );
  return loaded.map((result, i) => {
    if (result.status === 'fulfilled') {
      return documentStoreFileRef({ objectUri: result.value.objectUri, name: result.value.description });
    }
    logger.warn('[movement:transform] stored document not found — its file is dropped', {
      documentId: ids[i],
      error: result.reason,
      ...runFields(),
    });
    return undefined;
  });
}

/** A plugin's legacy line: its `@lf/web` body run with the platform's tools,
 *  registered in the transform registry under its declaration. */
export function legacyImpl(plugin: WebPlugin): TransformImpl {
  return { ...implementing(plugin.declaration), run: (input) => runWebPlugin(plugin, input, hostedWebTools) };
}

/** A function of `@lf/web` run with the platform's tools (the dev scripts and
 *  the comparison harness call the research engines directly). */
export function hosted<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args) => withTools(hostedWebTools, () => fn(...args));
}
