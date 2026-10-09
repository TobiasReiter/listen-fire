//
// Valuations webhook destination management. Lets an integrator (the Listen-Fire
// webhook_sync provider, an external service, the dev-loop seed script) tell
// Valuations "deliver row-change events to this URL." Each Valuations entity
// op (create / update / delete) is its own row in the `webhook` table; this
// endpoint groups them under a single "destination" abstraction keyed by URL.
//
// `webhook_subscription` backs the Valuations outbox worker: when a row in
// legal_entity / investment / … changes, the worker enqueues an
// `outbound_delivery` per matching subscription whose `event_type` equals
// `valuations:<entity>:<op>`. So registering here is the actual switch that
// starts delivery.
//
// The tables underneath became valuations' own in the carve (V-16); this
// contract did not move with them. Same routes, same bodies, same destination
// grouping — only `type` became `event_type` and the vestigial `version`
// column, which nothing ever varied, stopped existing.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { internalError, valuationsQb, teamId } from './shared';

const webhooksRouter: ReturnType<typeof Router> = Router();

// Allowed event type prefix — gates the inputs to the Valuations outbox shape.
// Lets the route reject Attio-style or otherwise mis-routed event types early
// rather than silently creating dead webhook rows.
const VALUATIONS_EVENT_RE = /^valuations:[a-z_]+:(create|update|delete)$/;

const createBodySchema = z.object({
  /** Where the Valuations worker should POST events. Used as the destination
   *  key — two registrations with the same URL share state. */
  url: z.string().url(),
  /** `valuations:<entity>:<create|update|delete>` strings to subscribe to.
   *  Each becomes its own `webhook` row internally. */
  eventTypes: z
    .array(z.string().regex(VALUATIONS_EVENT_RE))
    .min(1),
  /** Friendly label stored on each underlying row. Optional. */
  name: z.string().min(1).max(200).optional(),
  /** Hex secret used to HMAC-SHA256 sign outbound deliveries. Stored on
   *  each webhook row and read by the outbox worker when delivering. The
   *  caller (the subscriber) generates this; Valuations just persists it. */
  secret: z.string().min(16).optional(),
});

// POST /api/v1/valuations/webhooks
//
// Idempotent: existing non-deleted (team_id, url, type) rows are reused;
// only missing event types are inserted. Returns the full set of webhook row
// ids covering the requested event types.
webhooksRouter.post('/', async (req: Request, res: Response) => {
  const parsed = createBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid_body', issues: parsed.error.format() });
  }
  const { url, eventTypes, name, secret } = parsed.data;
  const tid = teamId();
  const label = name ?? `Valuations → ${new URL(url).host}`;

  try {
    const existing = await valuationsQb()
      .selectFrom('webhook_subscription')
      .where('team_id', '=', tid)
      .where('url', '=', url)
      .where('event_type', 'in', eventTypes)
      .where('deleted_at', 'is', null)
      .select(['id', 'event_type'])
      .execute();

    const haveTypes = new Set(existing.map((r) => r.event_type));
    const toInsert = eventTypes
      .filter((t) => !haveTypes.has(t))
      .map((t) => ({ team_id: tid, url, event_type: t, name: label, secret: secret ?? null }));

    const inserted =
      toInsert.length > 0
        ? await valuationsQb()
            .insertInto('webhook_subscription')
            .values(toInsert)
            .returning(['id', 'event_type'])
            .execute()
        : [];

    // Re-registering with a fresh secret rotates it across all existing
    // rows for this destination so old + new event types stay in sync.
    if (secret && existing.length > 0) {
      await valuationsQb()
        .updateTable('webhook_subscription')
        .set({ secret, updated_at: new Date() })
        .where(
          'id',
          'in',
          existing.map((r) => r.id),
        )
        .execute();
    }

    const rows = [...existing, ...inserted].map((r) => ({ id: r.id, type: r.event_type }));
    return res.status(200).json({ data: { url, rows } });
  } catch (err) {
    return internalError(res, err);
  }
});

// DELETE /api/v1/valuations/webhooks?url=<url>
//
// Soft-deletes every webhook row matching (team_id, url). Used by the Listen-Fire
// webhook_sync provider when a subscription is torn down. Idempotent —
// reports rows actually transitioned.
webhooksRouter.delete('/', async (req: Request, res: Response) => {
  const url = typeof req.query.url === 'string' ? req.query.url : null;
  if (!url) {
    return res.status(400).json({ error: 'missing url query param' });
  }
  const tid = teamId();

  try {
    const result = await valuationsQb()
      .updateTable('webhook_subscription')
      .set({ deleted_at: new Date(), updated_at: new Date() })
      .where('team_id', '=', tid)
      .where('url', '=', url)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return res
      .status(200)
      .json({ data: { url, deleted: Number(result.numUpdatedRows ?? 0) } });
  } catch (err) {
    return internalError(res, err);
  }
});

// GET /api/v1/valuations/webhooks
//
// Lists active webhook destinations for the calling team. Grouped by URL so
// the response mirrors the destination abstraction the POST/DELETE endpoints
// expose.
webhooksRouter.get('/', async (_req: Request, res: Response) => {
  const tid = teamId();
  try {
    const rows = await valuationsQb()
      .selectFrom('webhook_subscription')
      .where('team_id', '=', tid)
      .where('event_type', 'like', 'valuations:%')
      .where('deleted_at', 'is', null)
      .select(['id', 'url', 'event_type', 'name', 'created_at'])
      .orderBy('created_at', 'desc')
      .execute();
    type Group = { url: string; name: string; eventTypes: string[]; rowIds: string[] };
    const byUrl = new Map<string, Group>();
    for (const r of rows) {
      const existing: Group = byUrl.get(r.url) ?? {
        url: r.url,
        name: r.name,
        eventTypes: [],
        rowIds: [],
      };
      existing.eventTypes.push(r.event_type);
      existing.rowIds.push(r.id);
      byUrl.set(r.url, existing);
    }
    return res.status(200).json({ data: Array.from(byUrl.values()) });
  } catch (err) {
    return internalError(res, err);
  }
});

export { webhooksRouter };
