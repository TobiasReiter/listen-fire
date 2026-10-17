// fetch-url — the targeted half of URL retrieval.
//
// `vc-url-retrieval` reads a whole message and decides for itself what is
// worth fetching. This one fetches exactly the link it is given, so a stage
// behind a record's fields loads THAT record's page and nothing else. The
// two are separate surfaces on purpose: a scan whose target is optional and
// a load whose target is required are different contracts, and one plugin
// carrying both would have to guess which one the author meant.
//
// The per-URL fetch itself is shared with the scanning plugin
// (its host's `fetchResource`) — the gated-document path, the profile path, and the
// plain scrape are the same work once something has chosen a URL.

import type { PluginOutput, WebPlugin } from './plugin';

import { FETCH_URL_PLUGIN } from 'movement-engine/public/plugins';
import { emissionOf, normaliseUrl } from './addresses';
import { logger, runFields, tools } from './tools';


// ── Public run ────────────────────────────────────────────────────────────

export const fetchUrlPlugin: WebPlugin = {
  declaration: FETCH_URL_PLUGIN,
  run: async (input): Promise<PluginOutput> => {
    if (input.kind !== 'context-dependent') {
      throw new Error(`fetch-url: expected context-dependent input, got ${input.kind}`);
    }

    const url = normaliseUrl(input.config.url);
    if (!url) {
      // Belt and braces: the stage boundary skips an absent required argument
      // before it gets here, so reaching this is a wiring fault, not a data one.
      logger.warn('[transform:fetch-url] No url to load — nothing fetched', {
        value: typeof input.config.url,
        ...runFields(),
      });
      return {};
    }

    const email = typeof input.config.email === 'string' && input.config.email
      ? input.config.email
      : null;
    const password = typeof input.config.password === 'string' && input.config.password
      ? input.config.password
      : null;

    const run = runFields();
    logger.info('[transform:fetch-url] Fetching', { url, gated: email !== null, ...run });

    // A fetch is the longest thing a movement does — long enough that the
    // question asked of these lines afterwards is "how long", not "whether".
    const started = Date.now();
    const fetched = await tools().fetchResource(url, email, password);
    if (!fetched) {
      logger.info('[transform:fetch-url] Nothing came back', {
        url,
        durationMs: Date.now() - started,
        ...run,
      });
      // A failed load and an empty page attached the same nothing, so the run's
      // trace read `empty` for both. Say which this was.
      return { outcome: 'fetch_failed' };
    }

    logger.info('[transform:fetch-url] Fetched', {
      url,
      chars: fetched.content.length,
      durationMs: Date.now() - started,
      ...run,
    });
    return { edges: { fetchedUrl: emissionOf(fetched) }, outcome: 'fetched' };
  },
};
