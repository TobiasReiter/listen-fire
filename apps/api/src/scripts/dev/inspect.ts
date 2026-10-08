/**
 * Dev-loop fake-channels inspection CLI.
 *
 *   pnpm dev:inspect                       → summary across all services
 *   pnpm dev:inspect email                 → email outbox contents
 *   pnpm dev:inspect whatsapp              → whatsapp outbox + seeded inbound media + recent exposed-file blob URLs
 *   pnpm dev:inspect attio                 → attio entities (objects, records, etc.)
 *   pnpm dev:inspect attio companies       → records under the companies object
 *   pnpm dev:inspect slack                 → slack channels + messages
 *   pnpm dev:inspect valuations            → Valuations entity counts + recent outbox
 *   pnpm dev:inspect valuations legal_entity → rows under one Valuations entity
 *   pnpm dev:inspect evertrace             → seeded signals/lists/searches + the evertrace poll trigger
 *   pnpm dev:inspect dealroom              → fake Dealroom entity counts, recent API requests + the dealroom poll trigger
 *   pnpm dev:inspect dealroom --clear-requests → wipe the Dealroom request log first (isolate one run's calls)
 *   pnpm dev:inspect gmail                 → the fake mailbox's change marker, its outbox, + the gmail poll trigger's checkpoint
 *   pnpm dev:inspect crm                   → the fake CRM's companies, comments, subscriptions + parks on it
 *   pnpm dev:inspect callbacks             → minted callbacks + their call ledgers
 *   pnpm dev:inspect callbacks <runId>     → one run's callbacks
 *   pnpm dev:inspect tg-runs               → recent translation-graph runs
 *   pnpm dev:inspect tg-runs <runId>       → full detail of one tg_run row
 *   pnpm dev:inspect work                  → automations work rows (every team's): kind, key, due, lease, attempts
 *   pnpm dev:inspect all --pretty          → everything, human-readable
 *
 *   --reset              clear all fake-channels state (admin endpoint)
 *
 * Most domains read from fake-channels HTTP endpoints (FAKE_CHANNELS_URL,
 * default http://localhost:5556). Valuations is a special case: it lives in
 * the same monorepo, so we read directly from Postgres scoped to the
 * dev-loop team.
 */

// First: the active profile's env (its DATABASE_URL) must be in place before
// the query builders read it, or this reads apps/api/.env's database instead.
import './_profile_loader';

import { sql } from 'kysely';

import { getQb, getAutomationsQb, getValuationsQb } from '../../lib/kysely';
import type { TeamId } from '../../generated/kysely/core/Team';
import { ensureDevLoopTeam } from './_lib';
import { FAKE_CRM_ADAPTER_TYPE, fakeCrmBaseUrl } from './fake_crm_adapter';
import { listAsksForTeam } from '../../services/translation_graph/adapters/ask/store';
import {
  callbackUrl,
  listRunCallbacks,
  listTeamCallbacks,
} from '../../services/movement_engine/callback_store';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';

const FAKE_CHANNELS_URL = process.env.FAKE_CHANNELS_URL || 'http://localhost:5556';

type Domain =
  | 'email'
  | 'whatsapp'
  | 'telegram'
  | 'attio'
  | 'slack'
  | 'sheets'
  | 'airtable'
  | 'granola'
  | 'evertrace'
  | 'dealroom'
  | 'gmail'
  | 'affinity'
  | 'valuations'
  | 'asks'
  | 'callbacks'
  | 'crm'
  | 'tg-runs'
  | 'work'
  | 'all';

const ALL_DOMAINS: Exclude<Domain, 'all'>[] = [
  'email',
  'whatsapp',
  'telegram',
  'attio',
  'slack',
  'sheets',
  'airtable',
  'granola',
  'evertrace',
  'dealroom',
  'gmail',
  'affinity',
  'valuations',
  'asks',
  'callbacks',
  'crm',
  'tg-runs',
  'work',
];

