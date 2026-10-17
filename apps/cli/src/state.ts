// The host's state, in SQLite at `.lf/state.db` (or a temporary file with
// `--ephemeral`): the run log, each run's trace, record bindings, and the run
// host's backend families (store.ts in the run-host core): parked leaves, the
// joins they hold, await correlations, the run lease and the work queue
// `lf serve` drains, and the callbacks a run mints. The families mean what the hosted Postgres backend's
// mean, held to it by the run host's contract suite; the rules over them are
// the core's. Every write that must not interleave with another process's
// runs in one `begin immediate` transaction, so `lf resume` and a running
// `lf serve` can share one state file.

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { BindingEndpoint, EncodedEndpoint } from 'movement-engine/services/movement_engine/host';
import { RunLeaseLost } from 'movement-engine/services/movement_engine/errors';
import type {
  CallbackClaim,
  CallbackRecord,
  CallbackStore,
  ClaimedWork,
  LeafRow as CoreLeafRow,
  RunHostStore,
} from 'movement-engine/services/run_host/store';
import { callbackBodyWork, callbackRefusal, isCallbackId, newCallbackId } from 'movement-engine/services/run_host/callbacks';
import { CALLBACK_PARAM_TYPES, CORE_PARK_REASONS } from 'engine-contracts';
import {
  asEncoded,
  encodeEndpoint,
  orderEndpoints,
} from 'movement-engine/services/translation_graph/movement/binding_endpoint';
import type { Project } from './project';

const RunStatus = z.enum(['running', 'completed', 'parked', 'failed']);
export type RunStatus = z.infer<typeof RunStatus>;

const RunRow = z.object({
  id: z.string(),
  file: z.string(),
  movement: z.string(),
  status: RunStatus,
  started_at: z.string(),
  finished_at: z.string().nullable(),
  /** The run's facts a resume needs, as JSON: source, event, language version. */
  input: z.string(),
  outcome: z.string().nullable(),
  /** When an operator asked to cancel the run (`lf cancel`), and why. */
  cancel_requested_at: z.string().nullable(),
  cancel_reason: z.string().nullable(),
});
export type RunRow = z.infer<typeof RunRow>;

export const WorkKind = z.enum(['resume_timer', 'wake_await', 'fire_event', 'fire_callback']);
export type WorkKind = z.infer<typeof WorkKind>;

const WorkRow = z.object({
  id: z.number().int(),
  kind: WorkKind,
  key: z.string(),
  payload: z.string(),
  due_at: z.string(),
  lease_token: z.string().nullable(),
  /** Bumped by every enqueue and claim: a completion deletes the row only if
   *  nothing re-armed it since its claim. */
  version: z.number().int(),
});
export type WorkRow = z.infer<typeof WorkRow>;

const LeafRow = z.object({
  address: z.string(),
  reason: z.enum(CORE_PARK_REASONS),
  status: z.enum(['parked', 'resuming']),
  wake_at: z.string().nullable(),
});

const CallbackRow = z.object({
  id: z.string(),
  team_id: z.string(),
  run_id: z.string(),
  address: z.string(),
  params: z.string(),
  state: z.string(),
  calls: z.string(),
  single_use: z.number().int(),
  expires_at: z.string().nullable(),
  status: z.enum(['live', 'fired', 'revoked']),
});

const CallbackParams = z.array(z.object({ name: z.string(), type: z.enum(CALLBACK_PARAM_TYPES) }));
const CallbackLedger = z.array(
  z.object({ at: z.string(), values: z.record(z.string(), z.unknown()), bodyStartedAt: z.string().optional() }),
);

function callbackOf(row: unknown): CallbackRecord {
  const r = CallbackRow.parse(row);
  return {
    id: r.id,
    teamId: r.team_id,
    runId: r.run_id,
    address: r.address,
    params: CallbackParams.parse(JSON.parse(r.params)),
    state: JSON.parse(r.state),
    calls: CallbackLedger.parse(JSON.parse(r.calls)).map(({ at, values, bodyStartedAt }) => ({
      at,
      values,
      ...(bodyStartedAt !== undefined ? { bodyStartedAt } : {}),
    })),
    singleUse: r.single_use === 1,
    expiresAt: r.expires_at,
    status: r.status,
  };
}

