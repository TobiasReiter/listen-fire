// Write locks across processes: Postgres session-level advisory locks, one
// dedicated connection per holder. Session locks must be unlocked on the
// session that took them, and the segment's request context may be inside an
// open transaction, so neither the shared pool nor the context's transaction
// can carry them. A holder whose process dies loses its session, and with it
// every lock it held.
//
// Every parallel flow of a segment shares the one session, and a pg Client
// runs one query at a time. A blocking `pg_advisory_lock` would park the whole
// session: a sibling's unlock would queue behind the wait, and Postgres would
// see the segment as one waiter holding everything its flows hold, so two runs
// whose flows touch overlapping records in different orders would deadlock
// where neither flow does. So a lock is TRIED, never waited for on the
// session: the wait is a poll from this process, and the session stays free
// between polls. The price is that Postgres no longer sees a real cross-run
// deadlock; it surfaces as a timeout on one side instead.

import { Client, DatabaseError } from 'pg';

import { logger } from '../logger';
import {
  DEFAULT_WRITE_LOCK_TIMEOUT_MS,
  type LockSession,
  ScopedHolder,
  type WriteLocks,
  writeLockHolderClosed,
  writeLockSessionLost,
  writeLockTimeout,
} from './write_locks';

const FIRST_RETRY_MS = 25;
const MAX_RETRY_MS = 250;
const RETRY_JITTER = 0.2;

// Server-side keepalive, so a backend whose client machine died lets go of its
// locks within about a minute instead of the OS default of two hours.
const SERVER_KEEPALIVE =
  'SET tcp_keepalives_idle = 30; SET tcp_keepalives_interval = 10; SET tcp_keepalives_count = 3';
const CLIENT_KEEPALIVE_DELAY_MS = 30_000;
// Each lock query answers in milliseconds. One that does not is a half-open
// connection: with a request outstanding keepalive never probes, and TCP
// retransmission takes about fifteen minutes to give up, with every sibling's
// query queued behind it and the segment's release waiting on them.
const DEFAULT_QUERY_TIMEOUT_MS = 5_000;

type PostgresOptions = { connectionString: string; timeoutMs: number; queryTimeoutMs: number };

class PostgresSession implements LockSession {
  private client: Promise<Client> | undefined;
  /** The connected client, once there is one: what a drop is checked against,
   *  so a late error from a replaced client cannot mark its successor lost. */
  private live: Client | undefined;
  private lost = false;
  /** Granted on the live client: key → lock name. */
  private readonly held = new Map<string, string>();
  /** What was granted when the session dropped. Non-empty means a write may
   *  have run after its lock was gone, so the holder refuses until released. */
  private heldAtLoss: string[] = [];
  /** The holder is closing: a polling acquire gives up rather than keep the
   *  release waiting until its timeout. */
  private abandoned = false;

  constructor(private readonly opts: PostgresOptions) {}