async function http<T = unknown>(path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET'): Promise<T> {
  const res = await fetch(`${FAKE_CHANNELS_URL}${path}`, { method });
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function inspectEmail() {
  const { data } = await http<{ data: any[] }>('/email/outbox');
  return { service: 'email', count: data.length, messages: data };
}

async function inspectWhatsApp() {
  const { data } = await http<{ data: any[] }>('/whatsapp/outbox');
  // Inbound media seeded into the fake Meta Cloud API (served back to the
  // dispatcher's downloadMedia). Empty unless a media inject ran.
  let seededMedia: any[] = [];
  try {
    const media = await http<{ data: any[] }>('/whatsapp/media');
    seededMedia = media.data;
  } catch {
    // Older fake-channels without the media endpoint — tolerate.
  }
  // Recent exposed-file blob URLs: the inbound-media path buffers each media
  // item to S3 via exposeFile and mints a /api/files/blob/:id URL — this is
  // the URL the WhatsApp adapter's fetchUrlToStream resolves. Surfacing them
  // makes "did the bytes get exposed?" a tool, not a psql session.
  const base =
    process.env.EXPOSED_FILE_PUBLIC_BASE_URL ||
    process.env.API_BASE_URL ||
    'http://localhost:3000';
  const exposed = await getAutomationsQb(['exposed_file'])
    .selectFrom('exposed_file')
    .select(['id', 'filename', 'content_type', 'expires_at'])
    .orderBy('expires_at', 'desc')
    .limit(5)
    .execute();
  const exposedFiles = exposed.map((r) => ({
    blobUrl: `${base}/api/files/blob/${r.id}`,
    filename: r.filename,
    contentType: r.content_type,
    expiresAt: r.expires_at,
  }));
  // WhatsApp has no dedicated ack call the way Telegram's `answerCallbackQuery`
  // is — the callback door's ack (and every ordinary threaded reply) is just
  // another send through the SAME outbox, carrying `context.message_id`. No
  // separate fake-channels endpoint is needed; these are two views over
  // `messages` for legibility (`pnpm dev:inject whatsapp --cb-id <cb_…>`
  // produces one of each: the interactive send it taps, and the ack reply).
  const interactiveSends = data.filter((m) => m?.type === 'interactive');
  const threadedReplies = data.filter((m) => m?.context?.message_id !== undefined);
  return {
    service: 'whatsapp',
    outboxCount: data.length,
    messages: data,
    interactiveSends,
    threadedReplies,
    seededMedia,
    recentExposedFiles: exposedFiles,
  };
}

async function inspectTelegram() {
  // The fake Telegram Bot API stores every sent message under /telegram/admin/outbox.
  const { data } = await http<{ data: any[] }>('/telegram/admin/outbox');
  // A button tap leaves two marks: the ack that released the tapper's client,
  // and the absence of `reply_markup` on the message whose keyboard was retired.
  const { data: callbackAcks } = await http<{ data: any[] }>('/telegram/admin/callback-acks');
  return { service: 'telegram', count: data.length, messages: data, callbackAcks };
}

async function inspectAttio(objectSlug?: string) {
  const { data: objects } = await http<{ data: any[] }>('/attio/v2/objects');
  if (objectSlug) {
    const records = await fetch(`${FAKE_CHANNELS_URL}/attio/v2/objects/${objectSlug}/records/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 100 }),
    }).then((r) => r.json());
    return { service: 'attio', object: objectSlug, records: records.data ?? [] };
  }
  // Fan out: each object gets a count of records
  const summary: Record<string, number> = {};
  for (const o of objects) {
    const slug = o.api_slug ?? o.id?.object_id;
    if (!slug) continue;
    const q = await fetch(`${FAKE_CHANNELS_URL}/attio/v2/objects/${slug}/records/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 1000 }),
    }).then((r) => r.json());
    summary[slug] = (q.data ?? []).length;
  }
  return { service: 'attio', objects: objects.map((o) => o.api_slug ?? o), recordCountsByObject: summary };
}

