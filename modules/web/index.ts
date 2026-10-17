// `@lf/web`: the six bundled plugins as one plugin module — fetch a named
// page, scan a message for the links worth fetching, find a person's profile,
// read what they are doing now, find a company's own site, and research a
// subject into a dossier. A movement imports them one by one
// (`import { fetchUrl } from plugins`) or as the package
// (``import { `@lf/web` as web } from plugins``, then `web.fetchUrl(u)`).
//
// Each plugin's declaration is the engine package's data (what it accepts,
// what it hands back, whether it may cost money); this module supplies the
// bodies. The platform loads it in process with its own tools; every other
// host serves it as a process with the standalone tools (`standalone.ts`).

import type { WireCredentialDeclarationShape } from 'engine-contracts';
import type { ModuleContext, PluginModuleDefinition } from 'module-kit';
import type { PluginInput, PluginOutput, WebPlugin } from './plugin';
import type { WebTools } from './tools';

import { defineModule } from 'module-kit';
import { BUNDLED_PLUGINS, pluginProgramName } from 'movement-engine/public/plugins';
import { fetchUrlPlugin } from './fetch_url';
import { linkedinEnrichmentPlugin } from './linkedin_enrichment';
import { linkedinResearchPlugin } from './linkedin_research';
import { answerOf, inputFor } from './plugin';
import { researchPlugin } from './research';
import { standaloneTools, WEB_CREDENTIAL_FIELDS } from './standalone';
import { withTools } from './tools';
import { vcUrlRetrievalPlugin } from './vc_url_retrieval';
import { webResearchPlugin } from './web_research';

/** The plugins, in the catalog's order. */
export const WEB_PLUGINS: readonly WebPlugin[] = [
  vcUrlRetrievalPlugin,
  fetchUrlPlugin,
  linkedinEnrichmentPlugin,
  linkedinResearchPlugin,
  webResearchPlugin,
  researchPlugin,
];

// The module implements exactly the plugins the engine package declares, each
// under its declaration: the checker and the engine read the declarations, so
// a body for something undeclared would never be called, and a declaration
// with no body would check clean and then answer nothing.
for (const declaration of BUNDLED_PLUGINS) {
  if (!WEB_PLUGINS.some((p) => p.declaration === declaration)) {
    throw new Error(`@lf/web: the declared plugin '${declaration.signature.name}' has no body`);
  }
}
if (WEB_PLUGINS.length !== BUNDLED_PLUGINS.length) {
  throw new Error('@lf/web: a body here answers to no declared plugin');
}

/** A plugin by either spelling (`vc_url_retrieval`, `vc-url-retrieval`). */
export function webPluginNamed(name: string): WebPlugin | undefined {
  const spelled = pluginProgramName(name);
  return WEB_PLUGINS.find((p) => pluginProgramName(p.declaration.signature.name) === spelled);
}

/** One plugin's body, run with `tools`. */
export function runWebPlugin(plugin: WebPlugin, input: PluginInput, with_: WebTools): Promise<PluginOutput> {
  return withTools(with_, () => plugin.run(input));
}

/** The credential the standalone tools read (every field optional). */
export const WEB_CREDENTIAL: WireCredentialDeclarationShape = { name: 'web', kind: 'static', fields: WEB_CREDENTIAL_FIELDS };

/** The module, over the tools `toolsOf` builds for each invocation from the
 *  context its host supplies. */
export function webModuleWith(toolsOf: (ctx: ModuleContext) => WebTools | Promise<WebTools>): PluginModuleDefinition {
  return defineModule({
    kind: 'plugin',
    name: '@lf/web',
    credentials: [WEB_CREDENTIAL],
    plugins: WEB_PLUGINS.map((p) => p.declaration),
    create: (ctx) => ({
      async invokePlugin({ name, config, extractedContext }) {
        const plugin = webPluginNamed(name);
        if (plugin === undefined) throw new Error(`@lf/web has no plugin "${name}"`);
        const tools = await toolsOf(ctx);
        return withTools(tools, async () => {
          const answer = await answerOf(await plugin.run(inputFor(plugin, { config, extractedContext })));
          const spent = tools.spentMicrodollars?.() ?? 0;
          return spent > 0 ? { ...answer, costMicrodollars: (answer.costMicrodollars ?? 0) + spent } : answer;
        });
      },
    }),
  });
}

/** The module every host but the platform serves. */
export const webModule = webModuleWith(standaloneTools);

export default webModule;

export * from './addresses';
export * from './plugin';
export * from './tools';
export { standaloneTools, pageText } from './standalone';
export { fetchUrlPlugin, linkedinEnrichmentPlugin, linkedinResearchPlugin, researchPlugin, vcUrlRetrievalPlugin, webResearchPlugin };
