// research on this platform: its catalogue manifest (the Plugins page, the
// handbook), its legacy line — the `@lf/web` body run with the platform's own
// tools, through the transform registry — and the engines themselves, run
// with those tools, for the comparison harness and the dev scripts.

import type { PluginManifest, TransformImpl } from '../registry';

import { research as researchIn, researchPlugin } from '@lf/web/research';
import { importIdentifier } from 'movement-engine/services/translation_graph/movement/schema_projection';
import { RESEARCH_PLUGIN } from 'movement-engine/public/plugins';
import { hosted, legacyImpl } from '../hosted_tools';
import { RESEARCH_HANDBOOK_SECTION } from './research_handbook_section';

export * from '@lf/web/research/contract';
export { configuredEngine } from '@lf/web/research';

export const RESEARCH_PLUGIN_MANIFEST: PluginManifest = {
  pluginName: RESEARCH_PLUGIN.signature.name,
  importName: importIdentifier(RESEARCH_PLUGIN.signature.name),
  displayName: 'Research',
  description:
    'Takes whatever a record carries — a name, a line of context, a website, a ' +
    'profile address — and researches the subject on the web, answering the ' +
    'question you asked it. Hands back a short synthesis, the content it rests ' +
    'on, the addresses it resolved, and how confident the reading is.',
  params: RESEARCH_PLUGIN.signature.params,
  contextAdditions:
    'Adds six fields to the record: the answer, how confident it is, the ' +
    'addresses it cites, the website and profile address it resolved or ' +
    'confirmed, and the content itself. Adds nothing at all when the record ' +
    'carried no address and nothing distinctive was said about it, or when ' +
    'nothing consistent with the subject could be found.',
  additions: RESEARCH_PLUGIN.signature.additions,
  handbookSection: RESEARCH_HANDBOOK_SECTION,
};

/** One research run with the platform's tools. */
export const research = hosted(researchIn);

export const researchImpl: TransformImpl = legacyImpl(researchPlugin);
