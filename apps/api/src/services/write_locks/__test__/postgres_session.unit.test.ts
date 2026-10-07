// The Postgres lock session against a scripted client: the failure timings a
// real server cannot be made to produce on demand.

import { EventEmitter } from 'node:events';

type Script = (text: string, client: FakeClient) => Promise<unknown>;

const clients: FakeClient[] = [];
let script: Script = async () => ({ rows: [{ granted: true }] });

class FakeClient extends EventEmitter {
  ended = false;
  constructor(readonly config: { query_timeout?: number }) {
    super();
    clients.push(this);
  }
  async connect(): Promise<void> {}
  query(text: string): Promise<unknown> {
    if (text.startsWith('SET ')) return Promise.resolve({ rows: [] });
    return script(text, this);
  }
  async end(): Promise<void> {
    this.ended = true;
  }
}

jest.mock('pg', () => ({ Client: FakeClient, DatabaseError: class DatabaseError extends Error {} }));
jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { logger } from '../../logger';
import { PostgresWriteLocks } from '../postgres';

/** What pg does with `query_timeout` when no reply ever comes. */
function hangingUntilTimeout(client: FakeClient): Promise<unknown> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error('Query read timeout')), client.config.query_timeout);
  });
}

beforeEach(() => {
  clients.length = 0;
  script = async () => ({ rows: [{ granted: true }] });
  jest.mocked(logger.warn).mockClear();
});

describe('PostgresWriteLocks session', () => {
  it('gives every lock query a client-side timeout, 5 s by default', async () => {
    const holder = new PostgresWriteLocks({ connectionString: 'postgres://fake' }).holder('t');
    await holder.acquire(['a']);
    expect(clients[0]!.config.query_timeout).toBe(5_000);
    await holder.release();
  });

  it('a lock query that never answers loses the session within the query timeout', async () => {
    const holder = new PostgresWriteLocks({ connectionString: 'postgres://fake', queryTimeoutMs: 100 }).holder('t');
    await holder.acquire(['a']);
    script = async (_text, client) => hangingUntilTimeout(client);

    const started = Date.now();
    await expect(holder.acquire(['b'])).rejects.toThrow('write lock session lost: b');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(clients[0]!.ended).toBe(true);
    // 'a' was held when the session went, so the holder refuses from here on.
    await expect(holder.acquire(['c'])).rejects.toThrow('write lock session lost');
    await holder.release();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('may have run unprotected'), { names: ['a'] });
  });

  it('a grant read in the same socket read as the drop is not recorded', async () => {
    const holder = new PostgresWriteLocks({ connectionString: 'postgres://fake' }).holder('t');
    script = (_text, client) => {
      const reply = Promise.resolve({ rows: [{ granted: true }] });
      client.emit('error', new Error('Connection terminated unexpectedly'));
      return reply;
    };
    await expect(holder.acquire(['a'])).rejects.toThrow('write lock session lost: a');

    // Nothing was recorded as held, so the next acquire reconnects quietly.
    script = async () => ({ rows: [{ granted: true }] });
    await holder.acquire(['b']);
    expect(clients).toHaveLength(2);
    await holder.release();
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('may have run unprotected'), expect.anything());
  });
});
