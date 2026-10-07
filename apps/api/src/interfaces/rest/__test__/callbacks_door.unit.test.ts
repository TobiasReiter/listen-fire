// The callback HTTP door. Two claims carry the whole route:
//
//   1. GET NEVER FIRES. It renders a confirm page and nothing else — the
//      prefetch-safety rule, pinned by asserting the router is never called on
//      any GET, including one carrying values in the query string.
//   2. POST is the only firing verb, and it is tolerant about WHERE the values
//      came from (JSON body, urlencoded form, query) while being loud about
//      whether they MATCH.
//
// The store + router are mocked: what is under test is the door, not the CAS.

import { createServer, type Server } from 'node:http';

import express, { type Router } from 'express';

import type { AddressInfo } from 'node:net';
import type { CallbackRecord } from '../../../services/movement_engine/callback_store';
import type { CallbackFireOutcome } from '../../../services/movement_engine/callback_fire';

const getCallback = jest.fn<Promise<CallbackRecord | null>, [string]>();
const fireCallback = jest.fn<Promise<CallbackFireOutcome>, [unknown]>();

jest.mock('../../../services/movement_engine/callback_store', () => ({
  getCallback: (id: string) => getCallback(id),
}));
jest.mock('../../../services/movement_engine/callback_fire', () => ({
  fireCallback: (input: unknown) => fireCallback(input),
}));

import { callbacksRouter } from '../callbacks';

let server: Server;
let baseUrl: string;

function record(overrides: Partial<CallbackRecord> = {}): CallbackRecord {
  return {
    id: 'cb_abc',
    teamId: 'team-1',
    runId: 'run-1',
    address: 's1',
    params: [],
    state: { version: 1, address: 's1', bindingName: null, scopeChain: [] },
    calls: [],
    singleUse: true,
    expiresAt: null,
    status: 'live',
    createdAt: new Date('2026-07-31T09:00:00.000Z'),
    firedAt: null,
    revokedAt: null,
    ...overrides,
  } as CallbackRecord;
}

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/cb', callbacksRouter as Router);
  server = createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});

beforeEach(() => {
  jest.clearAllMocks();
  fireCallback.mockResolvedValue({ kind: 'recorded', callback: record() });
});

