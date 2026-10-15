// linkedin-enrichment — context-dependent transform.
//
// Reads the enclosing `#extract`'s extracted context — the person's own
// fields plus any ancestor context nested under the ancestor node's name
// (e.g. `company`) — and identifies the person via LLM (own fields and
// organisation context kept separate so company prose can't swamp the name)
// then searches the web for their profile. Emits two properties on the source
// node: `linkedin_url` and `linkedin_profile` (the profile page text, for a
// later stage to summarise).
//
// What the plugin is for is the profile CONTENT, so that is what it tests
// before deciding it has nothing to do. A person whose fields already carry a
// profile address but no profile text is not done: the address just spares the
// search, and the page still has to be read.
//
// Behavioural parity is against the legacy plugin
// `runLinkedInEnrichment` in `apps/api/src/services/knowledge_pipeline/plugins.ts`.
// As with `vc-url-retrieval`, we mirror the legacy logic here rather
// than importing the legacy module — the new runtime is the production
// surface and must own its dependencies.

import type { PersonContext, ResolvedField } from './extracted_fields';
import type { TransformImpl, TransformOutput } from './registry';
import type { PluginManifest } from './registry';
import type { TransformSignature } from 'movement-engine/services/translation_graph/types';

import { services } from '../../../../adapters/registry';
import { anthropicChat } from '../../../../lib/anthropic';
import { parseJson } from 'movement-engine/lib/utils/parse_json';
import { runFields } from '../../../../lib/llm_usage';
import { logger } from 'movement-engine/services/logger';
import { WebSearchService, resolveWebSearchProvider } from '../../../web_search';
import { resolvePersonContext } from './extracted_fields';
import { importIdentifier } from 'movement-engine/services/translation_graph/movement/schema_projection';


// ── Signature ─────────────────────────────────────────────────────────────

/**
 * Public signature — surfaced through the registry.
 *
 * `extractedContext` is consumed at runtime (not declared as a param);
 * the engine threads it through from the enclosing `#extract`. The
 * transform expects an object whose values are label/value pairs
 * describing the person — e.g. `{ name: { label, value }, … }` — but
 * also handles the flat `{ label: value }` shape the legacy plugin
 * worked with.
 */
export const LINKEDIN_ENRICHMENT_SIGNATURE: TransformSignature = {
  name: 'linkedin-enrichment',
  description:
    'For an identified person without a LinkedIn profile, find their profile — searching the web for it unless the person already carries the address — and attach the profile URL and page content.',
  params: [],
  dataDependency: 'extracted_context',
  // Searches for a profile and fetches the page, and asks a model whether the
  // result is the right person.
  effects: { reads: ['the web'], ai: true },
  additions: {
    properties: {
      linkedin_url: { kind: 'string' },
      linkedin_profile: { kind: 'string' },
    },
  },
};

/**
 * Static manifest — the catalogue-facing declaration, registered alongside
 * the impl (see `./register-bundled.ts`). `params`/`additions` reference the
 * signature so they can't drift; `importName` is the identifier-safe name a
 * movement writes: `import { linkedin_enrichment } from plugins`.
 */
export const LINKEDIN_ENRICHMENT_PLUGIN_MANIFEST: PluginManifest = {
  pluginName: LINKEDIN_ENRICHMENT_SIGNATURE.name,
  importName: importIdentifier(LINKEDIN_ENRICHMENT_SIGNATURE.name),
  displayName: 'LinkedIn lookup',
  description:
    'For a person you have just extracted, finds their LinkedIn profile and ' +
    'attaches the address and the page. Searches the web for the profile ' +
    'unless the person already carries its address, which it reads instead.',
  params: LINKEDIN_ENRICHMENT_SIGNATURE.params,
  contextAdditions:
    'Adds two fields to the record it runs on: the LinkedIn profile address ' +
    'it found, and the text of that profile page (both left empty when no ' +
    'confident match exists).',
  additions: LINKEDIN_ENRICHMENT_SIGNATURE.additions,
  // No handbook section: it declares no output, so it runs only as a `through`
  // stage of the extraction keyword, and the handbook documents only the forms
  // to write. `research` resolves a person's profile address from a name.
};

// ── Internals ─────────────────────────────────────────────────────────────

const LINKEDIN_PROFILE_REGEX =
  /^(?:http(?:s)?:\/\/)?(?:[\w]+\.)?linkedin\.com\/(?:pub|in|profile)\/([\w-]+)/i;

/**
 * Scan the person's own fields for an already-present LinkedIn URL. Ancestor
 * context is ignored — a company's LinkedIn is not the person's. An address in
 * hand spares the search; it does not mean the page has been read.
 */
function findExistingLinkedInUrl(fields: ResolvedField[]): string | null {
  for (const f of fields) {
    if (LINKEDIN_PROFILE_REGEX.test(f.value)) return f.value;
  }
  return null;
}

/** The plugin's own profile field, however the surrounding record spells it —
 *  `linkedin_profile`, `LinkedIn profile`, `linkedinProfile`. */
function isProfileFieldName(name: string): boolean {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '') === 'linkedinprofile';
}

/**
 * The profile page text, if some earlier pass already attached it. This is the
 * only thing that makes the plugin a no-op: it exists to produce profile
 * content, so content is what "already done" means. A profile field holding
 * nothing but the address is the address, not the page.
 */
function findExistingProfileText(fields: ResolvedField[]): string | null {
  for (const f of fields) {
    if (!isProfileFieldName(f.key) && !isProfileFieldName(f.label)) continue;
    const value = f.value.trim();
    if (!value || LINKEDIN_PROFILE_REGEX.test(value)) continue;
    return value;
  }
  return null;
}

interface PersonIdentity {
  name: string;
  company: string | null;
  description: string | null;
}

