// Cross-run write locks (cloud-native DESIGN §6). A movement segment takes one
// holder, and each effect acquires the names its write needs and gives them
// back when the effect is done; only the holder's session lives for the
// segment, and closing it lets go of anything left. Two backends share the holder logic below: Postgres
// advisory locks across processes (`postgres.ts`), and an in-process gate for
// tests and single-process embeds.

import type { HostLocks } from '../movement_engine/host';

import { MovementEngineError } from '../movement_engine/errors';

export const DEFAULT_WRITE_LOCK_TIMEOUT_MS = 60_000;

export const WRITE_LOCK_TIMEOUT_ENV_VAR = 'MOVEMENT_WRITE_LOCK_TIMEOUT_MS';

/** The per-name wait, or the default when unset. Throws on a value that is set
 *  but is not a positive whole number of milliseconds: a typo must not read as
 *  "never wait" or "wait forever". */
export function parseWriteLockTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_WRITE_LOCK_TIMEOUT_MS;
  const ms = Number(raw.trim());
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new Error(
      `${WRITE_LOCK_TIMEOUT_ENV_VAR}="${raw}" is not a positive whole number. ` +
        `Set it to how many milliseconds a write may wait for another run's lock (e.g. ${WRITE_LOCK_TIMEOUT_ENV_VAR}=${DEFAULT_WRITE_LOCK_TIMEOUT_MS}), ` +
        `or leave it unset for the default of ${DEFAULT_WRITE_LOCK_TIMEOUT_MS}.`,
    );
  }
  return ms;
}

/** Boot: refuse a timeout set to nonsense, rather than letting the first
 *  contended write find out. */
export function assertWriteLockTimeoutConfigured(env: NodeJS.ProcessEnv = process.env): void {
  parseWriteLockTimeoutMs(env[WRITE_LOCK_TIMEOUT_ENV_VAR]);
}

export interface WriteLockHolder {
  /**
   * Acquire all names exclusively, one at a time in sorted order. Within the
   * holder a name is counted, not queued: a second acquire of a name the
   * holder holds (or is waiting for) shares it, and the lock is let go when
   * every acquire of it has been released. The timeout (`timeoutMs`, default
   * 60_000) applies PER NAME: rejects MOVENG_RUNTIME 'write lock timeout:
   * <name>'. A cross-holder deadlock surfaces the same way, as a timeout; a
   * lost session rejects 'write lock session lost: <name>'. Neither hangs.
   *
   * All or nothing: a failing acquire gives back what that call took, so a
   * caller releases only after an acquire that resolved. Sorting orders the
   * names of ONE call only: two holders that acquire overlapping sets across
   * several calls can still deadlock.
   */
  acquire(names: readonly string[]): Promise<void>;
  /**
   * With `names`: give back one count of each, as one earlier `acquire(names)`
   * took them, in reverse order; a name whose count reaches zero is unlocked.
   *
   * Without: release everything, drop the underlying session and close the
   * holder; any later acquire rejects MOVENG_RUNTIME 'write lock holder is
   * closed'. Idempotent. An acquire still polling for another holder's lock
   * gives up with that same rejection (the in-memory gate waits it out); one
   * whose query is in flight is waited for, so a lock granted after the
   * release began is released too rather than leaked.
   */
  release(names?: readonly string[]): Promise<void>;
}

export interface WriteLocks {
  /** One holder per segment. `scope` is prefixed into every key (teamId). */
  holder(scope: string): WriteLockHolder;
}

/**
 * The host's `locks` family over a `WriteLocks`: one holder per segment,
 * opened at the segment's first acquire under the segment's team, and closed
 * when the segment closes. Each acquire answers a token that releases exactly
 * what it took, so an effect gives its names back when it is done.
 */
export interface SegmentWriteLocks extends HostLocks {
  /** Remember the team a segment's holder is scoped to. */
  opened(segmentId: string, teamId: string): void;
  /** Close the segment's holder (letting go of anything still held). */
  closed(segmentId: string): Promise<void>;
}

