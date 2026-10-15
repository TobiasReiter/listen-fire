// vc-url-retrieval — pre-extraction transform.
//
// Discovers fetchable URLs in the source node's content (typically a
// message body), classifies them, and fetches their content. Each
// successful fetch becomes an ephemeral `vcUrl` edge from the source
// node to a record `{ name, url, file, text }`.
//
// Behavioural parity is against the legacy plugin
// `runVcUrlRetrieval` in `apps/api/src/services/knowledge_pipeline/plugins.ts`.
// We deliberately do *not* import from the legacy module (the new
// runtime owns its own URL-retrieval surface); the helpers below
// mirror the legacy implementation closely enough that the URL
// discovery set, classification verdicts, and fetched-resource set are
// identical given identical inputs.
//
//   (#transform — transforms add ephemeral nodes to the source graph)

import type { TransformImpl, TransformOutput, EphemeralEmission } from './registry';
import type { PluginManifest } from './registry';
import type { TransformSignature } from 'movement-engine/services/translation_graph/types';

import { anthropicChat } from '../../../../lib/anthropic';
import { runFields } from '../../../../lib/llm_usage';
import { parseJson } from 'movement-engine/lib/utils/parse_json';
import { logger } from 'movement-engine/services/logger';
import { emissionOf, fetchWithTimeout } from './fetch_resource';
import { VC_URL_RETRIEVAL_HANDBOOK_SECTION } from './vc_url_retrieval_handbook_section';
import { importIdentifier } from 'movement-engine/services/translation_graph/movement/schema_projection';

// ── Signature ─────────────────────────────────────────────────────────────

/**
 * Public signature — surfaced through the registry. The editor uses
 * `additions.edges.vcUrl` to power downstream traversal autocomplete:
 * `(msg)-[urls:#transform { plugin: "vc-url-retrieval" }]->(:Url)` then
 * `urls.name / urls.url / urls.file / urls.text` resolves at extract
 * time.
 *
 * `params.text` is what the transform scans for URLs. One parameter, two ways
 * of being filled: inside a `through [ … ]` stage the engine populates it from
 * the extract source, so the author writes `through [vc_url_retrieval]` and
 * nothing else; called plainly there is no extraction to fill it, so the
 * caller writes `vc_url_retrieval(text: …)` themselves.
 *
 * `params.email` is author-supplied: the email to type into an
 * email-gated link (DocSend, a data room, …) if fetching one requires
 * it. No implicit guessing — a run with no email simply can't get past
 * a gate and that URL is skipped, not silently mistyped.
 */
