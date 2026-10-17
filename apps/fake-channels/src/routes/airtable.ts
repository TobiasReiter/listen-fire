import { Router } from 'express';
import { randomBytes } from 'crypto';
import type { EntityStore } from '../store';

const SVC = 'airtable';

/** A registered fake Airtable webhook. `changeTypes` / `recordChangeScope`
 *  mirror what `createWebhook` sends in `specification.options.filters`; they
 *  are what makes the credit-saving filter REAL in the loop — a change kind (or
 *  a table) the webhook didn't subscribe to is never queued into its payload
 *  feed, so a ping pulls nothing and no movement runs. */
interface FakeWebhook {
  id: string;
  baseId: string;
  notificationUrl: string;
  dataTypes: string[];
  changeTypes: string[];
  recordChangeScope?: string;
  macSecretBase64: string;
  expirationTime: string;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function payloadFeedType(webhookId: string): string {
  return `payload:${webhookId}`;
}

/** Map an Airtable change kind back to the table-change bucket Listen-Fire's adapter
 *  reads (`createdRecordsById` / `changedRecordsById` / `destroyedRecordIds`). */
type ChangeType = 'add' | 'update' | 'remove';

export function airtableRoutes(store: EntityStore): Router {
  const r = Router();

  // List bases
  r.get('/v0/meta/bases', (_req, res) => {
    const bases = store.list(SVC, 'base');
    res.json({ bases: bases.map((b) => b.data) });
  });

  // List tables for a base
  r.get('/v0/meta/bases/:baseId/tables', (req, res) => {
    const tables = store.list(SVC, `table:${req.params.baseId}`);
    res.json({ tables: tables.map((t) => t.data) });
  });

  // ── Webhook management (notify-then-pull source triggers) ─────────────────
  // The fake mirror of Airtable's per-base webhook API. The adapter's
  // `ensureEventSubscription` → `createWebhook` lands here; the inbound ping it
  // fires later makes `preprocessInbound` PULL from the payload feed below.

  // Register a webhook. Returns `macSecretBase64` ONCE (as real Airtable does) —
  // the listen reconciler persists it as the inbound HMAC key.
  r.post('/v0/bases/:baseId/webhooks', (req, res) => {
    const { baseId } = req.params;
    const filters = (req.body?.specification?.options?.filters ?? {}) as {
      dataTypes?: string[];
      changeTypes?: string[];
      recordChangeScope?: string;
    };
    const id = `ach${store.nextId(SVC, 'webhook')}`;
    const webhook: FakeWebhook = {
      id,
      baseId,
      notificationUrl: req.body?.notificationUrl ?? '',
      dataTypes: filters.dataTypes ?? ['tableData'],
      changeTypes: filters.changeTypes ?? ['add', 'update', 'remove'],
      ...(filters.recordChangeScope ? { recordChangeScope: filters.recordChangeScope } : {}),
      macSecretBase64: randomBytes(32).toString('base64'),
      expirationTime: new Date(Date.now() + SEVEN_DAYS_MS).toISOString(),
    };
    store.create(SVC, 'webhook', { ...webhook }, id);
    res.json({
      id: webhook.id,
      macSecretBase64: webhook.macSecretBase64,
      expirationTime: webhook.expirationTime,
    });
  });

  // Delete a webhook + drain its payload feed.
  r.delete('/v0/bases/:baseId/webhooks/:id', (req, res) => {
    const { id } = req.params;
    store.delete(SVC, 'webhook', id);
    for (const p of store.list(SVC, payloadFeedType(id))) {
      store.delete(SVC, payloadFeedType(id), p.id);
    }
    res.json({ ok: true });
  });

  // Extend a webhook's 7-day life. Driven by the refresh worker.
  r.post('/v0/bases/:baseId/webhooks/:id/refresh', (req, res) => {
    const { id } = req.params;
    const existing = store.get(SVC, 'webhook', id);
    if (!existing) return res.status(404).json({ error: 'Webhook not found' });
    const expirationTime = new Date(Date.now() + SEVEN_DAYS_MS).toISOString();
    store.update(SVC, 'webhook', id, { ...existing.data, expirationTime });
    res.json({ expirationTime });
  });

  // Drain a webhook's payload feed from `cursor` (1-indexed; defaults to 1).
  // One page returns everything from the cursor on — `mightHaveMore` stays
  // false (the loop in `preprocessInbound` breaks). The returned `cursor` is
  // the resume point for the NEXT pull (max seq seen + 1).
  r.get('/v0/bases/:baseId/webhooks/:id/payloads', (req, res) => {
    const { id } = req.params;
    const cursor = req.query.cursor ? Number(req.query.cursor) : 1;
    const feed = store
      .list(SVC, payloadFeedType(id))
      .map((e) => ({ seq: Number(e.id), payload: e.data }))
      .sort((a, b) => a.seq - b.seq)
      .filter((e) => e.seq >= cursor);
    const nextCursor = feed.length > 0 ? feed[feed.length - 1].seq + 1 : cursor;
    res.json({
      payloads: feed.map((e) => e.payload),
      cursor: nextCursor,
      mightHaveMore: false,
    });
  });

  // Dev-loop seed hook (NOT a real Airtable route): append a single record
  // change to a webhook's payload feed. `dev:inject airtable-webhook` posts a
  // simplified `{ changeType, tableId, recordId, fields }` here; the fake builds
  // the real `changedTablesById` payload (keying cell values by FIELD ID, mapped
  // from the seeded table metadata — so `preprocessInbound`'s id→name pass is
  // exercised) and HONORS the webhook's subscription: a change kind or a table
  // the webhook didn't register for is dropped, never queued — modeling
  // Airtable's "we only ping for what you subscribed to" credit guarantee.
  r.post('/v0/bases/:baseId/webhooks/:id/payloads', (req, res) => {
    const { baseId, id } = req.params;
    const webhook = store.get(SVC, 'webhook', id);
    if (!webhook) return res.status(404).json({ error: 'Webhook not found' });
    const wh = webhook.data as unknown as FakeWebhook;

    const changeType = req.body?.changeType as ChangeType | undefined;
    const tableId = req.body?.tableId as string | undefined;
    const recordId = req.body?.recordId as string | undefined;
    const fields = (req.body?.fields ?? {}) as Record<string, unknown>;
    if (!changeType || !tableId || !recordId) {
      return res
        .status(400)
        .json({ error: 'Expected { changeType, tableId, recordId, fields? }' });
    }

    if (!wh.changeTypes.includes(changeType)) {
      return res.json({
        appended: false,
        reason: 'change_type_not_subscribed',
        subscribedChangeTypes: wh.changeTypes,
      });
    }
    if (wh.recordChangeScope && wh.recordChangeScope !== tableId) {
      return res.json({
        appended: false,
        reason: 'table_out_of_scope',
        recordChangeScope: wh.recordChangeScope,
      });
    }

    // Translate field NAMES → field ids via the seeded table metadata so the
    // payload keys cell values by id (as real Airtable does). Unknown names
    // fall through as-is (the adapter then leaves them id-keyed).
    const tableMeta = store.get(SVC, `table:${baseId}`, tableId)?.data as
      | { fields?: { id: string; name: string }[] }
      | undefined;
    const idByName = new Map<string, string>();
    for (const f of tableMeta?.fields ?? []) idByName.set(f.name, f.id);
    const cellValuesByFieldId: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(fields)) {
      cellValuesByFieldId[idByName.get(name) ?? name] = value;
    }

    const tableChange: {
      createdRecordsById?: Record<string, unknown>;
      changedRecordsById?: Record<string, unknown>;
      destroyedRecordIds?: string[];
    } = {};
    if (changeType === 'add') {
      tableChange.createdRecordsById = { [recordId]: { cellValuesByFieldId } };
    } else if (changeType === 'update') {
      tableChange.changedRecordsById = { [recordId]: { current: { cellValuesByFieldId } } };
    } else {
      tableChange.destroyedRecordIds = [recordId];
    }

    const payload = {
      timestamp: new Date().toISOString(),
      baseTransactionNumber: store.nextId(SVC, `txn:${id}`),
      changedTablesById: { [tableId]: tableChange },
    };
    const seq = store.nextId(SVC, payloadFeedType(id));
    store.create(SVC, payloadFeedType(id), payload, seq);
    res.json({ appended: true, seq: Number(seq), payload });
  });

