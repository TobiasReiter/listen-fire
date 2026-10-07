export const WORK_KINDS = [
  'dispatch_event', // payload: CapturedTriggerEvent (triggers/dispatch_event.ts)
  'resume_timer', // payload: { runId: string }
  'fire_cron', // payload: { triggerId: string }
  'poll_source', // payload: { triggerId: string }
  'wake_await', // payload: { adapterType: string; teamId: string; correlationKey: string }
  'fire_callback', // payload: { callbackId: string; teamId: string; callIndex: number } (callback_fire.ts)
  'linked_object_refresh', // payload: LinkedObjectRefresh (webhook_sync/linked_object_refresh.ts)
  'cron_reconcile', // periodic, payload {}
  'poll_reconcile', // periodic, payload {}
  'ask_closed_sweep', // periodic, payload {}
  'timer_sweep', // periodic, payload {}
  'exposed_file_sweep', // periodic, payload {}
  'airtable_webhook_refresh', // periodic, payload {}
  'run_orphan_sweep', // periodic, payload {}
] as const;

export type WorkKind = (typeof WORK_KINDS)[number];

const KNOWN_KINDS: ReadonlySet<string> = new Set(WORK_KINDS);

export function isWorkKind(value: string): value is WorkKind {
  return KNOWN_KINDS.has(value);
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
  leaseToken: string | null;
  updatedAt: Date;
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
