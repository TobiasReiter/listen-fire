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
import type { TransformSignature } from 'movement-engine/services/translation_graph/types';

import { runFields } from '../../../../lib/llm_usage';
import { logger } from 'movement-engine/services/logger';
import { emissionOf, fetchWithTimeout, normaliseUrl } from './fetch_resource';
import { FETCH_URL_HANDBOOK_SECTION } from './fetch_url_handbook_section';
import { importIdentifier } from 'movement-engine/services/translation_graph/movement/schema_projection';

// ── Signature ─────────────────────────────────────────────────────────────

/**
 * `params.url` is required and author-supplied. It is normally a field an
 * earlier stage extracted (`fetch_url(url: website)`), which is what makes a
 * per-record stage load a per-record page. A required argument that resolves
 * absent skips the invocation at the stage boundary (see
 * `movement_engine/extraction.ts`), so a record whose website came back empty
 * simply gets no enrichment — this implementation never sees a blank url.
 *
 * `params.email` / `params.password` are the credentials a gated link
 * (DocSend, a data room, …) demands before it will show its content. They
 * reach only the gated-document path; a plain web page and a profile page
 * ignore both.
 */
export const FETCH_URL_SIGNATURE: TransformSignature = {
  name: 'fetch-url',
  description:
    'Fetch one named URL and hand back its content. Emits a single ephemeral Url record.',
  params: [
    {
      name: 'url',
      type: { kind: 'string' },
      required: true,
      description:
        'The link to load. Normally a field an earlier stage extracted, so each record loads ' +
        'its own page. A bare host is read as an https address.',
    },
    {
      name: 'email',
      type: { kind: 'string' },
      description:
        'The email to type into a link that is gated behind one (DocSend, a data room, …). ' +
        'Usually @user_email — @actor_email if the link was shared with the original sender ' +
        'rather than the team. Ignored by a link that has no gate.',
    },
    {
      name: 'password',
      type: { kind: 'string' },
      description:
        'The passcode to type into a gated link alongside the email. Ignored by a link that ' +
        'has no gate.',
    },
  ],
  // The url it loads comes from the fields the enclosing extract has produced,
  // so it is a stage of an extraction and only makes sense as one.
  dataDependency: 'extracted_context',
  // What it does, declared: it fetches one page. No model is consulted —
  // the author already said which link this is.
  effects: { reads: ['the web'] },
  additions: {
    edges: {
      fetchedUrl: {
        target: {
          kind: 'record',
          fields: {
            name: { kind: 'string' },
            url: { kind: 'string' },
            file: { kind: 'file' },
            text: { kind: 'string' },
          },
        },
      },
    },
  },
  // Called plainly, what it hands back is the page's text — and nothing, when
  // the load failed or the page was empty. One value: the other three things on
  // the edge (the name, the url, the file) are what an EXTRACTOR reads, and a
  // caller who wanted the url already has it, because they passed it.
  output: {
    kind: 'value',
    type: { kind: 'string' },
    optional: true,
    description: "The page's text. Nothing when the load failed or the page was empty.",
  },
};

export const FETCH_URL_PLUGIN_MANIFEST: PluginManifest = {
  pluginName: FETCH_URL_SIGNATURE.name,
  importName: importIdentifier(FETCH_URL_SIGNATURE.name),
  displayName: 'Fetch a page',
  description:
    'Loads the one link you give it — a company site, a shared document — and ' +
    'hands its content to the rest of the extraction. Point it at a field a ' +
    'record already carries and each record loads its own page.',
  params: FETCH_URL_SIGNATURE.params,
  contextAdditions:
    'Adds one fetched page to the record it runs on — the link, a name, the ' +
    'downloaded file, and the extracted text.',
  additions: FETCH_URL_SIGNATURE.additions,
  handbookSection: FETCH_URL_HANDBOOK_SECTION,
};

// ── Public run ────────────────────────────────────────────────────────────

export const fetchUrlImpl: TransformImpl = {
  signature: FETCH_URL_SIGNATURE,
  // Every fetch, search and model call it makes is paid for.
  priced: true,
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
