// The host's state, in SQLite at `.lf/state.db` (or a temporary file with
// `--ephemeral`): the run log, each run's trace, parked leaves and the joins
// they hold, record bindings, and the work queue `lf serve` drains. The same
// host families the hosted Postgres backend serves, with the same semantics:
// a park is one row per (run, address), a resume claims its leaf before it
// steps it, a join closes exactly once, a work row is leased (not taken), and
// a run is stepped by one process at a time (the run lease) — so `lf resume`
// and a running `lf serve` can share one state file.

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { BindingEndpoint, EncodedEndpoint } from 'movement-engine/services/movement_engine/host';
import { isAncestorOrSelf, parseAddress } from 'movement-engine/services/movement_engine/address';
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
});
export type RunRow = z.infer<typeof RunRow>;

const ParkKind = z.enum(['timer', 'await', 'suspension']);
const ParkRow = z.object({
  run_id: z.string(),
  address: z.string(),
  kind: ParkKind,
  /** `parked`, or `resuming` while a resume holds the claim on it. */
  status: z.enum(['parked', 'resuming']),
  wake_at: z.string().nullable(),
  adapter_type: z.string().nullable(),
  correlation_key: z.string().nullable(),
  state: z.string(),
  /** The engine whose state this is. */
  engine: z.enum(['rust', 'ts']),
});
export type ParkRow = z.infer<typeof ParkRow>;

export const WorkKind = z.enum(['resume_timer', 'wake_await']);
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

/** A claimed work row: what to do, and the lease to finish it under. */
export interface ClaimedWork {
  id: number;
  kind: WorkKind;
  key: string;
  payload: unknown;
  leaseToken: string;
  claimedVersion: number;
}

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
create table if not exists park (
  run_id text not null,
  address text not null,
  kind text not null,
  status text not null default 'parked',
  wake_at text,
  adapter_type text,
  correlation_key text,
  state text not null,
  engine text not null,
  primary key (run_id, address)
);
create index if not exists park_correlation on park (adapter_type, correlation_key);
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

/** How long a run lease or a work lease lasts without renewal. */
export const LEASE_TTL_MS = 60_000;

export class State {
  readonly path: string;
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

  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
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

  // ── Runs ──────────────────────────────────────────────────────────────────

