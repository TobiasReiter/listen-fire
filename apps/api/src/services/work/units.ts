// How a unit adds work of its own: it declares each kind into
// `UnitWorkKinds` (kinds.ts) and registers it here, with its handler and, for
// a periodic kind, its interval. From then on this process claims and runs the
// kind, and the core keeps a periodic kind's row as it keeps its own.

import { registerWorkHandler } from './drain';
import { admitUnitWorkKind, type WorkHandler, type WorkKind } from './kinds';

export interface WorkKindRegistration {
  kind: WorkKind;
  handler: WorkHandler;
  /** Present for a periodic kind: the interval its row recurs at. */
  intervalMs?: number;
}

export function registerWorkKinds(registrations: readonly WorkKindRegistration[]): void {
  for (const { kind, handler, intervalMs } of registrations) {
    registerWorkHandler(kind, handler);
    admitUnitWorkKind(kind, intervalMs);
  }
}
