// vc-url-retrieval on this platform: its catalogue manifest (the Plugins page, the
// handbook) and its legacy line — the `@lf/web` body run with the platform's
// own tools, through the transform registry. Which line a run takes is
// BUILTIN_MODULES'.

import type { PluginManifest, TransformImpl } from './registry';

import { VC_URL_RETRIEVAL_HANDBOOK_SECTION } from './vc_url_retrieval_handbook_section';
import { vcUrlRetrievalPlugin } from '@listen-fire/web';
import { importIdentifier } from 'movement-engine/public/catalog';
import { VC_URL_RETRIEVAL_PLUGIN } from 'movement-engine/public/plugins';
import { legacyImpl } from './hosted_tools';
export { _extractCandidateUrls, _extractLocalContext } from '@listen-fire/web/vc_url_retrieval';

/**
 * Static manifest — the catalogue-facing declaration, registered alongside
 * the impl (see `./register-bundled.ts`). `params`/`additions` reference the
 * signature so they can't drift; `importName` is the identifier-safe name a
 * movement writes: `import { vc_url_retrieval } from plugins`.
 */
export const VC_URL_RETRIEVAL_PLUGIN_MANIFEST: PluginManifest = {
  pluginName: VC_URL_RETRIEVAL_PLUGIN.signature.name,
  importName: importIdentifier(VC_URL_RETRIEVAL_PLUGIN.signature.name),
  displayName: 'URL retrieval',
  description:
    'Finds links in a piece of text — a pitch deck link, a data room, a ' +
    'company site — works out what each one is, and fetches its content so ' +
    'the rest of the movement can read it.',
  params: VC_URL_RETRIEVAL_PLUGIN.signature.params,
  contextAdditions:
    'Adds a list of fetched pages to the record it runs on — each with the ' +
    'link, a name, the downloaded file, and the extracted text.',
  additions: VC_URL_RETRIEVAL_PLUGIN.signature.additions,
  handbookSection: VC_URL_RETRIEVAL_HANDBOOK_SECTION,
};

export const vcUrlRetrievalImpl: TransformImpl = legacyImpl(vcUrlRetrievalPlugin);
