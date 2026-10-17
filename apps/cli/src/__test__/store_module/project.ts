// A project whose store slot is filled by the forwarding store module
// (forward.mjs), its state file at `statePath`.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { lfBinary } from '../lf_bin';

const FORWARD = resolve(__dirname, 'forward.mjs');

/** Put the module into `dir`'s externals, name it in lf.yaml's `core:` and
 *  give it its `path` setting in the secrets file. */
export function withStoreModule(dir: string, statePath: string): void {
  mkdirSync(join(dir, 'externals/acme_store'), { recursive: true });
  writeFileSync(
    join(dir, 'externals/acme_store/lf-external.yaml'),
    [
      'name: acme_store',
      'kind: core',
      'slot: store',
      `command: [node, ${JSON.stringify(FORWARD)}, ${JSON.stringify(lfBinary())}]`,
      'settings:',
      '  - { name: path, label: the state file the module keeps }',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'lf.yaml'), '\ncore:\n  store: acme_store\n', { flag: 'a' });
  mkdirSync(join(dir, '.lf'), { recursive: true });
  writeFileSync(join(dir, '.lf/secrets.yaml'), `\nacme_store:\n  module: acme_store\n  path: ${JSON.stringify(statePath)}\n`, { flag: 'a' });
}