async function inspectSlack() {
  // The fake's admin dump carries every stored entity (channels, posted
  // messages, …) — the conversations.* endpoints are POST-only, so the
  // admin surface is the read path here.
  try {
    const state = (await fetch(`${FAKE_CHANNELS_URL}/admin/slack/state`).then((r) =>
      r.json(),
    )) as Record<string, unknown[]>;
    return {
      service: 'slack',
      channels: state.channel ?? [],
      messages: state.message ?? [],
      // Reactions are write-only on the adapter, so this dump is the only way
      // to see that a `msg-[:Reactions]->` write landed on the right message.
      reactions: state.reaction ?? [],
    };
  } catch {
    return { service: 'slack', channels: [], messages: [], reactions: [] };
  }
}

// Valuations entity catalog — mirror of `ENTITIES` in the adapter / webhook
// provider. Each Valuations table holds rows for every team, so all queries
// here filter by `team_id`.
const VALUATIONS_TABLES = [
  'legal_entity',
  'investment',
  'transaction',
  'asset',
  'asset_transfer',
  'price',
  'event',
] as const;
type ValuationsTable = (typeof VALUATIONS_TABLES)[number];

async function inspectValuations(sub?: string) {
  const seed = await ensureDevLoopTeam();
  const teamId = seed.teamId as TeamId;

  if (sub) {
    if (!(VALUATIONS_TABLES as readonly string[]).includes(sub)) {
      throw new Error(
        `Unknown Valuations entity: ${sub}. Known: ${VALUATIONS_TABLES.join(', ')}`,
      );
    }
    const table = sub as ValuationsTable;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (getQb([table] as any) as any)
      .selectFrom(table)
      .where('team_id', '=', teamId)
      .selectAll()
      .limit(100)
      .execute();
    return { service: 'valuations', entity: table, count: rows.length, rows };
  }

  // Aggregate: per-entity row counts + the last few outbox entries, so the
  // operator can see both steady state and what's been emitted recently.
  const counts: Record<string, number> = {};
  for (const table of VALUATIONS_TABLES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (getQb([table] as any) as any)
      .selectFrom(table)
      .where('team_id', '=', teamId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .select((eb: any) => eb.fn.countAll().as('n'))
      .executeTakeFirst();
    counts[table] = rows ? Number(rows.n) : 0;
  }
  const recentOutbox = await getValuationsQb(['valuations_change_outbox'])
    .selectFrom('valuations_change_outbox')
    .where('team_id', '=', teamId)
    .select(['id', 'entity', 'change_type', 'row_id', 'occurred_at'])
    .orderBy('occurred_at', 'desc')
    .limit(10)
    .execute();
  return {
    service: 'valuations',
    teamId,
    countsByEntity: counts,
    recentOutbox,
  };
}

async function inspectAsks() {
  const seed = await ensureDevLoopTeam();
  const teamId = seed.teamId as TeamId;
  const asks = await listAsksForTeam(teamId, 50);
  return {
    service: 'asks',
    teamId,
    count: asks.length,
    asks: asks.map((a) => ({
      id: a.id,
      family: a.family,
      state: a.state,
      prompt: a.prompt,
      answerType: a.answerType,
      options: a.options,
      answer: a.answer,
      url: a.url,
      createdAt: a.createdAt,
      answeredAt: a.answeredAt,
      expiredAt: a.expiredAt,
      provenance: a.provenance,
    })),
  };
}

/** Minted callbacks and what has been fired at them — the run-scoped view of
 *  the deferred invocations a movement handed out. */
async function inspectCallbacks(sub?: string) {
  const seed = await ensureDevLoopTeam();
  const teamId = seed.teamId as TeamId;
  const callbacks = sub
    ? await listRunCallbacks(sub as TriggerRunId)
    : await listTeamCallbacks(teamId, 50);
  return {
    service: 'callbacks',
    teamId,
    ...(sub ? { object: sub } : {}),
    count: callbacks.length,
    callbacks: callbacks.map((c) => ({
      id: c.id,
      runId: c.runId,
      // The entry point: which callback expression, in the run's pinned version.
      address: c.address,
      status: c.status,
      singleUse: c.singleUse,
      params: c.params,
      calls: c.calls,
      url: callbackUrl(c.id),
      expiresAt: c.expiresAt,
      createdAt: c.createdAt,
      firedAt: c.firedAt,
      revokedAt: c.revokedAt,
    })),
  };
}

async function inspectTgRuns(sub?: string) {
  const seed = await ensureDevLoopTeam();
  const teamId = seed.teamId as TeamId;
  const limit = 25;

  if (sub) {
    // sub is a run id — full detail
    const row = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', sub as never)
      .where('team_id', '=', teamId)
      .selectAll()
      .executeTakeFirst();
    if (!row) {
      throw new Error(`trigger_run ${sub} not found for dev-loop team`);
    }
    return { service: 'tg-runs', runId: sub, run: row };
  }

  const rows = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('team_id', '=', teamId)
    .orderBy('created_at desc')
    .select([
      'id',
      'trigger_id',
      'trigger_type',
      'status',
      'record_id',
      'steps',
      'errors',
      'nodes_written',
      'started_at',
      'completed_at',
      'failed_at',
      'failure_reason',
      'created_at',
    ])
    .limit(limit)
    .execute();
  return { service: 'tg-runs', teamId, limit, count: rows.length, rows };
}

const PAYLOAD_SUMMARY_CHARS = 120;

/** The drain's queue as it stands: every work row, soonest due first, beside
 *  the database clock the claim compares `due_at` and the lease against. */
async function inspectWork() {
  const qb = getAutomationsQb(['work']);
  const clock = await sql<{ now: Date }>`select now() as now`.execute(qb);
  const rows = await qb
    .selectFrom('work')
    .orderBy('due_at asc')
    .select(['kind', 'key', 'team_id', 'due_at', 'interval_ms', 'lease_owner', 'lease_until', 'attempts', 'deferrals', 'payload'])
    .execute();
  return {
    service: 'work',
    now: clock.rows[0]?.now,
    count: rows.length,
    rows: rows.map(({ payload, ...row }) => {
      const text = JSON.stringify(payload);
      return {
        ...row,
        payload: text.length > PAYLOAD_SUMMARY_CHARS ? `${text.slice(0, PAYLOAD_SUMMARY_CHARS)}…` : text,
      };
    }),
  };
}

/**
 * Airtable-specific view: the fake's registered webhooks + per-webhook payload
 * feeds (notify-then-pull state), the seeded bases/tables, AND the real
 * `webhook_subscription` rows the listen reconciler provisioned (with the
 * persisted `inbound_checkpoint` cursor) — the fastest "did the listen register
 * and where is the pull cursor?" view.
 */
async function inspectAirtable() {
  const seed = await ensureDevLoopTeam();
  let entities: Record<string, unknown[]> | null = null;
  try {
    entities = await http<Record<string, unknown[]>>('/admin/airtable/state');
  } catch {
    entities = null;
  }
  // Group payload feeds (entity_type `payload:<webhookId>`) under their webhook.
  const webhooks = (entities?.webhook ?? []) as { id?: string }[];
  const payloadFeeds: Record<string, unknown[]> = {};
  for (const [type, rows] of Object.entries(entities ?? {})) {
    if (type.startsWith('payload:')) payloadFeeds[type.slice('payload:'.length)] = rows;
  }

  const subscriptions = await getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('team_id', '=', seed.teamId as TeamId)
    .where('provider', '=', 'AIRTABLE')
    .where('deleted_at', 'is', null)
    .select([
      'id',
      'external_webhook_id',
      'status',
      'scope',
      'subscriptions',
      'inbound_checkpoint',
      'provisioned_by',
      'updated_at',
    ])
    .execute();

  return {
    service: 'airtable',
    teamId: seed.teamId,
    bases: entities?.base ?? [],
    tables: Object.entries(entities ?? {})
      .filter(([t]) => t.startsWith('table:'))
      .flatMap(([, rows]) => rows),
    webhooks,
    payloadFeeds,
    subscriptions,
  };
}

/**
 * Granola-specific view: the notes seeded into the fake Granola API + the
 * dev-loop team's granola POLL trigger rows with their `poll_checkpoint` /
 * `poll_last_at` (the fastest "did the poll advance the high-water mark?" view).
 */
async function inspectGranola() {
  const seed = await ensureDevLoopTeam();
  let notes: unknown[] = [];
  try {
    const state = await http<Record<string, unknown[]>>('/admin/granola/state');
    notes = state.note ?? [];
  } catch {
    notes = [];
  }

  const triggers = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('team_id', '=', seed.teamId as TeamId)
    .where('kind', '=', 'granola')
    .select([
      'id',
      'kind',
      'run_mode',
      'credentials_id',
      'movement_id',
      'fired_movement_name',
      'poll_checkpoint',
      'poll_last_at',
    ])
    .execute();

  return { service: 'granola', teamId: seed.teamId, seededNotes: notes, triggers };
}

/**
 * Evertrace-specific view: signals + lists (with their entries) seeded into
 * the fake Evertrace API, the searches, and the dev-loop team's evertrace
 * POLL trigger rows with their `poll_checkpoint` / `poll_last_at`. Each listen
 * is its own row, so the signal listener's `createdAfter` and the list
 * listener's `entriesCreatedAfter` both show — `config` says which is which.
 */
async function inspectEvertrace() {
  const seed = await ensureDevLoopTeam();
  let signals: unknown[] = [];
  let lists: unknown[] = [];
  let searches: unknown[] = [];
  try {
    const state = await http<Record<string, unknown[]>>('/admin/evertrace/state');
    signals = state.signal ?? [];
    searches = state.search ?? [];
    const listEntries = state.listEntry ?? [];
    lists = (state.list ?? []).map((l) => ({
      ...(l as Record<string, unknown>),
      entries: listEntries.filter((e) => (e as Record<string, unknown>).listId === (l as Record<string, unknown>).id),
    }));
  } catch {
    // fake-channels not up — surface an empty view rather than throwing.
  }

  const triggers = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('team_id', '=', seed.teamId as TeamId)
    .where('kind', '=', 'evertrace')
    .select([
      'id',
      'kind',
      'run_mode',
      'config',
      'credentials_id',
      'movement_id',
      'fired_movement_name',
      'poll_checkpoint',
      'poll_last_at',
    ])
    .execute();

  return { service: 'evertrace', teamId: seed.teamId, signals, lists, searches, triggers };
}

/**
 * Dealroom-specific view: what the fake Dealroom API holds, the calls the
 * adapter last made to it, and the dev-loop team's dealroom POLL trigger rows
 * with their `poll_checkpoint` / `poll_last_at`.
 *
 * The request log is the pushdown evidence. A response alone cannot tell a
 * search Dealroom narrowed from one the engine filtered afterwards — both
 * return the same rows — so each entry shows what actually went on the wire:
 * `keyword` (a Name or Website WHERE), `form_data.must` (every other pushed
 * WHERE), `sort` (a pushed ORDER BY) and `limit`.
 */
async function inspectDealroom(options: { clearRequests?: boolean } = {}) {
  const seed = await ensureDevLoopTeam();
  if (options.clearRequests) {
    try {
      await http('/admin/dealroom/request_log/state', 'DELETE');
    } catch {
      // fake-channels not up — the counts below will show empty too.
    }
  }

  let counts: Record<string, number> = {};
  let requests: unknown[] = [];
  let recentRounds: unknown[] = [];
  try {
    const state = await http<Record<string, Record<string, unknown>[]>>('/admin/dealroom/state');
    counts = Object.fromEntries(
      Object.entries(state)
        .filter(([type]) => type !== 'request_log')
        .map(([type, rows]) => [type, rows.length]),
    );
    requests = (state.request_log ?? [])
      .slice()
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .map((entry) => {
        const body = (entry.body ?? {}) as Record<string, unknown>;
        return {
          at: entry.at,
          call: `${entry.method} ${entry.path}`,
          ...(entry.query && Object.keys(entry.query).length > 0 ? { query: entry.query } : {}),
          ...(body.keyword !== undefined
            ? { keyword: body.keyword, keyword_type: body.keyword_type, keyword_match_type: body.keyword_match_type }
            : {}),
          ...(body.form_data !== undefined ? { form_data: body.form_data } : {}),
          ...(body.sort !== undefined ? { sort: body.sort } : {}),
          ...(body.limit !== undefined ? { limit: body.limit, offset: body.offset } : {}),
        };
      });
    recentRounds = (state.round ?? [])
      .slice()
      .sort((a, b) => String(b.created_utc ?? '').localeCompare(String(a.created_utc ?? '')))
      .slice(0, 5)
      .map((r) => ({ id: r.id, companyId: r.companyId, round: r.round, amount: r.amount, created_utc: r.created_utc }));
  } catch {
    // fake-channels not up — surface an empty view rather than throwing.
  }

  const triggers = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('team_id', '=', seed.teamId as TeamId)
    .where('kind', '=', 'dealroom')
    .select([
      'id',
      'kind',
      'run_mode',
      'config',
      'credentials_id',
      'movement_id',
      'fired_movement_name',
      'poll_checkpoint',
      'poll_last_at',
    ])
    .execute();

  return { service: 'dealroom', teamId: seed.teamId, counts, recentRounds, requests, triggers };
}

/**
 * Gmail-specific view: what the fake mailbox holds (its change marker and how
 * far back history still reaches), what it has SENT, and the dev-loop team's
 * gmail POLL trigger rows with their `poll_checkpoint` / `poll_last_at`.
 *
 * The checkpoint is the evidence for a read. `historyId` advancing across a
 * poll is a normal tick; `historyId` jumping while `lastSeenAt` carried the
 * window is a resync after Gmail dropped the marker. The OUTBOX is the evidence
 * for a write: a reply shows the thread it joined and the `In-Reply-To` it
 * carried, which is the whole of what makes it a reply rather than new mail.
 */
async function inspectGmail() {
  const seed = await ensureDevLoopTeam();

  let mailbox: unknown = null;
  let messages: unknown[] = [];
  let outbox: unknown[] = [];
  try {
    const state = await http<{ mailbox: unknown; messages: unknown[]; outbox?: unknown[] }>(
      '/fake-gmail/state',
    );
    mailbox = state.mailbox;
    messages = state.messages.slice(-5);
    outbox = (state.outbox ?? []).slice(-5);
  } catch {
    // fake-channels not up — surface an empty view rather than throwing.
  }

  const triggers = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('team_id', '=', seed.teamId as TeamId)
    .where('kind', '=', 'gmail')
    .select([
      'id',
      'kind',
      'run_mode',
      'config',
      'credentials_id',
      'movement_id',
      'fired_movement_name',
      'poll_checkpoint',
      'poll_last_at',
    ])
    .execute();

  return {
    service: 'gmail',
    teamId: seed.teamId,
    mailbox,
    recentMessages: messages,
    outbox,
    triggers,
  };
}

/** The fake CRM (the reference remote adapter): its own ledgers, read from
 *  its dev route, plus the runs parked on it here. */
async function inspectFakeCrm() {
  const seed = await ensureDevLoopTeam();
  let state: unknown = null;
  try {
    const res = await fetch(new URL('dev/state', fakeCrmBaseUrl()));
    state = await res.json();
  } catch (err) {
    state = { unreachable: err instanceof Error ? err.message : String(err) };
  }
  const parks = await getAutomationsQb(['adapter_await'])
    .selectFrom('adapter_await')
    .where('team_id', '=', seed.teamId as TeamId)
    .where('adapter_type', '=', FAKE_CRM_ADAPTER_TYPE)
    .selectAll()
    .execute();
  return { service: 'crm', baseUrl: fakeCrmBaseUrl(), state, parks };
}

async function inspectGeneric(svc: 'sheets' | 'affinity') {
  // Dump the service's entities via the admin state route. The route is
  // `/admin/:service/state` and returns entities grouped by entity_type
  // (admin.ts) — NOT a top-level `/admin/state` with a `data` envelope.
  try {
    const grouped = await http<Record<string, unknown[]>>(`/admin/${svc}/state`);
    return { service: svc, entities: grouped };
  } catch {
    return { service: svc, entities: null };
  }
}

async function reset() {
  await http('/email/outbox', 'DELETE');
  await http('/whatsapp/outbox', 'DELETE');
  try {
    await http('/telegram/admin/outbox', 'DELETE');
  } catch {}
  // Wipe + re-seed all fake-channels state (Attio/Slack/Airtable/Sheets/…).
  // The admin route is `DELETE /admin/all` (admin.ts); there is no
  // `POST /admin/reset`.
  try {
    await http('/admin/all', 'DELETE');
  } catch {}
  console.error('[inspect] reset complete');
}

async function main() {
  const args = process.argv
    .slice(2)
    .filter((a) => a !== '--pretty' && a !== '--reset' && a !== '--clear-requests');
  const flags = new Set(process.argv.slice(2));
  const PRETTY = flags.has('--pretty');
  const RESET = flags.has('--reset');
  // Wipe the Dealroom request log before reading, so the next run's calls are
  // the only ones in it.
  const CLEAR_REQUESTS = flags.has('--clear-requests');

  if (RESET) {
    await reset();
    return;
  }

  const domain = (args[0] || 'all') as Domain;
  const sub = args[1];

  const results: any[] = [];
  if (domain === 'all') {
    results.push(await inspectEmail());
    results.push(await inspectWhatsApp());
    results.push(await inspectTelegram());
    results.push(await inspectAttio());
    results.push(await inspectSlack());
    results.push(await inspectAirtable());
    results.push(await inspectGranola());
    results.push(await inspectEvertrace());
    results.push(await inspectDealroom());
    for (const svc of ['sheets', 'affinity'] as const) {
      results.push(await inspectGeneric(svc));
    }
    results.push(await inspectValuations());
    results.push(await inspectAsks());
    results.push(await inspectCallbacks());
    results.push(await inspectFakeCrm());
    results.push(await inspectTgRuns());
    results.push(await inspectWork());
  } else if (domain === 'email') {
    results.push(await inspectEmail());
  } else if (domain === 'whatsapp') {
    results.push(await inspectWhatsApp());
  } else if (domain === 'telegram') {
    results.push(await inspectTelegram());
  } else if (domain === 'attio') {
    results.push(await inspectAttio(sub));
  } else if (domain === 'slack') {
    results.push(await inspectSlack());
  } else if (domain === 'valuations') {
    results.push(await inspectValuations(sub));
  } else if (domain === 'asks') {
    results.push(await inspectAsks());
  } else if (domain === 'callbacks') {
    results.push(await inspectCallbacks(sub));
  } else if (domain === 'crm') {
    results.push(await inspectFakeCrm());
  } else if (domain === 'tg-runs') {
    results.push(await inspectTgRuns(sub));
  } else if (domain === 'work') {
    results.push(await inspectWork());
  } else if (domain === 'airtable') {
    results.push(await inspectAirtable());
  } else if (domain === 'granola') {
    results.push(await inspectGranola());
  } else if (domain === 'evertrace') {
    results.push(await inspectEvertrace());
  } else if (domain === 'dealroom') {
    results.push(await inspectDealroom({ clearRequests: CLEAR_REQUESTS }));
  } else if (domain === 'gmail') {
    results.push(await inspectGmail());
  } else if (['sheets', 'affinity'].includes(domain)) {
    results.push(await inspectGeneric(domain as any));
  } else {
    console.error(`Unknown domain: ${domain}. Use one of: ${ALL_DOMAINS.join(', ')}, all`);
    process.exit(2);
  }

  if (PRETTY) {
    for (const r of results) {
      console.log(`── ${r.service} ${r.object ? `(${r.object})` : ''} ──`);
      console.log(JSON.stringify(r, null, 2));
      console.log();
    }
  } else {
    console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
