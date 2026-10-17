// Bundled-transform registration.
//
// Side-effecting module: importing it (at most once at api-process
// boot, typically from the evaluator or the api entrypoint) registers
// the bundled plugins — `vc-url-retrieval`, `fetch-url`,
// `linkedin-enrichment`, `linkedin-research`, `web-research` and `research`
// — into
// the framework-global transform registry.
//
// Kept separate from the barrel (`./index.ts`) so that consumers who
// only need the registry helpers / types don't transitively trigger
// registration (per F4's barrel-is-side-effect-free design). Callers
// that *want* the bundled transforms available import this module
// explicitly:
//
//   import './register-bundled';
//
// or, for idempotent re-registration after a test reset:
//
//   import { registerBundledTransforms } from './register-bundled';
//   registerBundledTransforms();
//
// The function is idempotent at the per-transform level: it checks
// `getTransform(name)` before registering so a second call after a
// partial test-reset doesn't trip the registry's duplicate-name throw.

import type { PluginManifest, TransformImpl } from './registry';

import { BUNDLED_PLUGINS } from 'movement-engine/public/plugins';
import { getTransform, registerTransform } from './registry';
import { vcUrlRetrievalImpl, VC_URL_RETRIEVAL_PLUGIN_MANIFEST } from './vc-url-retrieval';
import { fetchUrlImpl, FETCH_URL_PLUGIN_MANIFEST } from './fetch-url';
import {
  linkedinEnrichmentImpl,
  LINKEDIN_ENRICHMENT_PLUGIN_MANIFEST,
} from './linkedin-enrichment';
import {
  linkedinResearchImpl,
  LINKEDIN_RESEARCH_PLUGIN_MANIFEST,
} from './linkedin-research';
import { webResearchImpl, WEB_RESEARCH_PLUGIN_MANIFEST } from './web-research';
import { researchImpl, RESEARCH_PLUGIN_MANIFEST } from './research';

const BUNDLED_TRANSFORMS: readonly TransformImpl[] = [
  vcUrlRetrievalImpl,
  fetchUrlImpl,
  linkedinEnrichmentImpl,
  linkedinResearchImpl,
  webResearchImpl,
  researchImpl,
];

export function registerBundledTransforms(): void {
  for (const impl of BUNDLED_TRANSFORMS) {
    if (!getTransform(impl.signature.name)) {
      registerTransform(impl);
    }
  }
}

/**
 * Static per-plugin manifests, registered alongside the impls — the
 * plugin twin of the adapter registry's `ADAPTER_MANIFESTS` (see
 * `../../adapters/registry.ts`). Catalogue surfaces (the Plugins page,
 * agent-facing introspection) read these; the engine keeps dispatching on
 * the transform registry itself.
 */
const BUNDLED_PLUGIN_MANIFESTS: readonly PluginManifest[] = [
  VC_URL_RETRIEVAL_PLUGIN_MANIFEST,
  FETCH_URL_PLUGIN_MANIFEST,
  LINKEDIN_ENRICHMENT_PLUGIN_MANIFEST,
  LINKEDIN_RESEARCH_PLUGIN_MANIFEST,
  WEB_RESEARCH_PLUGIN_MANIFEST,
  RESEARCH_PLUGIN_MANIFEST,
];

/**
 * Fail-fast lockstep checks (mirroring the adapter registry's
 * registration-time assertions): every manifest must describe a bundled
 * transform, every bundled transform must have a manifest, and import
 * names must be unique — `import { <name> } from plugins` has to resolve
 * to exactly one plugin.
 */
function assertManifestsMatchBundledTransforms(): void {
  const transformNames = new Set(BUNDLED_TRANSFORMS.map((t) => t.signature.name));
  const importNames = new Set<string>();
  for (const manifest of BUNDLED_PLUGIN_MANIFESTS) {
    if (!transformNames.has(manifest.pluginName)) {
      throw new Error(
        `Plugin manifest '${manifest.pluginName}' has no bundled transform registration.`,
      );
    }
    if (importNames.has(manifest.importName)) {
      throw new Error(
        `Plugin import name '${manifest.importName}' is declared by two manifests; ` +
          'each import name must resolve to exactly one plugin.',
      );
    }
    importNames.add(manifest.importName);
  }
  for (const name of transformNames) {
    if (!BUNDLED_PLUGIN_MANIFESTS.some((m) => m.pluginName === name)) {
      throw new Error(`Bundled transform '${name}' is missing a plugin manifest.`);
    }
  }
}

assertManifestsMatchBundledTransforms();

/**
 * The host implements exactly the plugins the engine package declares, each
 * under its declared signature: the checker and the engine read the
 * declarations, so an implementation of something undeclared would never be
 * called, and a declaration with no implementation would check clean and then
 * answer nothing.
 */
function assertImplementationsMatchDeclarations(): void {
  for (const declaration of BUNDLED_PLUGINS) {
    const impl = BUNDLED_TRANSFORMS.find((t) => t.signature.name === declaration.signature.name);
    if (impl === undefined) {
      throw new Error(`Declared plugin '${declaration.signature.name}' has no bundled implementation.`);
    }
    if (impl.signature !== declaration.signature || (impl.priced === true) !== declaration.priced) {
      throw new Error(
        `Bundled plugin '${declaration.signature.name}' is implemented under a signature or price other than its declaration's.`,
      );
    }
  }
  for (const impl of BUNDLED_TRANSFORMS) {
    if (!BUNDLED_PLUGINS.some((d) => d.signature.name === impl.signature.name)) {
      throw new Error(`Bundled transform '${impl.signature.name}' is not a declared plugin.`);
    }
  }
}

assertImplementationsMatchDeclarations();

/** Every bundled plugin's manifest — the enumeration surface for the
 *  Plugins page and other catalogues. Pure and construction-free. */
export function listPluginManifests(): PluginManifest[] {
  return [...BUNDLED_PLUGIN_MANIFESTS];
}

// Run at module-import time — that's the contract of this module's
// existence. Tests that need a clean slate call `_resetTransformRegistry()`
// then `registerBundledTransforms()` again.
registerBundledTransforms();
