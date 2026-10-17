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
// (`./fetch_resource`) — the gated-document path, the profile path, and the
// plain scrape are the same work once something has chosen a URL.

import type { PluginManifest, TransformImpl, TransformOutput } from './registry';

import { runFields } from '../../../../lib/llm_usage';
import { logger } from 'movement-engine/services/logger';
import { emissionOf, fetchWithTimeout, normaliseUrl } from './fetch_resource';
import { FETCH_URL_HANDBOOK_SECTION } from './fetch_url_handbook_section';
import { importIdentifier } from 'movement-engine/services/translation_graph/movement/schema_projection';
import { implementing } from './registry';
import { FETCH_URL_PLUGIN } from 'movement-engine/public/plugins';

export const FETCH_URL_PLUGIN_MANIFEST: PluginManifest = {
  pluginName: FETCH_URL_PLUGIN.signature.name,
  importName: importIdentifier(FETCH_URL_PLUGIN.signature.name),
  displayName: 'Fetch a page',
  description:
    'Loads the one link you give it — a company site, a shared document — and ' +
    'hands its content to the rest of the extraction. Point it at a field a ' +
    'record already carries and each record loads its own page.',
  params: FETCH_URL_PLUGIN.signature.params,
  contextAdditions:
    'Adds one fetched page to the record it runs on — the link, a name, the ' +
    'downloaded file, and the extracted text.',
  additions: FETCH_URL_PLUGIN.signature.additions,
  handbookSection: FETCH_URL_HANDBOOK_SECTION,
};

// ── Public run ────────────────────────────────────────────────────────────

export const fetchUrlImpl: TransformImpl = {
  ...implementing(FETCH_URL_PLUGIN),
  run: async (input): Promise<TransformOutput> => {
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
    const fetched = await fetchWithTimeout(url, email, password);
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
