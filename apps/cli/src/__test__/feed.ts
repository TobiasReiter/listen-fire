// A polled notes feed module for lf's tests: a module whose manifest
// declares `poll`, installed into a copy of the example project.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { project } from './example';

const MODULE_KIT = resolve(__dirname, '../../../../packages/module-kit');

export interface Note {
  id: string;
  title: string;
  at: number;
}

/** A notes feed, polled: `feed.json` is what the provider holds, `polls.log`
 *  the checkpoint each poll was handed, and `replay` makes it forget the
 *  checkpoint (an overlapping poll's duplicates), `fast` polls it every
 *  second rather than every minute. Each poll takes 300ms. */
const FEED_MODULE = `const { readFileSync, appendFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { defineModule } = require(${JSON.stringify(join(MODULE_KIT, 'define.ts'))});
const at = (name) => join(__dirname, name);
const note = { typeId: 'note', displayName: 'Note', fields: [{ fieldId: 'title', displayName: 'Title', kind: 'string', writable: false, required: false }], references: [] };
module.exports = defineModule({
  kind: 'adapter',
  name: 'feed',
  credentials: [],
  manifest: { adapterType: 'feed', displayName: 'Feed', supportedTriggers: ['poll'], methods: [], webhookEventTypeId: 'note' },
  poll: { intervalSeconds: existsSync(at('fast')) ? 1 : 60 },
  create: () => ({
    adapterType: 'feed',
    supportedTriggers: ['poll'],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [{ typeId: 'note', displayName: 'Note', readable: false, writable: false, fires: true }],
    describe: async (typeId) => (typeId === 'note' || typeId === 'Note' ? note : null),
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async ({ position, fieldId }) => position.identity.data?.[fieldId.toLowerCase()] ?? null,
    getRelated: async () => [],
    createRecord: async () => { throw new Error('read-only'); },
    updateRecord: async () => { throw new Error('read-only'); },
    deleteRecord: async () => { throw new Error('read-only'); },
    poll: async ({ checkpoint }) => {
      appendFileSync(at('polls.log'), JSON.stringify(checkpoint ?? null) + '\\n');
      await new Promise((done) => setTimeout(done, 300));
      const since = existsSync(at('replay')) || typeof checkpoint !== 'number' ? 0 : checkpoint;
      const notes = JSON.parse(readFileSync(at('feed.json'), 'utf8')).filter((n) => n.at > since);
      return {
        events: notes.map((n) => ({ payload: n, externalId: n.id, idempotencyKey: n.id })),
        checkpoint: notes.reduce((high, n) => Math.max(high, n.at), since),
      };
    },
  }),
});
`;

/** The example project with only the notes movement, on the feed. */
export function feedProject(listen?: string): string {
  const dir = project();
  rmSync(join(dir, 'movements'), { recursive: true });
  mkdirSync(join(dir, 'movements'));
  return withFeed(dir, listen);
}

/** `dir` with the feed module installed and a movement listening to it
 *  (`notes:seen`, which fails naming each note it is fired with; `listen` is the listen statement). */
export function withFeed(dir: string, listen = 'listen to f fire seen'): string {
  mkdirSync(join(dir, 'externals/feed'));
  writeFileSync(join(dir, 'externals/feed/lf-external.yaml'), 'name: feed\nmodule: ./feed.ts\n');
  writeFileSync(join(dir, 'externals/feed/feed.ts'), FEED_MODULE);
  feed(dir, [
    { id: 'n1', title: 'First', at: 1 },
    { id: 'n2', title: 'Second', at: 2 },
  ]);
  writeFileSync(
    join(dir, 'movements/notes.mvt'),
    `import { feed } from adapters\n\nf = connect feed\n\nfunction seen(n: <f-[:Note]->>) {\n  fail("seen \${n.Title}")\n}\n\n${listen}\n`,
  );
  return dir;
}

export function feed(dir: string, notes: Note[]): void {
  writeFileSync(join(dir, 'externals/feed/feed.json'), JSON.stringify(notes));
}

/** The checkpoint each poll so far was handed. */
export function polls(dir: string): unknown[] {
  const log = join(dir, 'externals/feed/polls.log');
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as unknown);
}