  startRun(row: Omit<RunRow, 'finished_at' | 'outcome' | 'status'>): void {
    this.db
      .prepare('insert into run (id, file, movement, status, started_at, input) values (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.file, row.movement, 'running', row.started_at, row.input);
  }

  settleRun(id: string, status: RunStatus, outcome: unknown, at: string): void {
    this.db
      .prepare('update run set status = ?, outcome = ?, finished_at = ? where id = ?')
      .run(status, JSON.stringify(outcome ?? null), status === 'parked' || status === 'running' ? null : at, id);
  }

  markRunning(id: string): void {
    this.db.prepare("update run set status = 'running' where id = ?").run(id);
  }

  run(id: string): RunRow | undefined {
    const row = this.db.prepare('select * from run where id = ?').get(id);
    return row === undefined ? undefined : RunRow.parse(row);
  }

  runs(limit = 50): RunRow[] {
    return this.db.prepare('select * from run order by started_at desc limit ?').all(limit).map((r) => RunRow.parse(r));
  }

  /** Take the run's lease: only one process steps a run at a time. Null when
   *  another holds it. Taking it returns any leaf a lapsed holder left
   *  claimed (`resuming`) to `parked`, for this holder to resume. */
  claimRunLease(runId: string, ttlMs = LEASE_TTL_MS): { token: string } | null {
    const token = randomUUID();
    return this.transaction(() => {
      const claimed = this.db
        .prepare('update run set lease_token = ?, lease_until = ? where id = ? and (lease_until is null or lease_until < ?)')
        .run(token, this.iso(ttlMs), runId, this.iso());
      if (Number(claimed.changes) === 0) return null;
      this.db.prepare("update park set status = 'parked' where run_id = ? and status = 'resuming'").run(runId);
      return { token };
    });
  }

  renewRunLease(runId: string, token: string, ttlMs = LEASE_TTL_MS): boolean {
    const renewed = this.db
      .prepare('update run set lease_until = ? where id = ? and lease_token = ? and lease_until > ?')
      .run(this.iso(ttlMs), runId, token, this.iso());
    return Number(renewed.changes) > 0;
  }

  releaseRunLease(runId: string, token: string): void {
    this.db.prepare('update run set lease_token = null, lease_until = null where id = ? and lease_token = ?').run(runId, token);
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

  // ── Parks ─────────────────────────────────────────────────────────────────

  /** Park a leaf. One row per (run, address): a re-reached park rewrites its
   *  own row, `parked` again (a leaf re-parked by its own resume is parked,
   *  not the claimed row its resume deletes once the step is over). */
  upsertPark(row: Omit<ParkRow, 'status'>): void {
    this.db
      .prepare(
        `insert into park (run_id, address, kind, status, wake_at, adapter_type, correlation_key, state, engine)
         values (?, ?, ?, 'parked', ?, ?, ?, ?, ?)
         on conflict (run_id, address) do update set
           kind = excluded.kind, status = 'parked', wake_at = excluded.wake_at, adapter_type = excluded.adapter_type,
           correlation_key = excluded.correlation_key, state = excluded.state, engine = excluded.engine`,
      )
      .run(row.run_id, row.address, row.kind, row.wake_at, row.adapter_type, row.correlation_key, row.state, row.engine);
  }

  /** Every park of the run (or of every run), parked or claimed. */
  parks(runId?: string): ParkRow[] {
    return (
      runId === undefined
        ? this.db.prepare('select * from park order by run_id, address').all()
        : this.db.prepare('select * from park where run_id = ? order by address').all(runId)
    ).map((r) => ParkRow.parse(r));
  }

  /** The run's timer leaves due by now, still parked. */
  dueTimerParks(runId: string): ParkRow[] {
    return this.db
      .prepare("select * from park where run_id = ? and kind = 'timer' and status = 'parked' and wake_at <= ? order by wake_at")
      .all(runId, this.iso(this.dueOffsetMs))
      .map((r) => ParkRow.parse(r));
  }

  /** The earliest wake of the run's still-parked timer leaves. */
  nextTimerWake(runId: string): string | null {
    const row = z
      .object({ wake_at: z.string().nullable() })
      .parse(this.db.prepare("select min(wake_at) as wake_at from park where run_id = ? and kind = 'timer' and status = 'parked'").get(runId));
    return row.wake_at;
  }

  /** Every await leaf parked on one adapter's correlation key. */
  awaitParks(input: { adapterType: string; correlationKey: string }): ParkRow[] {
    return this.db
      .prepare("select * from park where kind = 'await' and status = 'parked' and adapter_type = ? and correlation_key = ? order by run_id, address")
      .all(input.adapterType, input.correlationKey)
      .map((r) => ParkRow.parse(r));
  }

  /** Claim a parked leaf for its resume: null when it is not parked (another
   *  resume took it, or a race cancelled it). */
  claimPark(runId: string, address: string): ParkRow | null {
    return this.transaction(() => {
      const claimed = this.db
        .prepare("update park set status = 'resuming' where run_id = ? and address = ? and status = 'parked'")
        .run(runId, address);
      if (Number(claimed.changes) === 0) return null;
      return ParkRow.parse(this.db.prepare('select * from park where run_id = ? and address = ?').get(runId, address));
    });
  }

  /** The claimed leaf is done with: delete it, unless its step parked again
   *  at the same address (the row is `parked` again, and stays). */
  finishPark(runId: string, address: string): void {
    this.db.prepare("delete from park where run_id = ? and address = ? and status = 'resuming'").run(runId, address);
  }

  // ── Joins ─────────────────────────────────────────────────────────────────

  /** A join frame's count of parked children. A re-reached frame rewrites the
   *  count to the same deterministic value, never double-counting. */
  recordJoin(runId: string, frameAddress: string, parkedChildren: number): void {
    this.db
      .prepare(
        `insert into join_frame (run_id, frame_address, pending) values (?, ?, ?)
         on conflict (run_id, frame_address) do update set pending = excluded.pending`,
      )
      .run(runId, frameAddress, parkedChildren);
  }

  /** A completed branch's exports at its join frame, written before its
   *  decrement. A rewrite never touches `decremented`, the branch's claim on
   *  its one decrement. */
  persistBranchExport(input: { runId: string; frameAddress: string; branchAddress: string; branchIndex: number; exports: unknown }): void {
    this.db
      .prepare(
        `insert into join_branch_export (run_id, frame_address, branch_address, branch_index, exports) values (?, ?, ?, ?, ?)
         on conflict (run_id, frame_address, branch_address) do update set exports = excluded.exports, branch_index = excluded.branch_index`,
      )
      .run(input.runId, input.frameAddress, input.branchAddress, input.branchIndex, JSON.stringify(input.exports ?? null));
  }

  /** Every branch's exports at a frame, in branch order: the closer's fold order. */
  collectBranchExports(runId: string, frameAddress: string): Array<{ branchAddress: string; branchIndex: number; exports: unknown }> {
    return this.db
      .prepare('select branch_address, branch_index, exports from join_branch_export where run_id = ? and frame_address = ? order by branch_index')
      .all(runId, frameAddress)
      .map((r) => {
        const row = z.object({ branch_address: z.string(), branch_index: z.number().int(), exports: z.string() }).parse(r);
        return { branchAddress: row.branch_address, branchIndex: row.branch_index, exports: JSON.parse(row.exports) };
      });
  }

  /**
   * One branch of a join finished: decrement the frame's count, exactly once
   * per branch (its export row's `decremented` claim). The decrement that
   * reaches 0 marks the frame closed by this leaf and is the one closer; a
   * branch whose claim was already taken (a retry) is the closer only if the
   * frame says it closed it.
   */
  decrementJoin(input: { runId: string; frameAddress: string; branchAddress: string; leafAddress: string }): { closed: boolean } {
    return this.transaction(() => {
      const claimed = this.db
        .prepare(
          'update join_branch_export set decremented = 1 where run_id = ? and frame_address = ? and branch_address = ? and decremented = 0',
        )
        .run(input.runId, input.frameAddress, input.branchAddress);
      if (Number(claimed.changes) > 0) {
        const updated = this.db
          .prepare('update join_frame set pending = pending - 1 where run_id = ? and frame_address = ? and pending > 0 returning pending')
          .get(input.runId, input.frameAddress);
        if (updated !== undefined) {
          if (z.object({ pending: z.number().int() }).parse(updated).pending === 0) {
            this.db
              .prepare('update join_frame set closed_by_address = ? where run_id = ? and frame_address = ?')
              .run(input.leafAddress, input.runId, input.frameAddress);
            return { closed: true };
          }
          return { closed: false };
        }
      }
      const row = this.db
        .prepare('select closed_by_address from join_frame where run_id = ? and frame_address = ?')
        .get(input.runId, input.frameAddress);
      const closedBy = row === undefined ? null : z.object({ closed_by_address: z.string().nullable() }).parse(row).closed_by_address;
      return { closed: closedBy === input.leafAddress };
    });
  }

  /** Whether any join of the run still waits on a branch. A closed frame
   *  (count 0) does not. */
  runHasPendingJoins(runId: string): boolean {
    return this.db.prepare('select 1 from join_frame where run_id = ? and pending > 0 limit 1').get(runId) !== undefined;
  }

  /**
   * Whether the run is quiescent but for one leaf: no join waiting and no
   * other leaf parked. The leaf being resumed is excluded: its own row goes
   * after its step.
   */
  runCompleteBut(runId: string, leafAddress: string): boolean {
    if (this.runHasPendingJoins(runId)) return false;
    return this.db.prepare("select 1 from park where run_id = ? and address != ? and status = 'parked' limit 1").get(runId, leafAddress) === undefined;
  }

  /** Whether the run has nothing left waiting: no join, no parked leaf. */
  runQuiescent(runId: string): boolean {
    if (this.runHasPendingJoins(runId)) return false;
    return this.db.prepare("select 1 from park where run_id = ? and status = 'parked' limit 1").get(runId) === undefined;
  }

  /** Drop the run's live state: its joins and their exports. */
  clearJoins(runId: string): void {
    this.transaction(() => {
      this.db.prepare('delete from join_frame where run_id = ?').run(runId);
      this.db.prepare('delete from join_branch_export where run_id = ?').run(runId);
    });
  }

  /** Drop every leaf and join of the run (a failed run: nothing will resume it). */
  dropRunLeaves(runId: string): void {
    this.transaction(() => {
      this.db.prepare('delete from park where run_id = ?').run(runId);
      this.db.prepare('delete from join_frame where run_id = ?').run(runId);
      this.db.prepare('delete from join_branch_export where run_id = ?').run(runId);
    });
  }

  /**
   * Cancel every parked leaf at or below one of the subtree addresses (a
   * race's losers), sparing `excludeLeaf` (the winner, whose own row may still
   * be mid-resume), and every join frame inside them with its exports. The
   * algebra runs on the parsed address: `s1.b1` is not an ancestor of `s1.b10`.
   */
  cancelSubtrees(input: { runId: string; subtreeAddresses: string[]; excludeLeaf?: string }): void {
    if (input.subtreeAddresses.length === 0) return;
    const prefixes = input.subtreeAddresses.map(parseAddress);
    const inSubtree = (address: string): boolean => {
      if (input.excludeLeaf !== undefined && address === input.excludeLeaf) return false;
      const parsed = parseAddress(address);
      return prefixes.some((p) => isAncestorOrSelf(p, parsed));
    };
    this.transaction(() => {
      const parked = this.db
        .prepare("select address from park where run_id = ? and status = 'parked'")
        .all(input.runId)
        .map((r) => z.object({ address: z.string() }).parse(r).address);
      const dropPark = this.db.prepare('delete from park where run_id = ? and address = ?');
      for (const address of parked.filter(inSubtree)) dropPark.run(input.runId, address);
      const frames = this.db
        .prepare('select frame_address from join_frame where run_id = ?')
        .all(input.runId)
        .map((r) => z.object({ frame_address: z.string() }).parse(r).frame_address);
      const dropFrame = this.db.prepare('delete from join_frame where run_id = ? and frame_address = ?');
      const dropExports = this.db.prepare('delete from join_branch_export where run_id = ? and frame_address = ?');
      for (const frame of frames.filter(inSubtree)) {
        dropFrame.run(input.runId, frame);
        dropExports.run(input.runId, frame);
      }
    });
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

  // ── Work queue ────────────────────────────────────────────────────────────

  /**
   * Queue work by key. A key already queued is re-armed: its payload is
   * replaced, and its due time is the earlier of the two while nobody holds
   * it (a held row takes the new due time: its holder's completion leaves it
   * for the re-arm).
   */
  enqueue(input: { kind: WorkKind; key: string; payload: unknown; dueAt?: string }): void {
    const now = this.iso();
    this.db
      .prepare(
        `insert into work (kind, key, payload, due_at) values (?, ?, ?, ?)
         on conflict (key) do update set
           due_at = case when work.lease_until > ? then excluded.due_at else min(work.due_at, excluded.due_at) end,
           payload = excluded.payload,
           version = work.version + 1`,
      )
      .run(input.kind, input.key, JSON.stringify(input.payload ?? null), input.dueAt ?? now, now);
  }

  /** Lease every unleased row due by now (or whose lease lapsed), earliest first. */
  claimDue(input: { limit?: number; leaseMs?: number; kinds?: readonly WorkKind[] } = {}): ClaimedWork[] {
    const now = this.iso();
    const dueBy = this.iso(this.dueOffsetMs);
    const kinds = input.kinds ?? WorkKind.options;
    return this.transaction(() => {
      const due = this.db
        .prepare(
          `select * from work where due_at <= ? and (lease_until is null or lease_until < ?)
             and kind in (${kinds.map(() => '?').join(', ')}) order by due_at, id limit ?`,
        )
        .all(dueBy, now, ...kinds, input.limit ?? 100)
        .map((r) => WorkRow.parse(r));
      const lease = this.db.prepare('update work set lease_token = ?, lease_until = ?, version = version + 1 where id = ?');
      return due.map((row) => {
        const leaseToken = randomUUID();
        lease.run(leaseToken, this.iso(input.leaseMs ?? LEASE_TTL_MS), row.id);
        return { id: row.id, kind: row.kind, key: row.key, payload: JSON.parse(row.payload), leaseToken, claimedVersion: row.version + 1 };
      });
    });
  }

  /** The work is done: delete its row, unless it was re-armed since the
   *  claim (then it stays, unleased, for its new due time). */
  completeWork(work: Pick<ClaimedWork, 'id' | 'leaseToken' | 'claimedVersion'>): void {
    this.transaction(() => {
      this.db.prepare('delete from work where id = ? and lease_token = ? and version = ?').run(work.id, work.leaseToken, work.claimedVersion);
      this.db.prepare('update work set lease_token = null, lease_until = null where id = ? and lease_token = ?').run(work.id, work.leaseToken);
    });
  }

  /** The work failed or could not run now: unlease it, due again at `dueAt`
   *  (unless it was re-armed since the claim, whose due time stands). */
  releaseWork(work: Pick<ClaimedWork, 'id' | 'leaseToken' | 'claimedVersion'> & { dueAt?: string }): void {
    this.db
      .prepare(
        `update work set lease_token = null, lease_until = null,
           due_at = case when version = ? then coalesce(?, due_at) else due_at end
         where id = ? and lease_token = ?`,
      )
      .run(work.claimedVersion, work.dueAt ?? null, work.id, work.leaseToken);
  }

  /** Every queued row (for inspection and tests). */
  work(): WorkRow[] {
    return this.db.prepare('select * from work order by due_at, id').all().map((r) => WorkRow.parse(r));
  }
}

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
