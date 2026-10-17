// Step timing for the authoring loop (validate → save).
//
// "Saving is slow" is only actionable if the answer says WHICH step spent the
// wall clock, so each call emits ONE structured line naming every step it ran
// — and the catalog step, the only network-backed one, carries what it paid
// for (introspection pairs, demand rounds, how many instances were already
// warm) so the line explains its own number.
//
// `otherMs` is the wall clock no step claimed: it stays honest only because
// `within` marks a sub-step of an enclosing step, and sub-steps are reported
// without being counted a second time.

import { logger } from 'movement-engine/public/log';

export interface StepTimer {
  /** Time a top-level step. Its duration counts toward the total's breakdown. */
  step<T>(name: string, run: () => Promise<T>): Promise<T>;
  /** Time a step nested INSIDE a `step` — reported, never counted again. */
  within<T>(name: string, run: () => Promise<T>): Promise<T>;
  /** Add facts a step learned (what the catalog paid for) to the same line. */
  note(fields: object): void;
  /** Emit the one line. `fields` carries the call's own facts (ids, outcome). */
  done(fields?: Record<string, unknown>): void;
}

/** Durations are logged under `<name>Ms`. */
export function stepTimer(event: string, base: Record<string, unknown> = {}): StepTimer {
  const startedAt = Date.now();
  const steps = new Map<string, number>();
  const nested = new Map<string, number>();
  const notes: Record<string, unknown> = {};

  const timed = async <T>(
    into: Map<string, number>,
    name: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    const stepStarted = Date.now();
    try {
      return await run();
    } finally {
      into.set(`${name}Ms`, (into.get(`${name}Ms`) ?? 0) + (Date.now() - stepStarted));
    }
  };

  return {
    step: (name, run) => timed(steps, name, run),
    within: (name, run) => timed(nested, name, run),
    note(fields) {
      Object.assign(notes, fields);
    },
    done(fields = {}) {
      const totalMs = Date.now() - startedAt;
      let claimed = 0;
      for (const ms of steps.values()) claimed += ms;
      logger.info(event, {
        ...base,
        ...notes,
        ...fields,
        ...Object.fromEntries(steps),
        ...Object.fromEntries(nested),
        otherMs: totalMs - claimed,
        totalMs,
      });
    },
  };
}
