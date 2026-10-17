// web-research on this platform: its catalogue manifest (the Plugins page, the
// handbook) and its legacy line — the `@lf/web` body run with the platform's
// own tools, through the transform registry. Which line a run takes is
// BUILTIN_MODULES'.

import type { PluginManifest, TransformImpl } from './registry';

import { WEB_RESEARCH_HANDBOOK_SECTION } from './web_research_handbook_section';
import { webResearchPlugin } from '@lf/web';
import { importIdentifier } from 'movement-engine/public/catalog';
import { WEB_RESEARCH_PLUGIN } from 'movement-engine/public/plugins';
import { legacyImpl } from './hosted_tools';

export const WEB_RESEARCH_PLUGIN_MANIFEST: PluginManifest = {
  pluginName: WEB_RESEARCH_PLUGIN.signature.name,
  importName: importIdentifier(WEB_RESEARCH_PLUGIN.signature.name),
  displayName: 'Find the website',
  description:
    'The fallback for a record that arrived with no link: it works out a ' +
    "company's own website from its name and what the message said about it, " +
    'checks the site really is that company, and loads it. Pass the record’s ' +
    'link fields as well and it stands down whenever one of them is filled, so ' +
    'it only spends anything on the records nothing else could reach.',
  params: WEB_RESEARCH_PLUGIN.signature.params,
  contextAdditions:
    'Adds the resolved web address to the record, plus the page it loaded — ' +
    'the same fetched page a targeted fetch adds. Adds nothing at all when the ' +
    'message said too little to search on, or when no site could be confirmed ' +
    'as that company’s.',
  additions: WEB_RESEARCH_PLUGIN.signature.additions,
  handbookSection: WEB_RESEARCH_HANDBOOK_SECTION,
};

export const webResearchImpl: TransformImpl = legacyImpl(webResearchPlugin);