export function segmentWriteLocks(locks: WriteLocks): SegmentWriteLocks {
  const teams = new Map<string, string>();
  const holders = new Map<string, WriteLockHolder>();
  const tokens = new Map<string, { segmentId: string; names: readonly string[] }>();
  let next = 0;
  const holderOf = (segmentId: string): WriteLockHolder => {
    let holder = holders.get(segmentId);
    if (holder === undefined) {
      const team = teams.get(segmentId);
      if (team === undefined) {
        throw new MovementEngineError('MOVENG_RUNTIME', `write locks asked for segment '${segmentId}', which is not open`);
      }
      holder = locks.holder(team);
      holders.set(segmentId, holder);
    }
    return holder;
  };
  return {
    opened(segmentId, teamId) {
      teams.set(segmentId, teamId);
    },
    async acquire({ segmentId, names }) {
      await holderOf(segmentId).acquire(names);
      const token = `${segmentId}#${++next}`;
      tokens.set(token, { segmentId, names: [...names] });
      return { token };
    },
    async release({ token }) {
      const taken = tokens.get(token);
      if (taken === undefined) {
        throw new MovementEngineError('MOVENG_RUNTIME', `write lock token '${token}' is not held: released twice, or never acquired`);
      }
      tokens.delete(token);
      await holders.get(taken.segmentId)?.release(taken.names);
    },
    async closed(segmentId) {
      teams.delete(segmentId);
      for (const [token, taken] of tokens) if (taken.segmentId === segmentId) tokens.delete(token);
      const holder = holders.get(segmentId);
      holders.delete(segmentId);
      await holder?.release();
    },
  };
}

export function lockKey(scope: string, name: string): string {
  return `${scope}|${name}`;
}

export function writeLockTimeout(name: string): MovementEngineError {
  return new MovementEngineError('MOVENG_RUNTIME', `write lock timeout: ${name}`, { name });
}

export function writeLockHolderClosed(): MovementEngineError {
  return new MovementEngineError('MOVENG_RUNTIME', 'write lock holder is closed');
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
  unlock(key: string): Promise<void>;
  unlockAll(): Promise<void>;
  /** The holder is closing: a wait still in progress may give up early,
   *  rejecting 'write lock holder is closed'. */
  abandonWaits(): void;
  /** Throws when the locks taken so far may no longer be held. */
  assertIntact(): void;
}

/** One name the holder holds or waits for, and how many acquires share it. */
interface Holding {
  count: number;
  ready: Promise<void>;
  granted: boolean;
}

export class ScopedHolder implements WriteLockHolder {
  // Pending as well as granted, so two concurrent acquires of one name within
  // the holder share a single wait instead of the second queueing behind the
  // first (which would deadlock the in-memory gate).
  private readonly holdings = new Map<string, Holding>();
  private readonly inFlight = new Set<Promise<void>>();
  private closed = false;

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
    // A closed holder has no session to lock on; acquiring would quietly open
    // a fresh one that nothing ever releases.
    if (this.closed) throw writeLockHolderClosed();
    // Without this a re-acquire of a name taken before the session dropped
    // would share the stale holding, and the write would run unlocked.
    this.session.assertIntact();
    const counted: string[] = [];
    try {
      // A total order on names means two holders wanting overlapping sets can
      // never each hold what the other waits for.
      for (const name of sortedNames(names)) {
        const key = lockKey(this.scope, name);
        let holding = this.holdings.get(key);
        if (holding === undefined) {
          const ready = this.session.lock(key, name);
          const fresh: Holding = { count: 0, ready, granted: false };
          ready.then(
            () => (fresh.granted = true),
            () => undefined,
          );
          holding = fresh;
          this.holdings.set(key, holding);
        }
        holding.count += 1;
        counted.push(name);
        await holding.ready;
      }
    } catch (err) {
      await this.giveBack(counted);
      throw err;
    }
  }

  async release(names?: readonly string[]): Promise<void> {
    if (names !== undefined) {
      await this.giveBack(sortedNames(names));
      return;
    }
    this.closed = true;
    this.session.abandonWaits();
    await Promise.allSettled([...this.inFlight]);
    this.holdings.clear();
    await this.session.unlockAll();
  }

  private async giveBack(names: readonly string[]): Promise<void> {
    for (const name of [...names].reverse()) {
      const key = lockKey(this.scope, name);
      const holding = this.holdings.get(key);
      // Gone already: a whole release ran in between.
      if (holding === undefined) continue;
      holding.count -= 1;
      if (holding.count > 0) continue;
      this.holdings.delete(key);
      if (holding.granted) await this.session.unlock(key);
    }
  }
}

function sortedNames(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}

type Gates = Map<string, Promise<void>>;

class InMemorySession implements LockSession {
  private readonly opens = new Map<string, () => void>();

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
    this.opens.set(key, open);

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Opening our own gate keeps the chain moving: whoever queued behind
        // us still waits for `prior`, then passes straight through.
        open();
        this.opens.delete(key);
        reject(writeLockTimeout(name));
      }, this.timeoutMs);
      void prior.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async unlock(key: string): Promise<void> {
    this.opens.get(key)?.();
    this.opens.delete(key);
  }

  async unlockAll(): Promise<void> {
    for (const open of this.opens.values()) open();
    this.opens.clear();
  }

  // A gate wait ends when the gate opens or times out; there is no poll to stop.
  abandonWaits(): void {}

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
