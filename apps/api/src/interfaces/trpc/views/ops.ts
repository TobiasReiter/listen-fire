import { z } from 'zod';
import { sql } from 'kysely';
import { TRPCError } from '@trpc/server';

import type { OpsEventId } from '../../../generated/kysely/public/OpsEvent';

import { currentContext } from '../../../services/context';
import { trpc } from '../trpc';
import { getQb } from '../../../lib/kysely';
import { anthropicChatStructured } from '../../../lib/anthropic';
import { platformAdminProcedure } from '../procedures';
import { encodeCursor, decodeCursor } from './cursor';
import OpsEventType from '../../../generated/kysely/public/OpsEventType';
import OpsSeverity from '../../../generated/kysely/public/OpsSeverity';
import OpsRunStatus from '../../../generated/kysely/public/OpsRunStatus';

// Read-time enrichment shared by listFeed + getEvent: resolves team_id → team
// name. One helper so the list and the detail can never disagree about what a
// row carries beyond its own columns.
const ENRICHED_TABLES = ['ops_event', 'core.team'] as const;

function enrichedOpsQuery() {
  return getQb(ENRICHED_TABLES)
    .selectFrom('ops_event')
    .leftJoin('core.team as t', 't.id', 'ops_event.team_id');
}

const ENRICHED_SELECT = ['t.name as team_name'] as const;

// Support feedback arrives in whatever language the reporter wrote it in. The
// payload carries no discriminator (the feed reads ops_event.detail
// structurally, same as the admin inspector does), so the translatable shape is
// recognised by its fields.
const feedbackDetail = z.object({ goal: z.string(), friction: z.string() });

// "Needs attention" is what is still open in the operator's eyes. Resolution is
// the only thing that clears it — the event's own status and severity are the
// record of what happened and never change on acknowledgement. One fragment so
// the triage filter and the tile that opens it can never disagree.
const needsAttention = sql<boolean>`ops_event.resolved_at is null and (ops_event.severity::text in (${OpsSeverity.warn}, ${OpsSeverity.critical}) or ops_event.status::text = ${OpsRunStatus.failed})`;

const TRANSLATE_SYSTEM = `You translate product-feedback reports into English for a platform operator.

Translate the "goal" and "friction" fields faithfully: same meaning, same tone, same register, no softening and no embellishment.
Preserve formatting exactly — line breaks, bullets, punctuation, and any product or company names.
Return a field that is already written in English unchanged, word for word.
Never add commentary, notes, apologies, or bracketed explanations.`;

