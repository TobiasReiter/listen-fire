// The calls Affinity's recorded parity makes, in order, against one
// implementation: the read surface (walkSurface), then the writes an author's
// movement makes — an organization with custom fields (a location among them,
// which the model formats), a person under it, a note, a list entry, an owner
// link, updates and deletes — the inbound mapping, and the webhook
// subscription lifecycle. Each later call is built from what an earlier one
// answered, so the script follows what the fake really holds. No call reads a
// record that does not exist: the client retries a 404 on a minutes-long
// backoff.

import type { Adapter } from 'movement-engine/public/adapter';

import { makeMetaPosition } from 'movement-engine/public/catalog';

import { MUTATION, Transcript, cmp, prop, value, walkSurface, type TranscriptEntry } from '../../../__test__/crm_parity/walk';

const ORG = '9601';
const PERSON = '9701';

export async function runAffinityParityScript(adapter: Adapter): Promise<TranscriptEntry[]> {
  const t = new Transcript();
  const firsts = await walkSurface(t, adapter, 'affinity', {
    extraTypes: ['Note', 'File', 'Reminder', 'Interaction', 'Relationship Strength', 'List Entry'],
  });

  const meta = makeMetaPosition('affinity');
  await t.step('root Organizations WHERE Name', () =>
    adapter.getRelated({ position: meta, fieldId: [...firsts.keys()].find((c) => c.startsWith('Organization')) ?? 'Organizations', direction: 'outgoing', where: cmp(prop('Name'), 'eq', value('Graph Redesign Co')) }),
  );

  await t.step('readRecord Organization', () => adapter.readRecord?.({ recordType: 'Organization', externalId: ORG }) ?? null);
  await t.step('readRecord Person', () => adapter.readRecord?.({ recordType: 'Person', externalId: PERSON, fieldIds: ['Email'] }) ?? null);

  await t.step('resolveEntity Organization by domain', () =>
    adapter.resolveEntity({ record: { Name: 'Graph Redesign Co', Domain: 'graphredesign.co' }, recordType: 'Organization', candidates: [], constraints: { any: [] } as never }),
  );
  await t.step('resolveEntity Person by email', () =>
    adapter.resolveEntity({ record: { 'Full name': 'Grace Graph', Email: 'grace@graphredesign.co' }, recordType: 'Person', candidates: [], constraints: { any: [] } as never }),
  );

  const org = await t.step('createRecord Organization', () =>
    adapter.createRecord({
      recordType: 'Organization',
      fields: { Name: 'Parity Labs', Domain: 'paritylabs.example', Description: 'Made by recorded parity', 'Amount Raised': '1200000', Location: 'Berlin, Germany' },
      mutationContext: MUTATION,
    }),
  );
  const orgId = org?.externalId;
  if (orgId !== undefined && orgId !== '') {
    await t.step('updateRecord Organization', () =>
      adapter.updateRecord({ recordType: 'Organization', externalId: orgId, fields: { Description: 'Updated by recorded parity' }, mutationContext: MUTATION }),
    );
    const person = await t.step('createRecord Person under the organization', () =>
      adapter.createRecord({
        recordType: 'Person',
        fields: { 'First name': 'Paula', 'Last name': 'Parity', Email: 'paula@paritylabs.example' },
        parentLinks: [{ recordType: 'Organization', externalId: orgId, edgeName: 'People' }],
        mutationContext: MUTATION,
      }),
    );
    const note = await t.step('createRecord Note on the organization', () =>
      adapter.createRecord({ recordType: 'Note', fields: { Content: 'Parity note' }, parentLinks: [{ recordType: 'Organization', externalId: orgId, edgeName: 'Notes' }], mutationContext: MUTATION }),
    );
    const entry = await t.step('createRecord List Entry on Pipeline', () =>
      adapter.createRecord({
        recordType: 'List Entry — Pipeline',
        fields: { 'Next Step': 'Call back' },
        parentLinks: [{ recordType: 'Organization', externalId: orgId, edgeName: 'List Entries' }],
        mutationContext: MUTATION,
      }),
    );
    if (entry?.externalId && person?.externalId) {
      const entryId = entry.externalId;
      const personId = person.externalId;
      await t.step('linkRecords List Entry Owners', () =>
        adapter.linkRecords?.({ from: { recordType: 'List Entry — Pipeline', externalId: entryId }, edgeName: 'Owners', to: { recordType: 'Person', externalId: personId }, mutationContext: MUTATION }) ?? null,
      );
      await t.step('unlinkRecords List Entry Owners', () =>
        adapter.unlinkRecords?.({ from: { recordType: 'List Entry — Pipeline', externalId: entryId }, edgeName: 'Owners', to: { recordType: 'Person', externalId: personId }, mutationContext: MUTATION }) ?? null,
      );
      await t.step('updateRecord List Entry', () =>
        adapter.updateRecord({
          recordType: 'List Entry — Pipeline',
          externalId: entryId,
          fields: { 'Next Step': 'Send term sheet' },
          parentLinks: [{ recordType: 'Organization', externalId: orgId, edgeName: 'List Entries' }],
          mutationContext: MUTATION,
        }),
      );
      await t.step('deleteRecord List Entry', () => adapter.deleteRecord({ recordType: 'List Entry — Pipeline', externalId: entryId, mutationContext: MUTATION }));
    }
    if (note?.externalId) {
      const noteId = note.externalId;
      await t.step('deleteRecord Note', () => adapter.deleteRecord({ recordType: 'Note', externalId: noteId, mutationContext: MUTATION }));
    }
    if (person?.externalId) {
      const personId = person.externalId;
      await t.step('deleteRecord Person', () => adapter.deleteRecord({ recordType: 'Person', externalId: personId, mutationContext: MUTATION }));
    }
    await t.step('deleteRecord Organization', () => adapter.deleteRecord({ recordType: 'Organization', externalId: orgId, mutationContext: MUTATION }));
  }

  for (const [name, raw] of INBOUND) {
    await t.step(`preprocessInbound ${name}`, () => adapter.preprocessInbound?.({ raw }) ?? null);
  }

  const registered = await t.step('ensureEventSubscription create', () =>
    adapter.ensureEventSubscription?.({ callbackUrl: 'https://example.test/api/public/webhook-sync/affinity/sub-1', events: ['organization.created', 'organization.updated'] } as never) ?? null,
  );
  const externalId = registered?.externalId;
  if (externalId !== undefined) {
    await t.step('ensureEventSubscription unchanged', () =>
      adapter.ensureEventSubscription?.({ callbackUrl: 'https://example.test/x', events: ['organization.updated', 'organization.created'], current: { externalId, events: ['organization.created', 'organization.updated'] } } as never) ?? null,
    );
    await t.step('ensureEventSubscription widened', () =>
      adapter.ensureEventSubscription?.({ callbackUrl: 'https://example.test/x', events: ['organization.created', 'person.created'], current: { externalId, events: ['organization.created'] } } as never) ?? null,
    );
    await t.step('removeEventSubscription', () => adapter.removeEventSubscription?.({ callbackUrl: 'https://example.test/x', externalId }) ?? null);
  }
  await t.step('listEventTypes', () => adapter.listEventTypes?.() ?? null);
  return t.entries;
}

const INBOUND: ReadonlyArray<[string, unknown]> = [
  ['organization.updated', { type: 'organization.updated', body: { id: 9601, name: 'Graph Redesign Co', domain: 'graphredesign.co' }, sent_at: 1760000000 }],
  ['person.created', { type: 'person.created', body: { id: 9701, first_name: 'Grace', last_name: 'Graph' }, sent_at: 1760000001 }],
  ['list_entry.created', { type: 'list_entry.created', body: { id: 9801, list_id: 1, entity_id: 9601, entity_type: 1 }, sent_at: 1760000002 }],
  ['field_value.updated on a list entry', { type: 'field_value.updated', body: { id: 1, field_id: 21, list_entry_id: 9801, entity_id: 9601, entity_type: 1, value: 'x' }, sent_at: 1760000003 }],
  ['field_value.updated on an organization', { type: 'field_value.updated', body: { id: 2, field_id: 3, entity_id: 9601, entity_type: 1, value: 'y' }, sent_at: 1760000004 }],
  ['list.created (unmapped)', { type: 'list.created', body: { id: 5 }, sent_at: 1760000005 }],
  ['not a delivery', { nope: true }],
];
