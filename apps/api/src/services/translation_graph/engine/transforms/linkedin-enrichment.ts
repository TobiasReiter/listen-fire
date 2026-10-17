// linkedin-enrichment on this platform: its catalogue manifest (the Plugins page, the
// handbook) and its legacy line — the `@lf/web` body run with the platform's
// own tools, through the transform registry. Which line a run takes is
// BUILTIN_MODULES'.

import type { PluginManifest, TransformImpl } from './registry';

import { linkedinEnrichmentPlugin } from '@lf/web';
import { importIdentifier } from 'movement-engine/services/translation_graph/movement/schema_projection';
import { LINKEDIN_ENRICHMENT_PLUGIN } from 'movement-engine/public/plugins';
import { legacyImpl } from './hosted_tools';

/**
 * Static manifest — the catalogue-facing declaration, registered alongside
 * the impl (see `./register-bundled.ts`). `params`/`additions` reference the
 * signature so they can't drift; `importName` is the identifier-safe name a
 * movement writes: `import { linkedin_enrichment } from plugins`.
 */
export const LINKEDIN_ENRICHMENT_PLUGIN_MANIFEST: PluginManifest = {
  pluginName: LINKEDIN_ENRICHMENT_PLUGIN.signature.name,
  importName: importIdentifier(LINKEDIN_ENRICHMENT_PLUGIN.signature.name),
  displayName: 'LinkedIn lookup',
  description:
    'For a person you have just extracted, finds their LinkedIn profile and ' +
    'attaches the address and the page. Searches the web for the profile ' +
    'unless the person already carries its address, which it reads instead.',
  params: LINKEDIN_ENRICHMENT_PLUGIN.signature.params,
  contextAdditions:
    'Adds two fields to the record it runs on: the LinkedIn profile address ' +
    'it found, and the text of that profile page (both left empty when no ' +
    'confident match exists).',
  additions: LINKEDIN_ENRICHMENT_PLUGIN.signature.additions,
  // No handbook section yet: it is callable only from language version 5
  // (`linkedinEnrichment(record)`), and the handbook documents only the forms
  // to write. `research` resolves a person's profile address from a name.
};

export const linkedinEnrichmentImpl: TransformImpl = legacyImpl(linkedinEnrichmentPlugin);
