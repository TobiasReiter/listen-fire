export type WorkKind =
  | 'dispatch_event' // payload: CapturedTriggerEvent (triggers/dispatch_event.ts)
  | 'resume_timer' // payload: { runId: string }
  | 'fire_cron' // payload: { triggerId: string }
  | 'poll_source' // payload: { triggerId: string }
  | 'wake_await' // payload: { adapterType: string; correlationKey: string }
  | 'cron_reconcile' // periodic, payload {}
  | 'poll_reconcile' // periodic, payload {}
  | 'await_resume_sweep' // periodic, payload {}  (temporary until protocol v2)
  | 'settle_cancelled_timers' // periodic, payload {}
  | 'exposed_file_sweep' // periodic, payload {}
  | 'airtable_webhook_refresh'; // periodic, payload {}

// A Record over the union makes the compiler reject a kind added above but not here.
const WORK_KINDS: Record<WorkKind, true> = {
  dispatch_event: true,
  resume_timer: true,
  fire_cron: true,
  poll_source: true,
  wake_await: true,
  cron_reconcile: true,
  poll_reconcile: true,
  await_resume_sweep: true,
  settle_cancelled_timers: true,
  exposed_file_sweep: true,
  airtable_webhook_refresh: true,
};

export function isWorkKind(value: string): value is WorkKind {
  return Object.hasOwn(WORK_KINDS, value);
}

export interface WorkRow {
  id: string;
  teamId: string | null;
  kind: WorkKind;
  key: string;
  payload: unknown;
  dueAt: Date;
  intervalMs: number | null;
  attempts: number;
  leaseOwner: string | null;
  leaseUntil: Date | null;
}

export interface WorkContext {
  now: Date;
  owner: string;
  attempts: number;
  heartbeat(): Promise<void>;
}

export interface WorkHandler {
  /** First execution of a claimed row. */
  run(payload: unknown, ctx: WorkContext): Promise<void>;
  /** A re-claim after a lapsed lease (attempts > 1). Default: run again. */
  recover?(payload: unknown, ctx: WorkContext): Promise<void>;
}

export type WorkHandlers = Partial<Record<WorkKind, WorkHandler>>;
