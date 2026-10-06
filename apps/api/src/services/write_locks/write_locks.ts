// Cross-segment write locks (cloud-native DESIGN §6). A movement segment takes
// one holder, acquires the names its writes need, and releases everything when
// the segment ends. Two backends share the holder logic below: Postgres
// advisory locks across processes (`postgres.ts`), and an in-process gate for
// tests and single-process embeds.

import { MovementEngineError } from '../movement_engine/errors';

export const DEFAULT_WRITE_LOCK_TIMEOUT_MS = 60_000;

export interface WriteLockHolder {
  /**
   * Acquire all names exclusively, one at a time in sorted order; reentrant
   * within the holder. The timeout (`timeoutMs`, default 60_000) applies PER
   * NAME: rejects MOVENG_RUNTIME 'write lock timeout: <name>'. A cross-holder
   * deadlock or a lost session rejects loudly too ('write lock deadlock:
   * <name>', 'write lock session lost: <name>'), never hangs.
   *
   * Names taken before a failing one stay held until `release()`, so callers
   * release in `finally`. Sorting orders the names of ONE call only: two
   * holders that acquire overlapping sets across several calls can still
   * deadlock.
   */
  acquire(names: readonly string[]): Promise<void>;
  /** Release everything and drop the underlying session. Idempotent. Waits for
   *  any acquire still in flight on this holder, so a lock granted after the
   *  release began is released too rather than leaked. */
  release(): Promise<void>;
}

export interface WriteLocks {
  /** One holder per segment. `scope` is prefixed into every key (teamId). */
  holder(scope: string): WriteLockHolder;
}

export function lockKey(scope: string, name: string): string {
  return `${scope}|${name}`;
}

export function writeLockTimeout(name: string): MovementEngineError {
  return new MovementEngineError('MOVENG_RUNTIME', `write lock timeout: ${name}`, { name });
}

export function writeLockDeadlock(name: string): MovementEngineError {
  return new MovementEngineError('MOVENG_RUNTIME', `write lock deadlock: ${name}`, { name });
}

/** `name` is the lock being waited for when the session dropped, when there is one. */
export function writeLockSessionLost(name?: string): MovementEngineError {
  return name === undefined
    ? new MovementEngineError('MOVENG_RUNTIME', 'write lock session lost')
    : new MovementEngineError('MOVENG_RUNTIME', `write lock session lost: ${name}`, { name });
}

/** What a backend provides to a holder: one exclusive lock per key, and a way
 *  to drop every lock it took. */
export interface LockSession {
  lock(key: string, name: string): Promise<void>;
  unlockAll(): Promise<void>;
  /** Throws when the locks taken so far may no longer be held. */
  assertIntact(): void;
}

export class ScopedHolder implements WriteLockHolder {
  // Pending as well as granted, so two concurrent acquires of one name within
  // the holder share a single wait instead of the second queueing behind the
  // first (which would deadlock the in-memory gate).
  private readonly taken = new Map<string, Promise<void>>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly scope: string,
    protected readonly session: LockSession,
  ) {}

  acquire(names: readonly string[]): Promise<void> {
    const acquiring = this.acquireSorted(names);
    this.inFlight.add(acquiring);
    const forget = () => this.inFlight.delete(acquiring);
    acquiring.then(forget, forget);
    return acquiring;
  }

  private async acquireSorted(names: readonly string[]): Promise<void> {
    // Without this a re-acquire of a name taken before the session dropped
    // would be skipped as reentrant, and the write would run unlocked.
    this.session.assertIntact();
    // A total order on names means two holders wanting overlapping sets can
    // never each hold what the other waits for.
    for (const name of [...new Set(names)].sort()) {
      const key = lockKey(this.scope, name);
      const existing = this.taken.get(key);
      if (existing) {
        await existing;
        continue;
      }
      const taking = this.session.lock(key, name);
      this.taken.set(key, taking);
      taking.catch(() => {
        if (this.taken.get(key) === taking) this.taken.delete(key);
      });
      await taking;
    }
  }

  async release(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
    this.taken.clear();
    await this.session.unlockAll();
  }
}

type Gates = Map<string, Promise<void>>;

class InMemorySession implements LockSession {
  private readonly opens: Array<() => void> = [];

  constructor(
    private readonly gates: Gates,
    private readonly timeoutMs: number,
  ) {}

  lock(key: string, name: string): Promise<void> {
    const prior = this.gates.get(key) ?? Promise.resolve();
    let open: () => void = () => {};
    const mine = new Promise<void>((resolve) => (open = resolve));
    const tail = prior.then(() => mine);
    this.gates.set(key, tail);
    void tail.then(() => {
      if (this.gates.get(key) === tail) this.gates.delete(key);
    });
    this.opens.push(open);

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Opening our own gate keeps the chain moving: whoever queued behind
        // us still waits for `prior`, then passes straight through.
        open();
        reject(writeLockTimeout(name));
      }, this.timeoutMs);
      void prior.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async unlockAll(): Promise<void> {
    for (const open of this.opens.splice(0)) open();
  }

  assertIntact(): void {}
}

export class InMemoryWriteLocks implements WriteLocks {
  private readonly gates: Gates = new Map();
  private readonly timeoutMs: number;

  constructor(opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_WRITE_LOCK_TIMEOUT_MS;
  }

  holder(scope: string): WriteLockHolder {
    return new ScopedHolder(scope, new InMemorySession(this.gates, this.timeoutMs));
  }
}