describe('GET — renders, never fires', () => {
  it('a zero-parameter callback renders a confirm button that POSTs back', async () => {
    getCallback.mockResolvedValue(record());

    const res = await fetch(`${baseUrl}/api/cb/cb_abc`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('<form method="post" action="/api/cb/cb_abc">');
    expect(html).toContain('Confirm');
    // The load-bearing assertion: following the link fired nothing.
    expect(fireCallback).not.toHaveBeenCalled();
  });

  it('NEVER fires even when the GET carries values in the query string', async () => {
    getCallback.mockResolvedValue(record({ params: [{ name: 'note', type: 'text' }] }));

    const res = await fetch(`${baseUrl}/api/cb/cb_abc?note=prefetched`);

    expect(res.status).toBe(200);
    expect(fireCallback).not.toHaveBeenCalled();
  });

  it('renders one control per parameter, typed from the signature, in declaration order', async () => {
    getCallback.mockResolvedValue(
      record({
        params: [
          { name: 'when', type: 'date' },
          { name: 'howMany', type: 'number' },
          { name: 'ok', type: 'boolean' },
          { name: 'note', type: 'text' },
        ],
      }),
    );

    const html = await (await fetch(`${baseUrl}/api/cb/cb_abc`)).text();

    expect(html).toContain('<input type="date" name="when"');
    expect(html).toContain('<input type="number" step="any" name="howMany"');
    expect(html).toContain('<select name="ok">');
    expect(html).toContain('<input type="text" name="note"');
    // Declaration order, not alphabetical or schema order.
    expect(html.indexOf('name="when"')).toBeLessThan(html.indexOf('name="howMany"'));
    expect(html.indexOf('name="ok"')).toBeLessThan(html.indexOf('name="note"'));
  });

  it('is self-contained — no external assets (it may be the only thing a channel can deliver)', async () => {
    getCallback.mockResolvedValue(record());
    const html = await (await fetch(`${baseUrl}/api/cb/cb_abc`)).text();

    expect(html).not.toMatch(/<script\s+src=/i);
    expect(html).not.toMatch(/<link\s+[^>]*rel="stylesheet"/i);
    expect(html).toContain('<style>');
  });

  it('renders the CLOSED page for a fired / revoked / expired callback', async () => {
    for (const [overrides, expected] of [
      [{ status: 'fired' as const }, 'This action was closed'],
      [{ status: 'revoked' as const }, 'This action was closed'],
      [{ expiresAt: new Date(Date.now() - 1000) }, 'This action has expired'],
    ] as const) {
      getCallback.mockResolvedValue(record(overrides));
      const res = await fetch(`${baseUrl}/api/cb/cb_abc`);
      expect(res.status).toBe(410);
      expect(await res.text()).toContain(expected);
    }
    expect(fireCallback).not.toHaveBeenCalled();
  });

  it('an unknown id is a 404, and nothing is fired', async () => {
    getCallback.mockResolvedValue(null);
    const res = await fetch(`${baseUrl}/api/cb/cb_nope`);
    expect(res.status).toBe(404);
    expect(fireCallback).not.toHaveBeenCalled();
  });
});

describe('POST — the only firing verb', () => {
  it('answers 202 when the body is queued behind another instance', async () => {
    fireCallback.mockResolvedValue({ kind: 'recorded', callback: record(), queued: true });
    const res = await fetch(`${baseUrl}/api/cb/cb_abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ outcome: 'recorded' });
  });

  it('answers 500, never hangs, when firing throws — JSON and page alike', async () => {
    fireCallback.mockRejectedValue(new Error('lease table unreachable'));
    const json = await fetch(`${baseUrl}/api/cb/cb_abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{}',
    });
    expect(json.status).toBe(500);
    expect(await json.json()).toMatchObject({ outcome: 'error' });
    const page = await fetch(`${baseUrl}/api/cb/cb_abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
      body: '',
    });
    expect(page.status).toBe(500);
    expect(await page.text()).toContain('Something went wrong');
  });

  it('fires from a JSON body', async () => {
    const res = await fetch(`${baseUrl}/api/cb/cb_abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ note: 'ship it' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'recorded' });
    expect(fireCallback).toHaveBeenCalledWith({ id: 'cb_abc', values: { note: 'ship it' } });
  });

  it('fires from an urlencoded FORM body, and answers a browser with a page', async () => {
    const res = await fetch(`${baseUrl}/api/cb/cb_abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
      body: 'note=from+the+form',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(fireCallback).toHaveBeenCalledWith({
      id: 'cb_abc',
      values: { note: 'from the form' },
    });
  });

  it('fires from the QUERY string too (the ask door’s tolerance)', async () => {
    await fetch(`${baseUrl}/api/cb/cb_abc?note=from+the+query`, {
      method: 'POST',
      headers: { accept: 'application/json' },
    });

    expect(fireCallback).toHaveBeenCalledWith({
      id: 'cb_abc',
      values: { note: 'from the query' },
    });
  });

  it('relays a MISMATCH loudly — 400 with the router’s own message, never a default', async () => {
    fireCallback.mockResolvedValue({
      kind: 'mismatch',
      callback: record(),
      message: "missing 'when' — this callback expects when (date)",
    });

    const res = await fetch(`${baseUrl}/api/cb/cb_abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      outcome: 'mismatch',
      message: "missing 'when' — this callback expects when (date)",
    });
  });

  it('relays closed / expired / not_found with their own statuses', async () => {
    const cases = [
      [{ kind: 'closed', callback: record() }, 410],
      [{ kind: 'expired', callback: record() }, 410],
      [{ kind: 'not_found' }, 404],
    ] as const;
    for (const [outcome, status] of cases) {
      fireCallback.mockResolvedValue(outcome as CallbackFireOutcome);
      const res = await fetch(`${baseUrl}/api/cb/cb_abc`, {
        method: 'POST',
        headers: { accept: 'application/json' },
      });
      expect(res.status).toBe(status);
      expect((await res.json()).outcome).toBe(outcome.kind);
    }
  });
});