/** A work claim's handle: the lease it took and the version it saw. */
const WorkClaim = z.string().transform((claim, ctx) => {
  const at = claim.lastIndexOf('/');
  const version = Number(claim.slice(at + 1));
  if (at <= 0 || !Number.isInteger(version)) {
    ctx.addIssue({ code: 'custom', message: `not a work claim: ${claim}` });
    return z.NEVER;
  }
  return { leaseToken: claim.slice(0, at), version };
});

// `leaf` replaces the `park` table of earlier lf versions, which kept an
// await's correlation on its row and named a limit park `suspension`. A state
// file written by one of those still opens: its `park` table is left as it
// was, and read by nothing.
const SCHEMA = `
create table if not exists run (
  id text primary key,
  file text not null,
  movement text not null,
  status text not null,
  started_at text not null,
  finished_at text,
  input text not null,
  outcome text,
  lease_token text,
  lease_until text
);
create table if not exists trace (
  run_id text not null,
  seq integer not null,
  entry text not null,
  primary key (run_id, seq)
);
create table if not exists leaf (
  run_id text not null,
  address text not null,
  reason text not null,
  status text not null default 'parked',
  wake_at text,
  state text not null,
  primary key (run_id, address)
);
create table if not exists await_correlation (
  run_id text not null,
  team_id text not null,
  address text not null,
  adapter_type text not null,
  correlation_key text not null,
  primary key (run_id, address)
);
create index if not exists await_correlation_key on await_correlation (team_id, adapter_type, correlation_key);
create table if not exists join_frame (
  run_id text not null,
  frame_address text not null,
  pending integer not null,
  closed_by_address text,
  primary key (run_id, frame_address)
);
create table if not exists join_branch_export (
  run_id text not null,
  frame_address text not null,
  branch_address text not null,
  branch_index integer not null,
  exports text not null,
  decremented integer not null default 0,
  primary key (run_id, frame_address, branch_address)
);
create table if not exists record_binding (
  a_adapter_type text not null,
  a_instance_key text not null,
  a_type_id text not null,
  a_record_id text not null,
  b_adapter_type text not null,
  b_instance_key text not null,
  b_type_id text not null,
  b_record_id text not null,
  bound_seq integer not null,
  primary key (a_adapter_type, a_instance_key, a_type_id, a_record_id, b_adapter_type, b_instance_key, b_type_id, b_record_id)
);
create table if not exists park_library_source (
  team_id text not null,
  hash text not null,
  source text not null,
  primary key (team_id, hash)
);
create table if not exists callback (
  id text primary key,
  team_id text not null,
  run_id text not null,
  address text not null,
  params text not null,
  state text not null,
  calls text not null,
  single_use integer not null,
  expires_at text,
  status text not null,
  created_at text not null,
  fired_at text,
  revoked_at text
);
create index if not exists callback_run on callback (run_id);
create table if not exists inbound_checkpoint (
  subscription_id text primary key,
  checkpoint text not null
);
create table if not exists work (
  id integer primary key autoincrement,
  kind text not null,
  key text not null unique,
  payload text not null,
  due_at text not null,
  lease_token text,
  lease_until text,
  version integer not null default 0
);
`;

/** How long a work lease lasts without renewal. */
export const LEASE_TTL_MS = 60_000;

export class State {
  readonly path: string;
  /** The run host's backend families over this file. */
  readonly store: RunHostStore;
  /** The callbacks runs mint, over this file. */
  readonly callbacks: CallbackStore;
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  /** How far ahead of `now` what is due is judged (timers, work rows). */
  private readonly dueOffsetMs: number;

