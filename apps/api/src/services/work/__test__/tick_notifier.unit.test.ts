import http from 'node:http';

import { logger } from 'movement-engine/services/logger';
import { HttpTickNotifier, NoopNotifier } from '../drain';

jest.mock('../store', () => ({
  claimDueWork: jest.fn(),
  completeWork: jest.fn(),
  deferWork: jest.fn(),
  heartbeatWork: jest.fn(),
  releaseWork: jest.fn(),
}));

jest.mock('movement-engine/services/logger', () => ({
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

/** A drain endpoint that answers only when told to (or never). */
async function heldDrain(): Promise<{ url: string; count(): number; arrived(n: number): Promise<void>; answerAll(): void; close(): Promise<void> }> {
  let count = 0;
  const held: http.ServerResponse[] = [];
  const watchers: Array<{ n: number; resolve: () => void }> = [];
  const server = http.createServer((req, res) => {
    req.resume();
    count += 1;
    held.push(res);
    for (const watcher of watchers.filter((w) => w.n <= count)) watcher.resolve();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the stub drain is not on a TCP port');
  return {
    url: `http://127.0.0.1:${address.port}/api/v1/system/automations/drain`,
    count: () => count,
    arrived: (n) => new Promise<void>((resolve) => (n <= count ? resolve() : watchers.push({ n, resolve }))),
    answerAll: () => {
      for (const res of held.splice(0)) res.end('{"claimed":0}');
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
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

describe('HttpTickNotifier\'s latch and timeout', () => {
  it('ten notifies during one slow tick make two requests: the one in flight, and one owed', async () => {
    const drain = await heldDrain();
    try {
      const notifier = new HttpTickNotifier({ urls: [drain.url], apiKey: 'lf_key' });
      notifier.notify();
      await drain.arrived(1);
      for (let i = 0; i < 9; i++) notifier.notify();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(drain.count()).toBe(1);

      drain.answerAll();
      await drain.arrived(2);
      drain.answerAll();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(drain.count()).toBe(2);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await drain.close();
    }
  });

  it('a tick with no answer in time warns once, does not throw, and frees the URL for the owed tick', async () => {
    const drain = await heldDrain();
    try {
      const notifier = new HttpTickNotifier({ urls: [drain.url], apiKey: 'lf_key', timeoutMs: 50 });
      expect(() => notifier.notify()).not.toThrow();
      await drain.arrived(1);
      notifier.notify();
      // The first times out, then the owed one is sent, and times out too.
      await drain.arrived(2);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('drain tick failed'), {
        url: drain.url,
        reason: expect.stringContaining('no answer within 50 ms'),
      });
    } finally {
      await drain.close();
    }
  });
});

describe('NoopNotifier', () => {
  it('does nothing', () => {
    expect(() => new NoopNotifier().notify()).not.toThrow();
  });
});
