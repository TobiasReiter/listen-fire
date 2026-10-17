// The calls Airtable's recorded parity makes, in order, against one
// implementation: the read surface (walkSurface), the record writes, the
// webhook lifecycle, and an inbound ping that pulls its payload feed. When
// recording, `inject` appends a change to the fake's feed before the ping
// (fake-channels' own admin call, made beside the adapter, not through it);
// replaying, the recorded feed answers the same pull.

import type { Adapter } from 'movement-engine/public/adapter';

import { makeMetaPosition } from 'movement-engine/public/catalog';

import { MUTATION, Transcript, cmp, firstPosition, prop, value, walkSurface, type TranscriptEntry } from '../../../__test__/crm_parity/walk';

const BASE = 'appTEST001';
const COMPANIES = 'tblCOMPANIES';

export type InjectChange = (input: { webhookId: string; body: Record<string, unknown> }) => Promise<void>;

export async function runAirtableParityScript(adapter: Adapter, scoped: Adapter, inject?: InjectChange): Promise<TranscriptEntry[]> {
  const t = new Transcript();
  // Writes first: the fake's tables start empty, and the walk should find rows.
  const created = await t.step('createRecord Companies', () =>
    adapter.createRecord({ recordType: 'Companies', fields: { Name: 'Parity Labs', Stage: 'Seed', Notes: 'Made by recorded parity' }, mutationContext: MUTATION }),
  );
  const id = created?.externalId;
  if (id !== undefined) {
    await t.step('createRecord Contacts linked to the company', () =>
      adapter.createRecord({ recordType: 'Contacts', fields: { 'Full Name': 'Paula Parity', Email: 'paula@paritylabs.example', Company: [id] }, mutationContext: MUTATION }),
    );
  }
  await walkSurface(t, adapter, 'airtable', { extraTypes: ['Base', 'Table', 'Companies', 'Contacts', 'Vendors'], depth: 3 });
  // The `base:` construction argument: an instance scoped to one base.
  await t.step('scoped listEntryPoints', () => scoped.listEntryPoints());
  const companies = await t.step('scoped root Companies', () =>
    scoped.getRelated({ position: makeMetaPosition('airtable'), fieldId: 'Companies', direction: 'outgoing', limit: 5 }),
  );
  const company = firstPosition(companies);
  if (company !== undefined) {
    for (const field of ['Name', 'Stage', 'Notes']) {
      await t.step(`Companies[0].${field}`, () => adapter.getFieldValue({ position: company, fieldId: field }));
    }
  }
  const contact = firstPosition(
    await t.step('scoped root Contacts', () => scoped.getRelated({ position: makeMetaPosition('airtable'), fieldId: 'Contacts', direction: 'outgoing', limit: 5 })),
  );
  if (contact !== undefined) {
    await t.step('Contacts[0].Email', () => adapter.getFieldValue({ position: contact, fieldId: 'Email' }));
    await t.step('Contacts[0] -[Company]->', () => adapter.getRelated({ position: contact, fieldId: 'Company', direction: 'outgoing' }));
  }
  if (id !== undefined) {
    await t.step('readRecord Companies', () => adapter.readRecord?.({ recordType: 'Companies', externalId: id }) ?? null);
    await t.step('updateRecord Companies', () =>
      adapter.updateRecord({ recordType: 'Companies', externalId: id, fields: { Stage: 'Series A' }, mutationContext: MUTATION }),
    );
    await t.step('resolveEntity Companies by Name', () =>
      adapter.resolveEntity({ record: { Name: 'Parity Labs' }, recordType: 'Companies', candidates: [], constraints: { any: [] } as never }),
    );
    await t.step('scoped root Companies WHERE Name', () =>
      scoped.getRelated({ position: makeMetaPosition('airtable'), fieldId: 'Companies', direction: 'outgoing', where: cmp(prop('Name'), 'eq', value('Parity Labs')) }),
    );
    await t.step('deleteRecord Companies', () => adapter.deleteRecord({ recordType: 'Companies', externalId: id, mutationContext: MUTATION }));
  }

  await t.step('listEventTypes', () => adapter.listEventTypes?.() ?? null);
  const scope = { base: BASE, table: COMPANIES };
  const registered = await t.step('ensureEventSubscription create', () =>
    adapter.ensureEventSubscription?.({ callbackUrl: 'https://example.test/api/public/webhook-sync/airtable/sub-1', events: ['record.created', 'record.updated'], scope } as never) ?? null,
  );
  const webhookId = registered?.externalId;
  if (webhookId !== undefined) {
    if (inject !== undefined) {
      await inject({ webhookId, body: { changeType: 'add', tableId: COMPANIES, recordId: 'recPARITY1', fields: { Name: 'Pinged Co', Stage: 'Seed' } } });
      await inject({ webhookId, body: { changeType: 'update', tableId: COMPANIES, recordId: 'recPARITY1', fields: { Stage: 'Series A' } } });
    }
    await t.step('preprocessInbound ping', () => adapter.preprocessInbound?.({ raw: { base: { id: BASE }, webhook: { id: webhookId }, timestamp: '2026-10-01T09:00:00.000Z' } }) ?? null);
    await t.step('preprocessInbound ping from the checkpoint', () =>
      adapter.preprocessInbound?.({ raw: { base: { id: BASE }, webhook: { id: webhookId } }, checkpoint: 2 }) ?? null,
    );
    await t.step('preprocessInbound not a ping', () => adapter.preprocessInbound?.({ raw: { nope: true } }) ?? null);
    await t.step('ensureEventSubscription unchanged', () =>
      adapter.ensureEventSubscription?.({ callbackUrl: 'https://example.test/x', events: ['record.updated', 'record.created'], scope, current: { externalId: webhookId, events: ['record.created', 'record.updated'] } } as never) ?? null,
    );
    const recreated = await t.step('ensureEventSubscription widened (recreated)', () =>
      adapter.ensureEventSubscription?.({ callbackUrl: 'https://example.test/x', events: ['record.created', 'record.deleted'], scope, current: { externalId: webhookId, events: ['record.created'] } } as never) ?? null,
    );
    const live = recreated?.externalId ?? webhookId;
    await t.step('removeEventSubscription', () => adapter.removeEventSubscription?.({ externalId: live, scope } as never) ?? null);
  }
  await t.step('ensureEventSubscription without a table scope', () =>
    adapter.ensureEventSubscription?.({ callbackUrl: 'https://example.test/x', events: ['record.created'], scope: { base: BASE } } as never) ?? null,
  );
  return t.entries;
}