const opsRouter = (procedure: typeof trpc.procedure) => {
  const adminProcedure = platformAdminProcedure(procedure);

  return trpc.router({
    vapidPublicKey: adminProcedure.query(() => process.env.VAPID_PUBLIC_KEY ?? null),

    registerDevice: adminProcedure
      .input(
        z.object({
          endpoint: z.string().url(),
          keys: z.object({ p256dh: z.string(), auth: z.string() }),
          deviceLabel: z.string().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await getQb(['push_subscription'])
          .insertInto('push_subscription')
          .values({
            admin_user_id: ctx.user.id,
            endpoint: input.endpoint,
            p256dh: input.keys.p256dh,
            auth: input.keys.auth,
            device_label: input.deviceLabel ?? null,
          })
          .onConflict((oc) =>
            oc.column('endpoint').doUpdateSet({
              p256dh: input.keys.p256dh,
              auth: input.keys.auth,
            }),
          )
          .execute();
        return { ok: true };
      }),

    // Live counts for the feed's summary strip. Root events only, scoped to
    // today for the volume/activity numbers.
    summary: adminProcedure.query(async () => {
      const today = sql`date_trunc('day', now())`;
      const row = await getQb(['ops_event'])
        .selectFrom('ops_event')
        .select([
          // Actually working. `parked` is excluded deliberately: a run waiting
          // on a person can wait for days, and counting it here made the tile
          // a running total of unanswered asks rather than of live work.
          sql<number>`(count(*) filter (where status::text = ${OpsRunStatus.running}))::int`.as(
            'running',
          ),
          sql<number>`(count(*) filter (where status::text = ${OpsRunStatus.parked}))::int`.as(
            'parked',
          ),
          // Unwindowed on purpose: a warning stays counted until someone deals
          // with it, so this tile equals the length of the list it opens.
          sql<number>`(count(*) filter (where ${needsAttention}))::int`.as('needsAttention'),
          sql<number>`(count(distinct team_id) filter (where created_at >= ${today}))::int`.as(
            'teamsActive',
          ),
          sql<number>`(count(*) filter (where created_at >= ${today}))::int`.as('runsToday'),
        ])
        .where('parent_run_id', 'is', null)
        .executeTakeFirstOrThrow();
      return row;
    }),

    listFeed: adminProcedure
      .input(
        z.object({
          type: z.nativeEnum(OpsEventType).optional(),
          severity: z.nativeEnum(OpsSeverity).optional(),
          needsAttention: z.boolean().optional(),
          limit: z.number().min(1).max(200).default(50),
          cursor: z.string().optional(),
        }),
      )
      .query(async ({ input }) => {
        const cursor = input.cursor ? decodeCursor(input.cursor) : null;

        let qb = enrichedOpsQuery()
          .select([
            'ops_event.id',
            'ops_event.created_at',
            'ops_event.updated_at',
            'ops_event.type',
            'ops_event.severity',
            'ops_event.status',
            'ops_event.team_id',
            'ops_event.title',
            'ops_event.request_id',
            'ops_event.resolved_at',
            ...ENRICHED_SELECT,
          ])
          .where('parent_run_id', 'is', null)
          .orderBy('ops_event.created_at', 'desc')
          .orderBy('ops_event.id', 'desc')
          .limit(input.limit + 1);

        if (input.type !== undefined) qb = qb.where('ops_event.type', '=', input.type);
        if (input.needsAttention) {
          qb = qb.where(needsAttention);
        } else if (input.severity !== undefined) {
          qb = qb.where('ops_event.severity', '=', input.severity);
        }
        if (cursor) {
          qb = qb.where((eb) =>
            eb.or([
              eb('ops_event.created_at', '<', cursor.createdAt),
              eb.and([
                eb('ops_event.created_at', '=', cursor.createdAt),
                eb('ops_event.id', '<', cursor.id as OpsEventId),
              ]),
            ]),
          );
        }

        const rows = await qb.execute();
        const hasMore = rows.length > input.limit;
        const items = hasMore ? rows.slice(0, input.limit) : rows;
        const last = items[items.length - 1];
        const nextCursor =
          hasMore && last
            ? encodeCursor({ createdAt: new Date(last.created_at).toISOString(), id: last.id })
            : null;

        return { items, nextCursor };
      }),

    listRunThread: adminProcedure
      .input(z.object({ runId: z.string() }))
      .query(async ({ input }) => {
        return getQb(['ops_event'])
          .selectFrom('ops_event')
          .select(['id', 'created_at', 'type', 'severity', 'title', 'detail'])
          .where('parent_run_id', '=', input.runId)
          .orderBy('created_at', 'asc')
          .execute();
      }),

    getEvent: adminProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }) => {
        return enrichedOpsQuery()
          .selectAll('ops_event')
          .select([...ENRICHED_SELECT])
          .where('ops_event.id', '=', input.id as OpsEventId)
          .executeTakeFirst();
      }),

    // Operator acknowledgement — "seen and dealt with". It reads as a layer over
    // the event, never into it: nothing about what happened is rewritten.
    setResolved: adminProcedure
      .input(z.object({ id: z.string(), resolved: z.boolean() }))
      .mutation(async ({ input }) => {
        const row = await getQb(['ops_event'])
          .selectFrom('ops_event')
          .select('parent_run_id')
          .where('id', '=', input.id as OpsEventId)
          .executeTakeFirst();

        if (!row) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found' });
        }
        // A run is dealt with as a whole; its steps are the story of how it got
        // there, and acknowledging one of them would say nothing about the run.
        if (row.parent_run_id) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Resolve the run this step belongs to, not the step itself.',
          });
        }

        return getQb(['ops_event'])
          .updateTable('ops_event')
          .set({ resolved_at: input.resolved ? new Date() : null })
          .where('id', '=', input.id as OpsEventId)
          .returning('resolved_at')
          .executeTakeFirstOrThrow();
      }),

    // On-demand English rendering of a support-feedback event. Not persisted:
    // the original is the record, this is a reading aid.
    translateEvent: adminProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        const row = await getQb(['ops_event'])
          .selectFrom('ops_event')
          .select('detail')
          .where('id', '=', input.id as OpsEventId)
          .executeTakeFirst();

        if (!row) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found' });
        }

        const feedback = feedbackDetail.safeParse(row.detail);
        if (!feedback.success) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'This event is not support feedback, so there is nothing to translate.',
          });
        }

        // One call for both fields: they are two halves of the same report, and
        // the second reads better with the first as context.
        return anthropicChatStructured({
          system: TRANSLATE_SYSTEM,
          userMessage: JSON.stringify(feedback.data, null, 2),
          schema: feedbackDetail,
          toolName: 'english_translation',
          toolDescription: 'Return the English rendering of the feedback report.',
          model: 'claude-haiku-4-5-20251001',
          maxTokens: 8192,
          label: 'ops-feedback-translate',
        });
      }),
  });
};

export { opsRouter };
