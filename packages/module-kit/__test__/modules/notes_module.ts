// A small adapter module for the kit's own tests: a notes service with one
// root collection, a static credential, a polled source and a periodic task.
// It reads its provider through `ctx.fetch` at `ctx.config.baseUrlOverride`
// (or the credential's `base_url`), so a test can stand the provider up.

import type { Adapter, RelatedResult } from 'movement-engine/public/adapter';

import { BASE_RUNTIME_CAPABILITIES } from 'movement-engine/public/adapter';
import { META_RECORD_TYPE, makeStablePosition } from 'movement-engine/public/catalog';

import { defineModule, type AdapterModuleMethods, type ModuleContext } from '../../define';

export const NOTES_MANIFEST = {
  adapterType: 'notes',
  displayName: 'Notes',
  description: 'A notes service.',
  supportedTriggers: ['poll'] as const,
  methods: ['listEntryPoints', 'describe', 'getRelated', 'getFieldValue'],
  subscribableEvents: ['note_created'],
  listenConfig: [{ key: 'folder', required: false }],
};

async function provider(ctx: ModuleContext, path: string): Promise<unknown> {
  const fields = await ctx.credential.fields();
  const base = ctx.config.baseUrlOverride ?? fields.base_url ?? 'https://notes.invalid';
  const response = await ctx.fetch(`${base}${path}`, { headers: { authorization: `Bearer ${fields.api_key ?? ''}` } });
  if (!response.ok) throw new Error(`notes answered ${response.status}`);
  return response.json();
}

function notesAdapter(ctx: ModuleContext): AdapterModuleMethods {
  const adapter: Adapter = {
    adapterType: 'notes',
    supportedTriggers: ['poll'],
    runtimeCapabilities: () => BASE_RUNTIME_CAPABILITIES,
    listEntryPoints: async () => [{ typeId: 'note', displayName: 'Note', readable: true, writable: false, collectionName: 'Notes' }],
    describe: async (typeId) =>
      typeId === 'note' || typeId === 'Note'
        ? { typeId: 'note', displayName: 'Note', fields: [{ fieldId: 'title', displayName: 'Title', kind: 'string', writable: false, required: false }], references: [] }
        : null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async ({ position, fieldId }) => {
      const data = position.identity.kind === 'stable' ? position.identity.data : undefined;
      return data !== null && typeof data === 'object' ? (Reflect.get(data, fieldId.toLowerCase()) ?? null) : null;
    },
    getRelated: async ({ position, fieldId }): Promise<RelatedResult[]> => {
      if (position.recordType !== META_RECORD_TYPE || fieldId !== 'Notes') return [];
      const notes = await provider(ctx, '/notes');
      return (Array.isArray(notes) ? notes : []).map((note: { id: string; title: string }) => ({
        position: makeStablePosition({ adapterType: 'notes', recordType: 'Note', recordId: note.id, data: note }),
      }));
    },
    createRecord: async () => {
      throw new Error('notes is read-only');
    },
    updateRecord: async () => {
      throw new Error('notes is read-only');
    },
    deleteRecord: async () => {
      throw new Error('notes is read-only');
    },
  };
  return Object.assign(adapter, {
    poll: async ({ checkpoint }: { config: unknown; checkpoint?: unknown }) => {
      const since = typeof checkpoint === 'number' ? checkpoint : 0;
      const notes = await provider(ctx, `/notes?since=${since}`);
      const list = Array.isArray(notes) ? (notes as Array<{ id: string; title: string; at: number }>) : [];
      return {
        events: list.map((note) => ({ payload: note, externalId: note.id, tag: 'note_created' })),
        checkpoint: list.reduce((high, note) => Math.max(high, note.at), since),
      };
    },
    runPeriodic: async ({ name }: { name: string }) => {
      // A provider that rotates the key on renewal: the host stores it.
      if (name === 'rotate_key') await ctx.credential.update({ api_key: `${(await ctx.credential.fields()).api_key ?? ''}-rotated` });
    },
  });
}

export default defineModule({
  kind: 'adapter',
  name: '@lf/notes',
  manifest: NOTES_MANIFEST,
  credentials: [{ name: 'notes', kind: 'static', fields: [{ name: 'api_key' }, { name: 'base_url', secret: false, optional: true }] }],
  poll: { intervalSeconds: 60 },
  periodic: [{ name: 'rotate_key', intervalSeconds: 3600 }],
  create: notesAdapter,
});
