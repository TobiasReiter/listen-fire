// fetch-url on this platform: its catalogue manifest (the Plugins page, the
// handbook) and its legacy line — the `@lf/web` body run with the platform's
// own tools, through the transform registry. Which line a run takes is
// BUILTIN_MODULES'.

import type { PluginManifest, TransformImpl } from './registry';

import { FETCH_URL_HANDBOOK_SECTION } from './fetch_url_handbook_section';
import { fetchUrlPlugin } from '@listen-fire/web';
import { importIdentifier } from 'movement-engine/public/catalog';
import { FETCH_URL_PLUGIN } from 'movement-engine/public/plugins';
import { legacyImpl } from './hosted_tools';

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

export const fetchUrlImpl: TransformImpl = legacyImpl(fetchUrlPlugin);
