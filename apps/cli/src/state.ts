// The host's state, in SQLite at `.lf/state.db` (or a temporary file with
// `--ephemeral`): the run log, each run's trace, parked runs, and the work
// queue `lf serve` drains. Run leases and write locks are in-process: one lf
// process owns a project's state at a time.

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from './project';

export type RunStatus = 'running' | 'completed' | 'parked' | 'failed';

export interface RunRow {
  id: string;
  file: string;
  movement: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  /** The run's facts a resume needs, as JSON: source, event, language version. */
  input: string;
  outcome: string | null;
}

export interface ParkRow {
  id: number;
  run_id: string;
  kind: 'timer' | 'await' | 'suspension';
  address: string;
  wake_at: string | null;
  adapter_type: string | null;
  correlation_key: string | null;
  state: string;
  engine: string;
}

export interface WorkRow {
  id: number;
  kind: 'resume';
  due_at: string;
  payload: string;
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
  outcome text
);
create table if not exists trace (
  run_id text not null,
  seq integer not null,
  entry text not null,
  primary key (run_id, seq)
);
create table if not exists park (
  id integer primary key autoincrement,
  run_id text not null,
  kind text not null,
  address text not null,
  wake_at text,
  adapter_type text,
  correlation_key text,
  state text not null,
  engine text not null
);
create table if not exists join_frame (
  run_id text not null,
  frame_address text not null,
  parked_children integer not null,
  primary key (run_id, frame_address)
);
create table if not exists work (
  id integer primary key autoincrement,
  kind text not null,
  due_at text not null,
  payload text not null,
  claimed_at text
);
`;

export class State {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  static open(project: Project, options: { ephemeral: boolean }): State {
    const path = options.ephemeral
      ? join(mkdtempSync(join(tmpdir(), 'lf-')), 'state.db')
      : join(project.lfDir, 'state.db');
    return new State(path);
  }

  close(): void {
    this.db.close();
  }

  startRun(row: Omit<RunRow, 'finished_at' | 'outcome' | 'status'>): void {
    this.db
      .prepare('insert into run (id, file, movement, status, started_at, input) values (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.file, row.movement, 'running', row.started_at, row.input);
  }

  settleRun(id: string, status: RunStatus, outcome: unknown, at: string): void {
    this.db
      .prepare('update run set status = ?, outcome = ?, finished_at = ? where id = ?')
      .run(status, JSON.stringify(outcome ?? null), status === 'parked' ? null : at, id);
  }

  markRunning(id: string): void {
    this.db.prepare("update run set status = 'running' where id = ?").run(id);
  }

  run(id: string): RunRow | undefined {
    return this.db.prepare('select * from run where id = ?').get(id) as RunRow | undefined;
  }

  runs(limit = 50): RunRow[] {
    return this.db.prepare('select * from run order by started_at desc limit ?').all(limit) as unknown as RunRow[];
  }

  appendTrace(runId: string, entries: unknown[]): void {
    const next = this.db.prepare('select coalesce(max(seq), -1) + 1 as next from trace where run_id = ?').get(runId) as {
      next: number;
    };
    const insert = this.db.prepare('insert into trace (run_id, seq, entry) values (?, ?, ?)');
    entries.forEach((entry, i) => insert.run(runId, next.next + i, JSON.stringify(entry)));
  }

  trace(runId: string): unknown[] {
    return (this.db.prepare('select entry from trace where run_id = ? order by seq').all(runId) as Array<{ entry: string }>).map(
      (r) => JSON.parse(r.entry),
    );
  }

  addPark(row: Omit<ParkRow, 'id'>): number {
    const result = this.db
      .prepare(
        'insert into park (run_id, kind, address, wake_at, adapter_type, correlation_key, state, engine) values (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(row.run_id, row.kind, row.address, row.wake_at, row.adapter_type, row.correlation_key, row.state, row.engine);
    return Number(result.lastInsertRowid);
  }

  parks(runId?: string): ParkRow[] {
    return (
      runId === undefined
        ? this.db.prepare('select * from park order by id').all()
        : this.db.prepare('select * from park where run_id = ? order by id').all(runId)
    ) as unknown as ParkRow[];
  }

  dropPark(id: number): void {
    this.db.prepare('delete from park where id = ?').run(id);
  }

  dropParks(runId: string, addresses: string[]): void {
    const drop = this.db.prepare('delete from park where run_id = ? and (address = ? or address like ?)');
    for (const address of addresses) drop.run(runId, address, `${address}/%`);
  }

  recordJoin(runId: string, frameAddress: string, parkedChildren: number): void {
    this.db
      .prepare('insert or replace into join_frame (run_id, frame_address, parked_children) values (?, ?, ?)')
      .run(runId, frameAddress, parkedChildren);
  }

  /** One parked child of a join finished; whether that was the last. */
  decrementJoin(runId: string, frameAddress: string): { closed: boolean } {
    this.db
      .prepare('update join_frame set parked_children = parked_children - 1 where run_id = ? and frame_address = ?')
      .run(runId, frameAddress);
    const row = this.db
      .prepare('select parked_children from join_frame where run_id = ? and frame_address = ?')
      .get(runId, frameAddress) as { parked_children: number } | undefined;
    return { closed: row === undefined || row.parked_children <= 0 };
  }

  enqueue(kind: WorkRow['kind'], dueAt: string, payload: unknown): void {
    this.db.prepare('insert into work (kind, due_at, payload) values (?, ?, ?)').run(kind, dueAt, JSON.stringify(payload));
  }

  /** Claim every unclaimed item due by `now`. In-process: one lf owns the queue. */
  claimDue(now: string): WorkRow[] {
    const due = this.db
      .prepare('select id, kind, due_at, payload from work where claimed_at is null and due_at <= ? order by due_at')
      .all(now) as unknown as WorkRow[];
    const claim = this.db.prepare('update work set claimed_at = ? where id = ?');
    for (const item of due) claim.run(now, item.id);
    return due;
  }

  finishWork(id: number): void {
    this.db.prepare('delete from work where id = ?').run(id);
  }
}