  // Create record
  r.post('/v0/:baseId/:tableId', (req, res) => {
    const id = `rec${store.nextId(SVC, `record:${req.params.baseId}:${req.params.tableId}`)}`;
    store.create(
      SVC,
      `record:${req.params.baseId}:${req.params.tableId}`,
      {
        id,
        fields: req.body.fields || {},
        createdTime: new Date().toISOString(),
      },
      id,
    );
    res.json({ id });
  });

  // Update record
  r.patch('/v0/:baseId/:tableId/:recordId', (req, res) => {
    const key = `record:${req.params.baseId}:${req.params.tableId}`;
    const record = store.get(SVC, key, req.params.recordId);
    if (!record) return res.status(404).json({ error: 'Not found' });
    const fields = { ...(record.data.fields as Record<string, unknown>), ...req.body.fields };
    store.update(SVC, key, req.params.recordId, { ...record.data, fields });
    res.json({ id: req.params.recordId, fields });
  });

  // Read one record
  r.get('/v0/:baseId/:tableId/:recordId', (req, res) => {
    const record = store.get(SVC, `record:${req.params.baseId}:${req.params.tableId}`, req.params.recordId);
    if (!record) return res.status(404).json({ error: { type: 'MODEL_ID_NOT_FOUND', message: 'Could not find a record with that id' } });
    res.json(record.data);
  });

  // Delete one record
  r.delete('/v0/:baseId/:tableId/:recordId', (req, res) => {
    const key = `record:${req.params.baseId}:${req.params.tableId}`;
    if (!store.get(SVC, key, req.params.recordId)) return res.status(404).json({ error: 'Not found' });
    store.delete(SVC, key, req.params.recordId);
    res.json({ id: req.params.recordId, deleted: true });
  });

  // List records
  r.get('/v0/:baseId/:tableId', (req, res) => {
    const key = `record:${req.params.baseId}:${req.params.tableId}`;
    const records = store.list(SVC, key);
    // Handle offset-based pagination
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const pageSize = 100;
    const page = records.slice(offset, offset + pageSize);
    const nextOffset = offset + pageSize < records.length ? String(offset + pageSize) : undefined;
    res.json({
      records: page.map((r) => r.data),
      offset: nextOffset,
    });
  });

  return r;
}
