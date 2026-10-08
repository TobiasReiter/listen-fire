import http from 'node:http';

import { logger } from '../../logger';
import { HttpTickNotifier, NoopNotifier } from '../drain';

jest.mock('../store', () => ({
  claimDueWork: jest.fn(),
  completeWork: jest.fn(),
  deferWork: jest.fn(),
  heartbeatWork: jest.fn(),
  releaseWork: jest.fn(),
}));

jest.mock('../../logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

interface Tick {
  path: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

/** A stand-in drain endpoint: records each tick and answers with `status`. */
async function stubDrain(status: number): Promise<{ url: string; ticks: Tick[]; next(): Promise<Tick>; close(): Promise<void> }> {
  const ticks: Tick[] = [];
  const waiting: Array<(tick: Tick) => void> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const tick = {
        path: req.url ?? '',
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body,
      };
      ticks.push(tick);
      waiting.shift()?.(tick);
      res.statusCode = status;
      res.end(status === 200 ? '{"claimed":0}' : 'boom');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the stub drain is not on a TCP port');
  const { port } = address;
  return {
    url: `http://127.0.0.1:${port}/api/v1/system/automations/drain`,
    ticks,
    next: () => new Promise<Tick>((resolve) => waiting.push(resolve)),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const warn = jest.mocked(logger.warn);

describe('HttpTickNotifier', () => {
  it('a notify POSTs an empty body once to each URL, with the bearer key', async () => {
    const [a, b] = await Promise.all([stubDrain(200), stubDrain(200)]);
    try {
      const arrived = Promise.all([a.next(), b.next()]);
      new HttpTickNotifier({ urls: [a.url, b.url], apiKey: 'lf_key' }).notify();
      const [tickA, tickB] = await arrived;
      for (const tick of [tickA, tickB]) {
        expect(tick).toEqual({
          path: '/api/v1/system/automations/drain',
          authorization: 'Bearer lf_key',
          contentType: 'application/json',
          body: '{}',
        });
      }
      // Let any stray second request land before counting.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(a.ticks).toHaveLength(1);
      expect(b.ticks).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it('a 500 neither throws nor stops later notifies, and is logged once a minute per URL', async () => {
    const drain = await stubDrain(500);
    try {
      const notifier = new HttpTickNotifier({ urls: [drain.url], apiKey: 'lf_key' });
      for (let i = 0; i < 3; i++) {
        const arrived = drain.next();
        expect(() => notifier.notify()).not.toThrow();
        await arrived;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(drain.ticks).toHaveLength(3);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('drain tick failed'), {
        url: drain.url,
        reason: 'HTTP 500',
      });
    } finally {
      await drain.close();
    }
  });

  it('an unreachable URL is logged, not thrown', async () => {
    const drain = await stubDrain(200);
    await drain.close();
    new HttpTickNotifier({ urls: [drain.url], apiKey: 'lf_key' }).notify();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('drain tick failed'), expect.objectContaining({ url: drain.url }));
  });
});

describe('NoopNotifier', () => {
  it('does nothing', () => {
    expect(() => new NoopNotifier().notify()).not.toThrow();
  });
});
