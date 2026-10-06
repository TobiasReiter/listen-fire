// Write locks across processes: Postgres session-level advisory locks, one
// dedicated connection per holder. Session locks must be unlocked on the
// session that took them, and the segment's request context may be inside an
// open transaction, so neither the shared pool nor the context's transaction
// can carry them. A holder whose process dies loses its session, and with it
// every lock it held.

import { Client, DatabaseError } from 'pg';

import { logger } from '../logger';
import {
  DEFAULT_WRITE_LOCK_TIMEOUT_MS,
  type LockSession,
  ScopedHolder,
  type WriteLocks,
  writeLockSessionLost,
  writeLockTimeout,
} from './write_locks';

// Postgres `lock_not_available`: what `lock_timeout` raises.
const LOCK_NOT_AVAILABLE = '55P03';

type PostgresOptions = { connectionString: string; timeoutMs: number };

class PostgresSession implements LockSession {
  private client: Promise<Client> | undefined;
  private lost = false;

  constructor(private readonly opts: PostgresOptions) {}

  async lock(key: string, name: string): Promise<void> {
    const client = await this.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
    } catch (err) {
      if (err instanceof DatabaseError && err.code === LOCK_NOT_AVAILABLE) {
        throw writeLockTimeout(name);
      }
      throw err;
    }
  }

  async unlockAll(): Promise<void> {
    const pending = this.client;
    this.client = undefined;
    this.lost = false;
    if (!pending) return;
    const client = await pending.catch(() => undefined);
    if (!client) return;
    try {
      await client.query('SELECT pg_advisory_unlock_all()');
    } catch (err) {
      // Ending the session drops its locks anyway; the explicit unlock only
      // frees them before the backend finishes exiting.
      logger.warn('[write_locks] unlock failed; ending the session instead', { err });
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  assertIntact(): void {
    if (this.lost) throw writeLockSessionLost();
  }

  async backendPid(): Promise<number | undefined> {
    if (!this.client) return undefined;
    const client = await this.client;
    const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    return result.rows[0].pid;
  }

  private connect(): Promise<Client> {
    this.client ??= this.open().catch((err) => {
      this.client = undefined;
      throw err;
    });
    return this.client;
  }

  private async open(): Promise<Client> {
    const client = new Client({ connectionString: this.opts.connectionString });
    // An unhandled 'error' on a pg Client crashes the process. A dropped
    // session took its locks with it, so the holder refuses further acquires.
    client.on('error', (err) => {
      this.lost = true;
      logger.warn('[write_locks] lock session dropped', { err });
    });
    try {
      await client.connect();
      await client.query("SELECT set_config('lock_timeout', $1, false)", [
        `${this.opts.timeoutMs}ms`,
      ]);
      return client;
    } catch (err) {
      await client.end().catch(() => undefined);
      throw err;
    }
  }
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

  constructor(opts: { connectionString: string; timeoutMs?: number }) {
    this.opts = {
      connectionString: opts.connectionString,
      timeoutMs: opts.timeoutMs ?? DEFAULT_WRITE_LOCK_TIMEOUT_MS,
    };
  }

  holder(scope: string): PostgresWriteLockHolder {
    return new PostgresWriteLockHolder(scope, new PostgresSession(this.opts));
  }
}