  constructor(path: string, options: { now?: () => Date; dueClockOffsetMs?: number } = {}) {
    this.path = path;
    this.now = options.now ?? (() => new Date());
    this.dueOffsetMs = options.dueClockOffsetMs ?? 0;
    this.db = new DatabaseSync(path);
    // Two lf processes (`lf serve` and `lf resume`) may share the file: readers
    // never block the writer, and a writer waits for another's transaction.
    this.db.exec('pragma journal_mode = wal; pragma busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.addMissingColumns();
    this.store = this.families();
    this.callbacks = this.callbackFamily();
  }

  static open(project: Project, options: { ephemeral: boolean; dueClockOffsetMs?: number }): State {
    const path = options.ephemeral
      ? join(mkdtempSync(join(tmpdir(), 'lf-')), 'state.db')
      : join(project.lfDir, 'state.db');
    return new State(path, { ...(options.dueClockOffsetMs !== undefined ? { dueClockOffsetMs: options.dueClockOffsetMs } : {}) });
  }

  close(): void {
    this.db.close();
  }

  /** Columns a state file written by an earlier lf lacks. */
  private addMissingColumns(): void {
    const columns = new Set(
      this.db
        .prepare('pragma table_info(run)')
        .all()
        .map((r) => z.object({ name: z.string() }).parse(r).name),
    );
    for (const column of ['cancel_requested_at', 'cancel_reason']) {
      if (!columns.has(column)) this.db.exec(`alter table run add column ${column} text`);
    }
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

  /** The instant what is due is judged by: now, or `LF_CLOCK_AHEAD_MS` on. */
  dueBy(): string {
    return this.iso(this.dueOffsetMs);
  }

  /** One write transaction, taken before its first read so two processes
   *  never interleave a read-then-write. */
  private transaction<T>(body: () => T): T {
    this.db.exec('begin immediate');
    try {
      const result = body();
      this.db.exec('commit');
      return result;
    } catch (error) {
      this.db.exec('rollback');
      throw error;
    }
  }

  // ── Inbound pull cursors ──────────────────────────────────────────────────

  /** The cursor an external's `preprocessInbound` last returned for this install. */
  inboundCheckpoint(subscriptionId: string): unknown {
    const row = this.db.prepare('select checkpoint from inbound_checkpoint where subscription_id = ?').get(subscriptionId);
    return row === undefined ? null : JSON.parse(z.object({ checkpoint: z.string() }).parse(row).checkpoint);
  }

  saveInboundCheckpoint(subscriptionId: string, checkpoint: unknown): void {
    this.db
      .prepare('insert into inbound_checkpoint (subscription_id, checkpoint) values (?, ?) on conflict (subscription_id) do update set checkpoint = excluded.checkpoint')
      .run(subscriptionId, JSON.stringify(checkpoint));
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  startRun(row: Pick<RunRow, 'id' | 'file' | 'movement' | 'started_at' | 'input'>): void {
    this.db
      .prepare('insert into run (id, file, movement, status, started_at, input) values (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.file, row.movement, 'running', row.started_at, row.input);
  }

  /** Record where the run stands. A run that ends, however it ends, revokes
   *  its live callbacks: a callback is something the run can still react to. */
  settleRun(id: string, status: RunStatus, outcome: unknown, at: string): void {
    const ended = status === 'completed' || status === 'failed';
    this.transaction(() => {
      this.db.prepare('update run set status = ?, outcome = ?, finished_at = ? where id = ?').run(status, JSON.stringify(outcome ?? null), ended ? at : null, id);
      if (ended) this.revokeCallbacks(id);
    });
  }

  /** The run is observably parked (a park landed). A settled run stays. */
  markParked(id: string): void {
    this.db.prepare("update run set status = 'parked' where id = ? and status in ('running', 'parked')").run(id);
  }

  /** The run is over without completing. A run already settled stays. */
  markFailed(id: string, message: string): void {
    this.transaction(() => {
      this.db
        .prepare("update run set status = 'failed', outcome = ?, finished_at = ? where id = ? and status in ('running', 'parked')")
        .run(JSON.stringify({ error: message }), this.iso(), id);
      this.revokeCallbacks(id);
    });
  }

  private revokeCallbacks(runId: string): void {
    this.db.prepare("update callback set status = 'revoked', revoked_at = ? where run_id = ? and status = 'live'").run(this.iso(), runId);
  }

  /** An operator asks to cancel the run. The first request's reason stands;
   *  a run already over takes none. True when the run is open and now
   *  carries a request. */
  requestCancel(id: string, reason: string | null): boolean {
    this.db
      .prepare(
        "update run set cancel_requested_at = ?, cancel_reason = ? where id = ? and cancel_requested_at is null and status in ('running', 'parked')",
      )
      .run(this.iso(), reason, id);
    const row = this.run(id);
    return row !== undefined && row.cancel_requested_at !== null && (row.status === 'running' || row.status === 'parked');
  }

  /** The operator's cancel request on the run, or null. */
  cancelRequest(id: string): { reason: string | null } | null {
    const row = this.run(id);
    return row?.cancel_requested_at != null ? { reason: row.cancel_reason } : null;
  }

  run(id: string): RunRow | undefined {
    const row = this.db.prepare('select * from run where id = ?').get(id);
    return row === undefined ? undefined : RunRow.parse(row);
  }

  runs(limit = 50): RunRow[] {
    return this.db.prepare('select * from run order by started_at desc limit ?').all(limit).map((r) => RunRow.parse(r));
  }

  // ── Trace ─────────────────────────────────────────────────────────────────

  appendTrace(runId: string, entries: unknown[]): void {
    this.transaction(() => {
      const next = z
        .object({ next: z.number().int() })
        .parse(this.db.prepare('select coalesce(max(seq), -1) + 1 as next from trace where run_id = ?').get(runId)).next;
      const insert = this.db.prepare('insert into trace (run_id, seq, entry) values (?, ?, ?)');
      entries.forEach((entry, i) => insert.run(runId, next + i, JSON.stringify(entry)));
    });
  }

  trace(runId: string): unknown[] {
    return this.db
      .prepare('select entry from trace where run_id = ? order by seq')
      .all(runId)
      .map((r) => JSON.parse(z.object({ entry: z.string() }).parse(r).entry));
  }

  // ── Record bindings ───────────────────────────────────────────────────────

  /** A symmetric binding: one row for the canonically ordered pair, whichever
   *  side asked. Re-asserting it makes it the most recent. */
  recordBinding(input: { from: BindingEndpoint; to: BindingEndpoint }): void {
    const { a, b } = orderEndpoints(encodeEndpoint(input.from), encodeEndpoint(input.to));
    this.transaction(() => {
      const seq = this.nextBindingSeq();
      this.db
        .prepare(
          `insert into record_binding values (?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict do update set bound_seq = excluded.bound_seq`,
        )
        .run(a.adapterType, a.instanceKey, a.typeId, a.recordId, b.adapterType, b.instanceKey, b.typeId, b.recordId, seq);
    });
  }

  /** The record bound to `endpoint` (on either side), restricted to the
   *  counterpart's instance and type when given; the most recently bound
   *  when there are several. */
  findBoundCounterpart(input: { endpoint: BindingEndpoint; counterpart?: Omit<BindingEndpoint, 'recordId'> }): EncodedEndpoint | null {
    const e = encodeEndpoint(input.endpoint);
    const cp = input.counterpart !== undefined ? encodeEndpoint({ ...input.counterpart, recordId: '' }) : undefined;
    const side = (self: 'a' | 'b', other: 'a' | 'b') =>
      `(${self}_adapter_type = ? and ${self}_instance_key = ? and ${self}_type_id = ? and ${self}_record_id = ?` +
      (cp !== undefined ? ` and ${other}_adapter_type = ? and ${other}_instance_key = ? and ${other}_type_id = ?)` : ')');
    const args = [e.adapterType, e.instanceKey, e.typeId, e.recordId, ...(cp !== undefined ? [cp.adapterType, cp.instanceKey, cp.typeId] : [])];
    const row = this.db
      .prepare(`select * from record_binding where ${side('a', 'b')} or ${side('b', 'a')} order by bound_seq desc limit 1`)
      .get(...args, ...args);
    if (row === undefined) return null;
    const r = BindingRow.parse(row);
    const aMatches = r.a_adapter_type === e.adapterType && r.a_instance_key === e.instanceKey && r.a_type_id === e.typeId && r.a_record_id === e.recordId;
    return aMatches
      ? { adapterType: r.b_adapter_type, instanceKey: r.b_instance_key, typeId: r.b_type_id, recordId: r.b_record_id }
      : { adapterType: r.a_adapter_type, instanceKey: r.a_instance_key, typeId: r.a_type_id, recordId: r.a_record_id };
  }

  deleteBinding(input: { from: BindingEndpoint | EncodedEndpoint; to: BindingEndpoint | EncodedEndpoint }): void {
    const { a, b } = orderEndpoints(asEncoded(input.from), asEncoded(input.to));
    this.db
      .prepare(
        `delete from record_binding where a_adapter_type = ? and a_instance_key = ? and a_type_id = ? and a_record_id = ?
           and b_adapter_type = ? and b_instance_key = ? and b_type_id = ? and b_record_id = ?`,
      )
      .run(a.adapterType, a.instanceKey, a.typeId, a.recordId, b.adapterType, b.instanceKey, b.typeId, b.recordId);
  }

  private nextBindingSeq(): number {
    return z
      .object({ next: z.number().int() })
      .parse(this.db.prepare('select coalesce(max(bound_seq), 0) + 1 as next from record_binding').get()).next;
  }

  /** Every queued work row (for inspection and tests). */
  work(): WorkRow[] {
    return this.db.prepare('select * from work order by due_at, id').all().map((r) => WorkRow.parse(r));
  }

  // ── The run host's backend families ───────────────────────────────────────
  //
  // Synchronous SQLite under the core's async interface. Their meaning is the
  // core's (store.ts); what is written here is only how SQLite holds it.

  /** Whether the run is leased under `fence`, and the lease has not lapsed. */
  private holds(runId: string, fence: string): boolean {
    return this.db.prepare('select 1 from run where id = ? and lease_token = ? and lease_until > ?').get(runId, fence, this.iso()) !== undefined;
  }

  /** `body` in one transaction, refused with `RunLeaseLost` unless the run is
   *  leased under `fence` (when one is given). */
  private fenced<T>(runId: string, fence: string | undefined, body: () => T): T {
    return this.transaction(() => {
      if (fence !== undefined && !this.holds(runId, fence)) throw new RunLeaseLost(runId);
      return body();
    });
  }

  /** Upsert a work row by key. Against a held row the new due time wins: its
   *  holder's completion leaves the row for the re-arm. */
  private enqueue({ kind, key, payload, dueAt }: { kind: string; key: string; payload: unknown; dueAt?: string }): void {
    const now = this.iso();
    this.db
      .prepare(
        `insert into work (kind, key, payload, due_at) values (?, ?, ?, ?)
         on conflict (key) do update set
           due_at = case when work.lease_until > ? then excluded.due_at else min(work.due_at, excluded.due_at) end,
           payload = excluded.payload,
           version = work.version + 1`,
      )
      .run(WorkKind.parse(kind), key, JSON.stringify(payload ?? null), dueAt ?? now, now);
  }

  // ── Callbacks ─────────────────────────────────────────────────────────────
  //
  // The claim is one transaction: read the row, judge it live and unexpired
  // by this file's clock, append the call, and queue its body.

  private callbackFamily(): CallbackStore {
    const db = this.db;
    const read = (id: string): CallbackRecord | null => {
      if (!isCallbackId(id)) return null;
      const row = db.prepare('select * from callback where id = ?').get(id);
      return row === undefined ? null : callbackOf(row);
    };
    return {
      mint: async ({ teamId, runId, address, params, state, singleUse, expiresAt }) => {
        const id = newCallbackId();
        db.prepare(
          `insert into callback (id, team_id, run_id, address, params, state, calls, single_use, expires_at, status, created_at)
           values (?, ?, ?, ?, ?, ?, '[]', ?, ?, 'live', ?)`,
        ).run(
          id,
          teamId,
          runId,
          address,
          JSON.stringify(params),
          JSON.stringify(state ?? null),
          singleUse ? 1 : 0,
          expiresAt !== undefined ? new Date(expiresAt).toISOString() : null,
          this.iso(),
        );
        return { id };
      },
      get: async ({ id }) => read(id),
      record: async ({ id, values, bodyDueAt }) =>
        this.transaction((): CallbackClaim => {
          const callback = read(id);
          if (callback === null) return { kind: 'not_found' };
          const now = this.iso();
          const refused = callbackRefusal(callback, { for: 'a new call', now });
          if (refused !== null) return { kind: refused, callback };
          const calls = [...callback.calls, { at: now, values }];
          const status = callback.singleUse ? 'fired' : 'live';
          db.prepare('update callback set calls = ?, status = ?, fired_at = case when ? then ? else fired_at end where id = ?').run(
            JSON.stringify(calls),
            status,
            callback.singleUse ? 1 : 0,
            now,
            id,
          );
          const callIndex = calls.length - 1;
          this.enqueue(callbackBodyWork({ callbackId: id, teamId: callback.teamId, callIndex, dueAt: bodyDueAt }));
          return { kind: 'recorded', callback: { ...callback, calls, status }, callIndex };
        }),
      markBodyStarted: async ({ id, callIndex, fence }) =>
        this.transaction(() => {
          const callback = read(id);
          if (callback === null || callback.calls[callIndex] === undefined) return false;
          if (fence !== undefined && !this.holds(callback.runId, fence)) return false;
          const calls = callback.calls.map((call, i) => (i === callIndex ? { ...call, bodyStartedAt: this.iso() } : call));
          db.prepare('update callback set calls = ? where id = ?').run(JSON.stringify(calls), id);
          return true;
        }),
      landed: async ({ ids }) =>
        ids.filter((id) => (read(id)?.calls ?? []).some((call) => call.bodyStartedAt !== undefined)),
      revokeRun: async ({ runId }) => this.revokeCallbacks(runId),
    };
  }

  private families(): RunHostStore {
    const db = this.db;
    const leafOf = (row: unknown): CoreLeafRow => {
      const r = LeafRow.parse(row);
      return { address: r.address, reason: r.reason, status: r.status, wakeAt: r.wake_at };
    };
    return {
      parks: {
        putLeaf: async ({ runId, address, reason, wakeAt, state, fence }) => {
          // `rewritten` is not kept: lf has no limit resume to read it.
          this.fenced(runId, fence, () =>
            db
              .prepare(
                `insert into leaf (run_id, address, reason, status, wake_at, state) values (?, ?, ?, 'parked', ?, ?)
                 on conflict (run_id, address) do update set
                   reason = excluded.reason, status = 'parked', wake_at = excluded.wake_at, state = excluded.state`,
              )
              .run(runId, address, reason, wakeAt, JSON.stringify(state ?? null)),
          );
        },
        claimLeaf: async ({ runId, address, reason }) => {
          const claimed = db
            .prepare(
              `update leaf set status = 'resuming' where run_id = ? and address = ? and status = 'parked'
               ${reason !== undefined ? 'and reason = ?' : ''} returning reason, state`,
            )
            .get(runId, address, ...(reason !== undefined ? [reason] : []));
          if (claimed === undefined) return null;
          const row = z.object({ reason: z.enum(CORE_PARK_REASONS), state: z.string() }).parse(claimed);
          return { reason: row.reason, state: JSON.parse(row.state) };
        },
        finishLeaf: async ({ runId, address, fence }) => {
          this.transaction(() => {
            if (fence !== undefined && !this.holds(runId, fence)) return;
            db.prepare("delete from leaf where run_id = ? and address = ? and status = 'resuming'").run(runId, address);
          });
        },
        leaves: async ({ runId, parkedOnly, reason, dueBy }) => {
          const where = ['run_id = ?'];
          const args: string[] = [runId];
          if (parkedOnly === true) where.push("status = 'parked'");
          if (reason !== undefined) {
            where.push('reason = ?');
            args.push(reason);
          }
          if (dueBy !== undefined) {
            where.push("reason = 'timer' and wake_at <= ?");
            args.push(dueBy);
          }
          return db
            .prepare(`select address, reason, status, wake_at from leaf where ${where.join(' and ')} order by address`)
            .all(...args)
            .map(leafOf);
        },
        deleteLeaves: async ({ runId, addresses }) => {
          this.transaction(() => {
            const drop = db.prepare('delete from leaf where run_id = ? and address = ?');
            for (const address of addresses) drop.run(runId, address);
          });
        },
      },

      joins: {
        recordJoin: async ({ runId, frameAddress, pending, fence }) => {
          // A re-reached frame rewrites the count to the same value.
          this.fenced(runId, fence, () =>
            db
              .prepare(
                `insert into join_frame (run_id, frame_address, pending) values (?, ?, ?)
                 on conflict (run_id, frame_address) do update set pending = excluded.pending`,
              )
              .run(runId, frameAddress, pending),
          );
        },
        decrementJoin: async ({ runId, frameAddress, branchAddress, leafAddress }) =>
          // The branch's export row carries its one claim on a decrement; the
          // decrement that reaches 0 marks the frame closed by this leaf.
          this.transaction(() => {
            const claimed = db
              .prepare('update join_branch_export set decremented = 1 where run_id = ? and frame_address = ? and branch_address = ? and decremented = 0')
              .run(runId, frameAddress, branchAddress);
            if (Number(claimed.changes) > 0) {
              const updated = db
                .prepare('update join_frame set pending = pending - 1 where run_id = ? and frame_address = ? and pending > 0 returning pending')
                .get(runId, frameAddress);
              if (updated !== undefined) {
                if (z.object({ pending: z.number().int() }).parse(updated).pending > 0) return { closed: false };
                db.prepare('update join_frame set closed_by_address = ? where run_id = ? and frame_address = ?').run(leafAddress, runId, frameAddress);
                return { closed: true };
              }
            }
            const row = db.prepare('select closed_by_address from join_frame where run_id = ? and frame_address = ?').get(runId, frameAddress);
            const closedBy = row === undefined ? null : z.object({ closed_by_address: z.string().nullable() }).parse(row).closed_by_address;
            return { closed: closedBy === leafAddress };
          }),
        persistBranchExport: async ({ runId, frameAddress, branchAddress, branchIndex, exports }) => {
          // A rewrite never touches `decremented`, the branch's decrement claim.
          db.prepare(
            `insert into join_branch_export (run_id, frame_address, branch_address, branch_index, exports) values (?, ?, ?, ?, ?)
             on conflict (run_id, frame_address, branch_address) do update set exports = excluded.exports, branch_index = excluded.branch_index`,
          ).run(runId, frameAddress, branchAddress, branchIndex, JSON.stringify(exports ?? null));
        },
        collectBranchExports: async ({ runId, frameAddress }) =>
          db
            .prepare('select branch_address, branch_index, exports from join_branch_export where run_id = ? and frame_address = ? order by branch_index')
            .all(runId, frameAddress)
            .map((r) => {
              const row = z.object({ branch_address: z.string(), branch_index: z.number().int(), exports: z.string() }).parse(r);
              return { branchAddress: row.branch_address, branchIndex: row.branch_index, exports: JSON.parse(row.exports) };
            }),
        hasPendingJoins: async ({ runId }) => db.prepare('select 1 from join_frame where run_id = ? and pending > 0 limit 1').get(runId) !== undefined,
        frames: async ({ runId }) =>
          db
            .prepare('select frame_address from join_frame where run_id = ? order by frame_address')
            .all(runId)
            .map((r) => z.object({ frame_address: z.string() }).parse(r).frame_address),
        deleteFrames: async ({ runId, frameAddresses }) => {
          this.transaction(() => {
            const dropFrame = db.prepare('delete from join_frame where run_id = ? and frame_address = ?');
            const dropExports = db.prepare('delete from join_branch_export where run_id = ? and frame_address = ?');
            for (const frame of frameAddresses) {
              dropFrame.run(runId, frame);
              dropExports.run(runId, frame);
            }
          });
        },
      },

      correlations: {
        correlate: async ({ runId, teamId, address, adapterType, correlationKey }) => {
          db.prepare(
            `insert into await_correlation (run_id, team_id, address, adapter_type, correlation_key) values (?, ?, ?, ?, ?)
             on conflict (run_id, address) do update set
               team_id = excluded.team_id, adapter_type = excluded.adapter_type, correlation_key = excluded.correlation_key`,
          ).run(runId, teamId, address, adapterType, correlationKey);
        },
        correlated: async ({ adapterType, teamId, correlationKey }) =>
          db
            .prepare(
              'select run_id, team_id, address from await_correlation where team_id = ? and adapter_type = ? and correlation_key = ? order by run_id, address',
            )
            .all(teamId, adapterType, correlationKey)
            .map((r) => {
              const row = z.object({ run_id: z.string(), team_id: z.string(), address: z.string() }).parse(r);
              return { runId: row.run_id, teamId: row.team_id, address: row.address };
            }),
        ofRun: async ({ runId, adapterType }) =>
          db
            .prepare('select run_id, team_id, address, correlation_key from await_correlation where run_id = ? and adapter_type = ? order by address')
            .all(runId, adapterType)
            .map((r) => {
              const row = z.object({ run_id: z.string(), team_id: z.string(), address: z.string(), correlation_key: z.string() }).parse(r);
              return { runId: row.run_id, teamId: row.team_id, address: row.address, correlationKey: row.correlation_key };
            }),
        drop: async ({ runId, address }) => {
          db.prepare('delete from await_correlation where run_id = ? and address = ?').run(runId, address);
        },
        dropRun: async ({ runId }) => {
          db.prepare('delete from await_correlation where run_id = ?').run(runId);
        },
      },

      leases: {
        claim: async ({ runId, ttlMs }) => {
          const token = randomUUID();
          return this.transaction(() => {
            const claimed = db
              .prepare('update run set lease_token = ?, lease_until = ? where id = ? and (lease_until is null or lease_until < ?)')
              .run(token, this.iso(ttlMs), runId, this.iso());
            if (Number(claimed.changes) === 0) return null;
            db.prepare("update leaf set status = 'parked' where run_id = ? and status = 'resuming'").run(runId);
            return { token };
          });
        },
        renew: async ({ runId, token, ttlMs }) => {
          const renewed = db
            .prepare('update run set lease_until = ? where id = ? and lease_token = ? and lease_until > ?')
            .run(this.iso(ttlMs), runId, token, this.iso());
          return Number(renewed.changes) > 0;
        },
        release: async ({ runId, token }) => {
          db.prepare('update run set lease_token = null, lease_until = null where id = ? and lease_token = ?').run(runId, token);
        },
        dropRunState: async ({ runId, fence }) =>
          this.transaction(() => {
            if (fence !== undefined && !this.holds(runId, fence)) return false;
            db.prepare('delete from leaf where run_id = ?').run(runId);
            db.prepare('delete from join_frame where run_id = ?').run(runId);
            db.prepare('delete from join_branch_export where run_id = ?').run(runId);
            return true;
          }),
      },

      work: {
        enqueue: async (input) => this.enqueue(input),
        claimDue: async ({ limit, leaseMs, dueBy }) => {
          const now = this.iso();
          return this.transaction(() => {
            const due = db
              .prepare('select * from work where due_at <= ? and (lease_until is null or lease_until < ?) order by due_at, id limit ?')
              .all(dueBy ?? this.dueBy(), now, limit)
              .map((r) => WorkRow.parse(r));
            const lease = db.prepare('update work set lease_token = ?, lease_until = ?, version = version + 1 where id = ?');
            return due.map((row): ClaimedWork => {
              const leaseToken = randomUUID();
              lease.run(leaseToken, this.iso(leaseMs), row.id);
              return { id: String(row.id), kind: row.kind, key: row.key, payload: JSON.parse(row.payload), claim: `${leaseToken}/${row.version + 1}` };
            });
          });
        },
        complete: async (work) => {
          // Deleted only when nothing re-armed it since the claim; else the
          // re-armed row stays, unleased, for its new due time.
          const { leaseToken, version } = WorkClaim.parse(work.claim);
          this.transaction(() => {
            db.prepare('delete from work where id = ? and lease_token = ? and version = ?').run(Number(work.id), leaseToken, version);
            db.prepare('update work set lease_token = null, lease_until = null where id = ? and lease_token = ?').run(Number(work.id), leaseToken);
          });
        },
        release: async (work) => {
          const { leaseToken, version } = WorkClaim.parse(work.claim);
          db.prepare(
            `update work set lease_token = null, lease_until = null,
               due_at = case when version = ? then coalesce(?, due_at) else due_at end
             where id = ? and lease_token = ?`,
          ).run(version, work.dueAt ?? null, Number(work.id), leaseToken);
        },
      },

      // The library texts parks pin, once each by their hash (park state
      // version 2's `libraries`).
      sources: {
        put: async ({ teamId, hash, source }) => {
          db.prepare('insert into park_library_source (team_id, hash, source) values (?, ?, ?) on conflict do nothing').run(teamId, hash, source);
        },
        get: async ({ teamId, hash }) => {
          const row = db.prepare('select source from park_library_source where team_id = ? and hash = ?').get(teamId, hash);
          return row === undefined ? null : SourceRow.parse(row).source;
        },
      },
    };
  }
}

const SourceRow = z.object({ source: z.string() });

const BindingRow = z.object({
  a_adapter_type: z.string(),
  a_instance_key: z.string(),
  a_type_id: z.string(),
  a_record_id: z.string(),
  b_adapter_type: z.string(),
  b_instance_key: z.string(),
  b_type_id: z.string(),
  b_record_id: z.string(),
});
