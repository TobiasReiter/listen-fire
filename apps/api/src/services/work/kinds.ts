// The work kinds the core runs: dispatch, the clock, polling, wakes and
// callbacks, and the sweeps that keep them. A unit (an adapter package, a
// product's own upkeep) adds its own kinds: it declares each into
// `UnitWorkKinds` and registers it with `registerWorkKinds` (units.ts), so the
// core names none of them.
export const CORE_WORK_KINDS = [
  'dispatch_event', // payload: CapturedTriggerEvent (triggers/dispatch_event.ts)
  'resume_timer', // payload: { runId: string }
  'fire_cron', // payload: { triggerId: string }
  'poll_source', // payload: { triggerId: string }
  'wake_await', // payload: { adapterType: string; teamId: string; correlationKey: string }
  'fire_callback', // payload: { callbackId: string; teamId: string; callIndex: number } (callback_fire.ts)
  'cron_reconcile', // periodic, payload {}
  'poll_reconcile', // periodic, payload {}
  'timer_sweep', // periodic, payload {}
  'run_orphan_sweep', // periodic, payload {}
] as const;

export type CoreWorkKind = (typeof CORE_WORK_KINDS)[number];

/**
 * The kinds units add, by declaration merging — a unit's module says
 *
 *     declare module '<path>/work/kinds' {
 *       interface UnitWorkKinds { my_sweep: true }
 *     }
 *
 * and the kind is then a `WorkKind` everywhere that module is compiled in.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface UnitWorkKinds {}

export type WorkKind = CoreWorkKind | (keyof UnitWorkKinds & string);

const CORE_KINDS: ReadonlySet<string> = new Set(CORE_WORK_KINDS);

/** The unit kinds this process has registered — the only unit kinds it
 *  claims — each with its interval when it is periodic. */
const unitKinds = new Map<WorkKind, number | undefined>();

/** Called by `registerWorkKinds` (units.ts) for each kind a unit registers. */
export function admitUnitWorkKind(kind: WorkKind, intervalMs?: number): void {
  unitKinds.set(kind, intervalMs);
}

/** Called by `resetWorkHandlersForTests` (drain.ts). */
export function forgetUnitWorkKinds(): void {
  unitKinds.clear();
}

/** The periodic unit kinds registered so far, with their intervals: the core
 *  keeps their rows as it keeps its own. */
export function periodicUnitWorkKinds(): Array<{ kind: WorkKind; intervalMs: number }> {
  return [...unitKinds].flatMap(([kind, intervalMs]) => (intervalMs === undefined ? [] : [{ kind, intervalMs }]));
}

export function isWorkKind(value: string): value is WorkKind {
  return CORE_KINDS.has(value) || [...unitKinds.keys()].some((kind) => kind === value);
}

/** The kinds this process claims: the core's, and every unit kind it has
 *  registered. A row of a unit this process does not run waits for one that
 *  does. */
export function claimableWorkKinds(): string[] {
  return [...CORE_WORK_KINDS, ...unitKinds.keys()];
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
  /** Releases because the row's run was busy elsewhere; never attempts. */
  deferrals: number;
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
