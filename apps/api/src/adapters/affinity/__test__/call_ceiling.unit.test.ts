// The Affinity client counts every request it actually puts on the wire
// against the run's ceiling, and stops the run once it is over.
//
// Two things are easy to get wrong and are asserted here: the ceiling is
// charged where the call is ISSUED (the client is a process-wide singleton
// behind a shared queue, so the run has to be captured, not looked up when the
// job eventually executes), and the ceiling error is TERMINAL — the retry loop
// must not spend four more attempts on the very error that exists to stop
// spending.

jest.mock('../../../services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../../lib/slack', () => ({ sendSlackNotification: jest.fn() }));

jest.mock('../../../services/context', () => ({
  currentContext: () => ({ user: { id: 'u1' } }),
}));

import type { TeamId } from '../../../generated/kysely/core/Team';

import { AffinityAPIClient } from '../apiClient';
import { withSegment } from '../../../services/translation_graph/segment_scope';

/** One run segment's host scope, as the engine opens it for a run. */
const inARun = <T>(fn: () => Promise<T>) =>
  withSegment({ teamId: '00000000-0000-0000-0000-000000000081' as TeamId }, fn);

const BASE = 'https://affinity.test';
const ENV_VAR = 'AFFINITY_MAX_CALLS_PER_RUN';

function serveOk(): jest.Mock {
  const stub = jest.fn(
    async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  global.fetch = stub as unknown as typeof fetch;
  return stub;
}

async function get(client: AffinityAPIClient): Promise<unknown> {
  return client.fetch({ route: '/organizations/1', method: 'GET' });
}

describe('AffinityAPIClient honours the run call ceiling', () => {
  const original = process.env[ENV_VAR];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = original;
  });

  it('stops the run on the call past the ceiling, without retrying it', async () => {
    process.env[ENV_VAR] = '3';
    const stub = serveOk();
    const client = new AffinityAPIClient({ apiKey: 'k', baseUrl: BASE });

    const started = Date.now();
    await inARun(async () => {
      await get(client);
      await get(client);
      await get(client);
      await expect(get(client)).rejects.toThrow(
        'Affinity call ceiling reached: this run made 3 Affinity API calls, ' +
          'the limit set by AFFINITY_MAX_CALLS_PER_RUN. ' +
          'The run was stopped in case something was looping.',
      );
    });

    expect(stub).toHaveBeenCalledTimes(3);
    // The backoff loop's first retry alone waits a second; a prompt failure is
    // the evidence that the ceiling error was treated as terminal.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('leaves calls made outside a run uncounted', async () => {
    process.env[ENV_VAR] = '1';
    const stub = serveOk();
    const client = new AffinityAPIClient({ apiKey: 'k', baseUrl: BASE });

    await get(client);
    await get(client);
    await get(client);

    expect(stub).toHaveBeenCalledTimes(3);
  });
});