async function identifyPerson(context: PersonContext): Promise<PersonIdentity | null> {
  const ownSummary = context.own.map((f) => `${f.label}: ${f.value}`).join('\n');
  const ancestorSummary = context.ancestors
    .map((a) => `${a.label}:\n${a.fields.map((f) => `  ${f.label}: ${f.value}`).join('\n')}`)
    .join('\n\n');

  // Present the person's own fields and the organisation context separately,
  // so a verbose company description can't be mistaken for the person.
  const userMessage = ancestorSummary
    ? `The person's own fields:\n${ownSummary}\n\nContext about their organisation (background for disambiguation — this is NOT the person):\n${ancestorSummary}`
    : ownSummary;

  const raw = await anthropicChat({
    system: `You are identifying a PERSON. You are given the person's own extracted fields, and optionally context about their organisation. Return JSON with:
- "name": the person's full name, taken from the person's OWN fields (required — return null only if the person's own fields carry no name). Never return the organisation's name as the person's name.
- "company": the organisation most associated with this person — use the organisation context when present (optional, null if unknown)
- "description": a terse summary of distinguishing info about the PERSON — role/title, previous companies, location, domain expertise — to help find their LinkedIn (optional, null if nothing useful)

Return ONLY valid JSON, no markdown.`,
    userMessage,
    model: 'claude-haiku-4-5-20251001',
    label: 'knowledge_plugin_linkedin_identify',
  });

  let parsed: { name?: string | null; company?: string | null; description?: string | null };
  try {
    parsed = parseJson(raw) as typeof parsed;
  } catch {
    logger.warn('[transform:linkedin-enrichment] Failed to parse identify response', {
      raw,
      ...runFields(),
    });
    return null;
  }

  if (!parsed.name) return null;
  return {
    name: parsed.name,
    company: parsed.company ?? null,
    description: parsed.description ?? null,
  };
}

// ── Public run ────────────────────────────────────────────────────────────

export const linkedinEnrichmentImpl: TransformImpl = {
  signature: LINKEDIN_ENRICHMENT_SIGNATURE,
  // Every fetch, search and model call it makes is paid for.
  priced: true,
  run: async (input): Promise<TransformOutput> => {
    if (input.kind !== 'context-dependent') {
      throw new Error(
        `linkedin-enrichment: expected context-dependent input, got ${input.kind}`,
      );
    }

    const context = resolvePersonContext(input.extractedContext);
    if (context.own.length === 0) {
      logger.info('[transform:linkedin-enrichment] No person fields to identify from', runFields());
      return {};
    }

    const existingProfile = findExistingProfileText(context.own);
    if (existingProfile) {
      logger.info('[transform:linkedin-enrichment] Profile content already present — skipping', {
        profileChars: existingProfile.length,
        ...runFields(),
      });
      return {};
    }

    // The address is known but nobody has read the page. Skip the search, not
    // the lookup.
    const existingUrl = findExistingLinkedInUrl(context.own);
    if (existingUrl) {
      logger.info('[transform:linkedin-enrichment] LinkedIn URL already present — reading it', {
        url: existingUrl,
        ...runFields(),
      });
      const profileText = await fetchProfileText(existingUrl);
      if (!profileText) return {};
      return { properties: { linkedin_url: existingUrl, linkedin_profile: profileText } };
    }

    const identity = await identifyPerson(context);
    if (!identity) {
      logger.info('[transform:linkedin-enrichment] Could not identify a person from the fields', {
        fields: context.own.map((f) => f.label),
        ...runFields(),
      });
      return {};
    }

    logger.info('[transform:linkedin-enrichment] Identified person — searching the web', {
      ...identity,
      webSearchProvider: resolveWebSearchProvider(),
      googleSearchConfigured:
        !!process.env.GOOGLE_CUSTOM_SEARCH_API_KEY && !!process.env.GOOGLE_CX,
      linkedinReaderConfigured: !!services.linkedin,
      ...runFields(),
    });

    let searchResults: Awaited<ReturnType<typeof WebSearchService.findLinkedIn>>;
    try {
      searchResults = await WebSearchService.findLinkedIn({
        name: identity.name,
        company: identity.company,
        description: identity.description,
      });
    } catch (error) {
      logger.warn('[transform:linkedin-enrichment] Web search failed — the enrichment cannot run', {
        name: identity.name,
        error: error instanceof Error ? error.message : String(error),
        ...runFields(),
      });
      return {};
    }

    const linkedInUrl = searchResults[0]?.link;
    if (!linkedInUrl) {
      logger.info('[transform:linkedin-enrichment] No matching LinkedIn profile found', {
        name: identity.name,
        ...runFields(),
      });
      return {};
    }

    const profileText = await fetchProfileText(linkedInUrl);

    logger.info('[transform:linkedin-enrichment] Found profile', {
      personName: identity.name,
      linkedInUrl,
      profileChars: profileText?.length ?? 0,
      ...runFields(),
    });

    return {
      properties: {
        linkedin_url: linkedInUrl,
        ...(profileText ? { linkedin_profile: profileText } : {}),
      },
    };
  },
};

/** Fetch the text of a LinkedIn profile page for the discovered URL, so a
 *  later extraction stage can summarise it. Returns null (URL only) when
 *  the profile can't be read — the enrichment stays best-effort. */
async function fetchProfileText(linkedInUrl: string): Promise<string | null> {
  try {
    const profile = await services.linkedin?.getProfileTextByUrl(linkedInUrl);
    const text = profile?.text;
    return text && text.trim() ? text : null;
  } catch (error) {
    logger.warn('[transform:linkedin-enrichment] Failed to fetch profile content', {
      url: linkedInUrl,
      error,
      ...runFields(),
    });
    return null;
  }
}
