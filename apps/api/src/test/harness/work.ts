import type { WorkContext } from '../../services/work/kinds';

/** A first-attempt context for calling a work handler directly, outside the drain. */
export function testWorkContext(now: Date = new Date()): WorkContext {
  return { now, owner: 'test', attempts: 1, heartbeat: async () => {} };
}