  async lock(key: string, name: string): Promise<void> {
    const deadline = Date.now() + this.opts.timeoutMs;
    let retryMs = FIRST_RETRY_MS;
    for (;;) {
      if (this.abandoned) throw writeLockHolderClosed();
      const client = await this.connect(name);
      let granted: boolean;
      try {
        const result = await client.query<{ granted: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS granted',
          [key],
        );
        granted = result.rows[0]?.granted === true;
      } catch (err) {
        if (this.lost || isConnectionLoss(err)) {
          this.markLost(client, err);
          throw writeLockSessionLost(name);
        }
        throw err;
      }
      // The session can drop in the same socket read that carried the grant;
      // a grant on a dead session holds nothing.
      if (this.lost || client !== this.live) throw writeLockSessionLost(name);
      if (granted) {
        this.held.set(key, name);
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw writeLockTimeout(name);
      await sleep(Math.min(jittered(retryMs), remaining));
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    }
  }

  async unlock(key: string): Promise<void> {
    // Not granted on the live session: the session dropped and took it along.
    if (!this.held.has(key)) return;
    const client = this.live;
    if (!client || this.lost) return;
    try {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
      this.held.delete(key);
    } catch (err) {
      // Still counted as held, so a drop found here is reported as one that
      // took a lock with it.
      if (isConnectionLoss(err)) {
        this.markLost(client, err);
        return;
      }
      // The effect it guarded is done; failing it now would undo nothing. A
      // lock this left behind goes when the segment's session ends.
      logger.warn('[write_locks] unlock failed; the lock stays until the segment ends', { err });
    }
  }

  async unlockAll(): Promise<void> {
    const pending = this.client;
    const wasLost = this.lost;
    this.client = undefined;
    this.live = undefined;
    if (this.heldAtLoss.length > 0) {
      logger.warn(
        '[write_locks] the lock session dropped while these locks were held; the writes they guarded may have run unprotected',
        { names: this.heldAtLoss },
      );
    }
    const client = await pending?.catch(() => undefined);
    try {
      if (client && !wasLost) await client.query('SELECT pg_advisory_unlock_all()');
    } catch (err) {
      // Ending the session drops its locks anyway; the explicit unlock only
      // frees them before the backend finishes exiting.
      logger.warn('[write_locks] unlock failed; ending the session instead', { err });
    } finally {
      await client?.end().catch(() => undefined);
      this.held.clear();
      // Only now: an acquire racing the unlock must still see the session as lost.
      this.heldAtLoss = [];
      this.lost = false;
    }
  }

  abandonWaits(): void {
    this.abandoned = true;
  }

  assertIntact(): void {
    if (this.heldAtLoss.length > 0) throw writeLockSessionLost();
  }

  async backendPid(): Promise<number | undefined> {
    if (!this.client) return undefined;
    const client = await this.client;
    const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    return result.rows[0].pid;
  }

  private connect(name: string): Promise<Client> {
    if (this.lost) {
      if (this.heldAtLoss.length > 0) return Promise.reject(writeLockSessionLost(name));
      // Nothing was held when it dropped, so nothing can have run unprotected:
      // a fresh session is as good as the old one.
      logger.warn('[write_locks] lock session dropped while holding nothing; reconnecting');
      void this.live?.end().catch(() => undefined);
      this.client = undefined;
      this.live = undefined;
      this.lost = false;
    }
    this.client ??= this.open().catch((err) => {
      this.client = undefined;
      throw err;
    });
    return this.client;
  }

  private markLost(client: Client, err: unknown): void {
    if (client !== this.live || this.lost) return;
    this.lost = true;
    this.heldAtLoss = [...this.held.values()];
    this.held.clear();
    if (this.heldAtLoss.length > 0) {
      logger.warn('[write_locks] lock session dropped', { err, names: this.heldAtLoss });
    }
    // A timed-out query leaves the protocol mid-reply; nothing more can be
    // read from this connection.
    void client.end().catch(() => undefined);
  }

  private async open(): Promise<Client> {
    // The session lives for the whole segment, idle between effects for
    // minutes; keepalive lets a dead peer (or a NAT dropping an idle
    // connection) surface as a lost session.
    const client = new Client({
      connectionString: this.opts.connectionString,
      keepAlive: true,
      keepAliveInitialDelayMillis: CLIENT_KEEPALIVE_DELAY_MS,
      query_timeout: this.opts.queryTimeoutMs,
    });
    // An unhandled 'error' on a pg Client crashes the process.
    client.on('error', (err) => this.markLost(client, err));
    try {
      await client.connect();
      await client.query(SERVER_KEEPALIVE);
      this.live = client;
      return client;
    } catch (err) {
      await client.end().catch(() => undefined);
      throw err;
    }
  }
}

/** The connection under a query went away, rather than the query failing. */
function isConnectionLoss(err: unknown): boolean {
  if (err instanceof DatabaseError) {
    // Class 08 is connection exceptions; 57P01..57P03 a backend shut down
    // under the session (pg_terminate_backend, a crash, a restart).
    return err.code?.startsWith('08') === true || ['57P01', '57P02', '57P03'].includes(err.code ?? '');
  }
  if (!(err instanceof Error)) return false;
  if ('code' in err && typeof err.code === 'string') {
    if (['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED'].includes(err.code)) return true;
  }
  return /Connection terminated|not queryable|Query read timeout/.test(err.message);
}

function jittered(ms: number): number {
  return ms * (1 - RETRY_JITTER + Math.random() * 2 * RETRY_JITTER);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PostgresWriteLockHolder extends ScopedHolder {
  constructor(
    scope: string,
    private readonly postgres: PostgresSession,
  ) {
    super(scope, postgres);
  }

  /** The holder's backend pid, for tests that inspect or kill its session. */
  debugBackendPid(): Promise<number | undefined> {
    return this.postgres.backendPid();
  }
}

export class PostgresWriteLocks implements WriteLocks {
  private readonly opts: PostgresOptions;

  constructor(opts: { connectionString: string; timeoutMs?: number; queryTimeoutMs?: number }) {
    this.opts = {
      connectionString: opts.connectionString,
      timeoutMs: opts.timeoutMs ?? DEFAULT_WRITE_LOCK_TIMEOUT_MS,
      queryTimeoutMs: opts.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
    };
  }

  holder(scope: string): PostgresWriteLockHolder {
    return new PostgresWriteLockHolder(scope, new PostgresSession(this.opts));
  }
}
