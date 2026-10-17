// The plugin catalog both checkers see, held against a recording taken from the
// code before plugin specs moved into the engine package as data (Plan 22 #3
// C3). Three views, because each is read by a different consumer: the snapshot
// a run checks against (the Rust checker's input), the live catalog's answers
// by either spelling (the TypeScript checker's input), and what both checkers
// say about a call to each plugin. Re-record only on a deliberate change to a
// plugin's surface: PLUGIN_CATALOG_RECORD=1.

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('movement-engine/services/knowledge_pipeline/output_v3/schemas');

import * as fs from 'fs';
import * as path from 'path';

import type { LanguageVersion, PluginSpec } from 'movement-lang';
import { spelledFor } from 'movement-lang/checker/__test__/surface_spelling';

import { diagnoseMovementSource } from '../authoring';
import { bundledPluginSpecs } from 'movement-engine/public/plugins';
import { staticCatalogFromManifests, staticCatalogSnapshot } from '../catalog';

const FIXTURE = path.join(__dirname, '__fixtures__', 'plugin_catalog.json');

function callingProgram(plugin: string, spec: PluginSpec, withArgs: boolean): string {
  const names = withArgs ? [...spec.args, ...(spec.fedArgs ?? []).map((a) => a.name)] : [];
  const args = names.map((name) => `${name}: "x"`).join(', ');
  return `import { ${plugin} } from plugins
movement m() {
  r = ${plugin}(${args})
  return r
}
`;
}

function observe(): unknown {
  const catalog = staticCatalogFromManifests();
  const snapshot = staticCatalogSnapshot();
  const specs = bundledPluginSpecs();
  const names = Object.keys(specs).sort();

  const liveCatalog = Object.fromEntries(
    names.flatMap((name) => {
      const dashed = name.replace(/_/g, '-');
      return [
        [name, catalog.plugin(name) ?? null],
        [dashed, catalog.plugin(dashed) ?? null],
      ];
    }),
  );

  const versions: LanguageVersion[] = [4, 5];
  const diagnostics: Record<string, unknown> = {};
  for (const name of names) {
    const spec = specs[name]!;
    for (const withArgs of [false, true]) {
      const source = callingProgram(name, spec, withArgs);
      for (const languageVersion of versions) {
        const spelled = spelledFor(languageVersion, source, catalog);
        const key = `${name} ${withArgs ? 'every argument' : 'no argument'} v${languageVersion}`;
        diagnostics[`${key} typescript`] = diagnoseMovementSource(spelled, { catalog, languageVersion }).diagnostics;
        if (languageVersion >= 5) {
          diagnostics[`${key} rust`] = diagnoseMovementSource(spelled, { catalog, languageVersion, snapshot }).diagnostics;
        }
      }
    }
  }

  return JSON.parse(
    JSON.stringify({ registeredPluginSpecs: specs, snapshotPlugins: snapshot.plugins, liveCatalog, diagnostics }),
  );
}

describe('the plugin catalog the checkers see', () => {
  it('is the recorded one', () => {
    const observed = observe();
    if (process.env.PLUGIN_CATALOG_RECORD === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(observed, null, 2)}\n`);
    }
    const recorded: unknown = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    expect(observed).toEqual(recorded);
  });
});

// The bundled plugins are one module, `@lf/web` (modules/web): a movement
// imports them one by one, as it always has, or as the package, and both
// checkers read the same members off the hosted catalog.
describe('the bundled plugins as a package', () => {
  const program = (imports: string, call: string) => `${imports}
function m(u: <text>) {
  r = ${call}
  return r
}
`;

  it.each([
    ['one by one', program('import { fetchUrl } from plugins', 'fetchUrl(u)')],
    ['as the package', program('import { `@lf/web` as web } from plugins', 'web.fetchUrl(u)')],
  ])('checks clean %s, in both checkers', (_how, source) => {
    const catalog = staticCatalogFromManifests();
    const snapshot = staticCatalogSnapshot();
    expect(diagnoseMovementSource(source, { catalog, languageVersion: 5 }).diagnostics).toEqual([]);
    expect(diagnoseMovementSource(source, { catalog, languageVersion: 5, snapshot }).diagnostics).toEqual([]);
  });

  it('names its members when one is missing', () => {
    const source = program('import { `@lf/web` as web } from plugins', 'web.whisper(u)');
    const messages = diagnoseMovementSource(source, { catalog: staticCatalogFromManifests(), languageVersion: 5 }).diagnostics.map((d) => d.message);
    expect(messages.join('\n')).toMatch(/has no member `whisper`.*fetchUrl/);
  });
});
