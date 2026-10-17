// linkedin-research on this platform: its catalogue manifest (the Plugins page, the
// handbook) and its legacy line — the `@lf/web` body run with the platform's
// own tools, through the transform registry. Which line a run takes is
// BUILTIN_MODULES'.

import type { PluginManifest, TransformImpl } from './registry';

import { LINKEDIN_RESEARCH_HANDBOOK_SECTION } from './linkedin_research_handbook_section';
import { linkedinResearchPlugin } from '@lf/web';
import { importIdentifier } from 'movement-engine/services/translation_graph/movement/schema_projection';
import { LINKEDIN_RESEARCH_PLUGIN } from 'movement-engine/public/plugins';
import { legacyImpl } from './hosted_tools';

export const LINKEDIN_RESEARCH_PLUGIN_MANIFEST: PluginManifest = {
  pluginName: LINKEDIN_RESEARCH_PLUGIN.signature.name,
  importName: importIdentifier(LINKEDIN_RESEARCH_PLUGIN.signature.name),
  displayName: 'LinkedIn activity',
  description:
    'Takes a person’s LinkedIn address and researches what they are currently ' +
    'doing — the role and organisation their profile shows, plus recent public ' +
    'activity found on the web — and writes it up with a confidence and its sources.',
  params: LINKEDIN_RESEARCH_PLUGIN.signature.params,
  contextAdditions:
    'Adds five fields to the record it runs on: a written summary of what the ' +
    'person appears to be doing, how confident that reading is, the role and ' +
    'organisation it read, and the addresses the summary cites. Adds nothing ' +
    'at all when no public signal consistent with the profile exists.',
  additions: LINKEDIN_RESEARCH_PLUGIN.signature.additions,
  handbookSection: LINKEDIN_RESEARCH_HANDBOOK_SECTION,
};

export const linkedinResearchImpl: TransformImpl = legacyImpl(linkedinResearchPlugin);