export const VC_URL_RETRIEVAL_SIGNATURE: TransformSignature = {
  name: 'vc-url-retrieval',
  description:
    'Discover, classify, and fetch URLs in a message. Emits one ephemeral Url record per fetched resource.',
  params: [
    {
      name: 'text',
      type: { kind: 'string' },
      required: true,
      // Engine-injected INSIDE A STAGE, from the extract source — the author
      // writes `through [vc_url_retrieval]` with no argument, and a stage that
      // wrote one would be overriding what it is there to receive. A plain call
      // has no stage behind it, so it writes this itself.
      auto: true,
      description: 'The text to scan for URLs. Inside a stage the extraction supplies it.',
    },
    {
      name: 'email',
      type: { kind: 'string' },
      description:
        'The email to type into an email-gated link (DocSend, a data room, …) if one of the ' +
        'discovered URLs needs it to view. Usually @user_email — @actor_email if the link was ' +
        'shared with the original sender rather than the team.',
    },
  ],
  dataDependency: 'none',
  // What it does, declared: it fetches the pages it discovers, and it asks a
  // model to classify each one (`classifyUrl`). Nothing else — it writes
  // nowhere, reads no clock, and never parks.
  effects: { reads: ['the web'], ai: true },
  additions: {
    edges: {
      vcUrl: {
        target: {
          kind: 'list',
          element: {
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
  },
  // One record per link it fetched, in the order it found them — a message can
  // carry several decks, and each keeps its own link, file and text. An empty
  // list when there was no link worth following. `file` is there only when the
  // link was a document it could store; `text` only when it could read some.
  output: {
    kind: 'records',
    fields: {
      name: { type: { kind: 'string' }, description: 'What the fetched page is called.' },
      url: { type: { kind: 'string' }, description: 'The link it followed.' },
      file: {
        type: { kind: 'file' },
        optional: true,
        description: 'The downloaded document, when the link was one.',
      },
      text: {
        type: { kind: 'string' },
        optional: true,
        description: 'The text read out of the page or document.',
      },
    },
    description: 'Every link it fetched, one record each. Empty when there was no link worth following.',
    // Language version 1: every page it fetched as one text.
    previously: [
      {
        before: 2,
        output: {
          kind: 'value',
          type: { kind: 'string' },
          optional: true,
          description:
            'The text of every page it fetched, run together. Nothing when there was no link '
            + 'worth following.',
        },
      },
    ],
  },
};

/**
 * Static manifest — the catalogue-facing declaration, registered alongside
 * the impl (see `./register-bundled.ts`). `params`/`additions` reference the
 * signature so they can't drift; `importName` is the identifier-safe name a
 * movement writes: `import { vc_url_retrieval } from plugins`.
 */
export const VC_URL_RETRIEVAL_PLUGIN_MANIFEST: PluginManifest = {
  pluginName: VC_URL_RETRIEVAL_SIGNATURE.name,
  importName: importIdentifier(VC_URL_RETRIEVAL_SIGNATURE.name),
  displayName: 'URL retrieval',
  description:
    'Finds links in a piece of text — a pitch deck link, a data room, a ' +
    'company site — works out what each one is, and fetches its content so ' +
    'the rest of the movement can read it.',
  params: VC_URL_RETRIEVAL_SIGNATURE.params,
  contextAdditions:
    'Adds a list of fetched pages to the record it runs on — each with the ' +
    'link, a name, the downloaded file, and the extracted text.',
  additions: VC_URL_RETRIEVAL_SIGNATURE.additions,
  handbookSection: VC_URL_RETRIEVAL_HANDBOOK_SECTION,
};

// ── Internals (mirror of legacy plugin helpers; see file header) ──────────

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;
const URL_CONTEXT_WINDOW = 500;

// A message often names a site as a bare domain — "founder of gondor.fi",
// "see acme.com" — with no scheme, which the scheme-anchored URL_REGEX
// misses entirely. We treat a bare `domain.tld` as a candidate only when
// the TLD is one of a curated set: common enough that this fires on real
// sites without matching "e.g.", "report.pdf", or "socket.io" noise for
// every dotted token. The classifier still vets each candidate before any
// fetch, so a stray match costs one classify call, never a bad fetch.
const BARE_DOMAIN_TLDS = [
  'com', 'org', 'net', 'io', 'ai', 'co', 'dev', 'app', 'xyz', 'me', 'tech',
  'vc', 'fund', 'capital', 'ventures', 'fi', 'uk', 'us', 'eu', 'de', 'fr',
  'nl', 'se', 'gg', 'sh', 'so', 'health', 'bio', 'finance', 'studio',
];
const BARE_DOMAIN_REGEX = new RegExp(
  String.raw`(?<![\w@./])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:` +
    BARE_DOMAIN_TLDS.join('|') +
    String.raw`))(?![\w@])(/[^\s<>"')\]]*)?`,
  'gi',
);

/** Bare `domain.tld` mentions (no scheme), normalised to https URLs.
 *  Scheme'd URLs and email addresses are blanked first so their host
 *  portions aren't re-matched as standalone domains. */
function extractBareDomains(text: string): string[] {
  const stripped = text
    .replace(URL_REGEX, ' ')
    .replace(/[^\s<>"')\]]+@[^\s<>"')\]]+/g, ' ');
  const out: string[] = [];
  for (const match of stripped.matchAll(BARE_DOMAIN_REGEX)) {
    out.push(`https://${match[1].toLowerCase()}${stripSentencePunctuation(match[2] ?? '')}`);
  }
  return out;
}

/** A link at the end of a sentence or clause ("see https://x.notion.site/abc.")
 *  picks up the punctuation that follows it. Stripped here, where links are
 *  found in prose, rather than in the generic sanitizer, so a URL passed
 *  explicitly to fetch-url that genuinely ends in one is left alone. */
function stripSentencePunctuation(url: string): string {
  return url.replace(/[.,;]+$/, '');
}

type UrlClassification =
  | 'pitch_deck'
  | 'document'
  | 'company_website'
  | 'profile'
  | 'article'
  | 'tracking_pixel'
  | 'unsubscribe'
  | 'calendar'
  | 'image'
  | 'irrelevant';

const FETCHABLE_URL_TYPES = new Set<UrlClassification>([
  'pitch_deck',
  'document',
  'company_website',
  'profile',
  'article',
]);

interface ClassifiedUrl {
  url: string;
  type: UrlClassification;
  password: string | null;
}

interface DiscoveredUrl {
  url: string;
  password: string | null;
  type: UrlClassification;
}

export function _extractCandidateUrls(text: string): string[] {
  const cleaned = text.replace(/<(https?:\/\/[^>|]+)(?:\|[^>]*)?>/g, '$1');
  const schemed = (cleaned.match(URL_REGEX) ?? []).map(stripSentencePunctuation);
  return [...new Set([...schemed, ...extractBareDomains(cleaned)])];
}

function isHighSurrogate(code: number): boolean { return code >= 0xD800 && code <= 0xDBFF; }
function isLowSurrogate(code: number): boolean { return code >= 0xDC00 && code <= 0xDFFF; }

export function _extractLocalContext(text: string, url: string): string {
  let idx = text.indexOf(url);
  if (idx === -1) {
    const domainMatch = url.match(/https?:\/\/([^/]+)/);
    if (domainMatch) idx = text.indexOf(domainMatch[1]);
  }
  if (idx === -1) return '';
  let start = Math.max(0, idx - URL_CONTEXT_WINDOW);
  let end = Math.min(text.length, idx + url.length + URL_CONTEXT_WINDOW);
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start--;
  if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end++;
  return text.slice(start, end);
}

export async function _classifyUrl(url: string, context: string): Promise<ClassifiedUrl> {
  const raw = await anthropicChat({
    system: `Classify a URL based on its surrounding context in an email/message.

Return JSON: { "type": "<type>", "password": "<password or null>" }

## Types

- "pitch_deck" — links to pitch decks, presentations, slide decks (Docsend, Papermark, Google Slides, .pdf/.pptx links described as decks)
- "document" — shared documents, data rooms, file-sharing links (Google Drive, Dropbox, Notion) that aren't pitch decks
- "company_website" — company homepages, landing pages, product pages
- "profile" — social media profiles (LinkedIn, Twitter, etc.)
- "article" — news articles, blog posts, investor updates
- "tracking_pixel" — 1x1 images, beacons, email open trackers, analytics pixels. Look for: img tags with tiny dimensions, display:none, alt="beacon"/"pixel", or URLs in hidden image elements
- "unsubscribe" — opt-out links, email preference management, "manage subscription" links
- "calendar" — scheduling links (Calendly, cal.com, meeting invites)
- "image" — visible images, logos, banners (.gif/.png/.jpg that aren't tracking pixels)
- "irrelevant" — anything else not worth fetching

## Password extraction

If the context mentions a password, passcode, or access code near this URL, extract it. Formats include "Password: X", "pw X", "passcode is X", "code: X". Strip any formatting markers. If none, return null.

## Rules

Classify based on what the CONTEXT tells you the link contains, not just the URL structure. A tracking redirect URL wrapping a pitch deck (context says "deck attached") is a "pitch_deck". The same redirect domain used as a hidden img src is a "tracking_pixel". Context is authoritative.`,
    userMessage: `URL: ${url}\n\nContext:\n${context}`,
    model: 'claude-haiku-4-5-20251001',
    label: 'knowledge_plugin_url_classify',
  });

  try {
    const parsed = parseJson(raw) as { type: string; password?: string | null };
    return {
      url,
      type: (parsed.type ?? 'irrelevant') as UrlClassification,
      password: parsed.password ?? null,
    };
  } catch {
    logger.warn('[transform:vc-url-retrieval] Failed to parse LLM classify response', { url });
    return { url, type: 'irrelevant', password: null };
  }
}

async function discoverUrls(text: string): Promise<DiscoveredUrl[]> {
  const candidates = _extractCandidateUrls(text);
  if (candidates.length === 0) return [];

  const classified = await Promise.all(
    candidates.map((url) => _classifyUrl(url, _extractLocalContext(text, url))),
  );

  return classified
    .filter((c) => FETCHABLE_URL_TYPES.has(c.type))
    .map((c) => ({ url: c.url, password: c.password, type: c.type }));
}

// ── Public run ────────────────────────────────────────────────────────────

export const vcUrlRetrievalImpl: TransformImpl = {
  signature: VC_URL_RETRIEVAL_SIGNATURE,
  // Every fetch, search and model call it makes is paid for.
  priced: true,
  run: async (input): Promise<TransformOutput> => {
    if (input.kind !== 'pre-extraction') {
      // Defensive: dataDependency: 'none' should always be invoked with
      // a pre-extraction input. If a wrapper ever flips the timing, fail
      // loudly rather than silently producing the wrong shape.
      throw new Error(
        `vc-url-retrieval: expected pre-extraction input, got ${input.kind}`,
      );
    }

    const content = typeof input.config.text === 'string' ? input.config.text : '';
    if (!content) {
      logger.debug('[transform:vc-url-retrieval] No content in config');
      return {};
    }
    const email = typeof input.config.email === 'string' && input.config.email ? input.config.email : null;

    logger.debug('[transform:vc-url-retrieval] Starting', { contentLength: content.length });

    const discovered = await discoverUrls(content);
    if (discovered.length === 0) {
      logger.info('[transform:vc-url-retrieval] No fetchable URLs in the source', {
        contentLength: content.length,
        ...runFields(),
      });
      return {};
    }

    const run = runFields();
    logger.info('[transform:vc-url-retrieval] Fetching discovered URLs', {
      urls: discovered.map((d) => d.url),
      ...run,
    });

    // Every URL races the same seven-minute backstop, in parallel — so the
    // whole scan can take as long as its slowest page, and the run record has
    // to be able to say which page that was.
    const started = Date.now();
    const results = await Promise.allSettled(
      discovered.map((d) => fetchWithTimeout(d.url, email, d.password)),
    );

    const emissions: EphemeralEmission[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled' && result.value) {
        emissions.push(emissionOf(result.value));
      } else if (result.status === 'rejected') {
        logger.warn('[transform:vc-url-retrieval] Fetch rejected', {
          url: discovered[i].url,
          error: result.reason,
          ...run,
        });
      }
    }

    if (emissions.length === 0) return {};

    logger.info('[transform:vc-url-retrieval] Fetched resources', {
      count: emissions.length,
      urls: emissions.map((e) => (e.data as { url: string }).url),
      durationMs: Date.now() - started,
      ...run,
    });

    return { edges: { vcUrl: emissions } };
  },
};
