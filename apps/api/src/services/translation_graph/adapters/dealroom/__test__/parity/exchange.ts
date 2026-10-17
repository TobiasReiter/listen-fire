// A local HTTP server an adapter is pointed at instead of its provider, for
// recorded parity. Recording, it forwards each request to the provider (the
// fake-channels Dealroom) and keeps the exchange. Replaying, it answers each
// request from the recording and keeps what was asked, so a second
// implementation can be held to the same requests (its writes) and handed the
// same answers.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request as the provider saw it, and what it answered. */
export interface Exchange {
  method: string;
  /** Path and query, relative to the base URL the adapter was given. */
  path: string;
  authorization: string | null;
  /** The request headers the provider is held to beyond `authorization`
   *  (those named in the server's `headers` option); absent when none are. */
  headers?: Record<string, string>;
  body: unknown;
  status: number;
  response: string;
}

export type ExchangeRequest = Omit<Exchange, 'status' | 'response'>;

export interface ExchangeServer {
  baseUrl: string;
  /** Every request received, in arrival order. */
  requests(): ExchangeRequest[];
  /** Recording only: every exchange, in arrival order. */
  exchanges(): Exchange[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parsedBody(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Request headers beyond `authorization` that are part of the exchange (a
 *  provider that refuses a request without its version header). */
export interface ExchangeOptions {
  headers?: readonly string[];
}

function requestKey(request: ExchangeRequest): string {
  return JSON.stringify([request.method, request.path, request.authorization, request.headers ?? null, request.body]);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function closer(server: Server): () => Promise<void> {
  return () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function received(req: IncomingMessage, tracked: readonly string[]): Promise<ExchangeRequest> {
  const authorization = req.headers.authorization;
  const headers: Record<string, string> = {};
  for (const name of tracked) {
    const value = req.headers[name.toLowerCase()];
    if (typeof value === 'string') headers[name.toLowerCase()] = value;
  }
  return {
    method: req.method ?? 'GET',
    path: req.url ?? '/',
    authorization: typeof authorization === 'string' ? authorization : null,
    ...(tracked.length > 0 ? { headers } : {}),
    body: parsedBody(await readBody(req)),
  };
}

/** Forward to `upstream` and keep each exchange. */
export async function recordingServer(upstream: string, options: ExchangeOptions = {}): Promise<ExchangeServer> {
  const exchanges: Exchange[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const request = await received(req, options.headers ?? []);
      const headers: Record<string, string> = { accept: 'application/json', ...request.headers };
      if (request.authorization !== null) headers.authorization = request.authorization;
      if (request.body !== null) headers['content-type'] = 'application/json';
      const answer = await fetch(upstream.replace(/\/+$/, '') + request.path, {
        method: request.method,
        headers,
        ...(request.body !== null ? { body: JSON.stringify(request.body) } : {}),
      });
      const response = await answer.text();
      exchanges.push({ ...request, status: answer.status, response });
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(response);
    })();
  });
  const baseUrl = await listen(server);
  return {
    baseUrl,
    requests: () => exchanges.map(({ status: _s, response: _r, ...request }) => request),
    exchanges: () => [...exchanges],
    close: closer(server),
  };
}

/**
 * Answer from `recorded`, matching each request exactly (method, path, auth
 * and body); a request the recording does not have answers 599, so the
 * implementation under test fails where it diverged rather than later.
 */
export async function replayingServer(recorded: readonly Exchange[], options: ExchangeOptions = {}): Promise<ExchangeServer> {
  const answers = new Map<string, Exchange[]>();
  for (const exchange of recorded) {
    const key = requestKey(exchange);
    answers.set(key, [...(answers.get(key) ?? []), exchange]);
  }
  const requests: ExchangeRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const request = await received(req, options.headers ?? []);
      requests.push(request);
      const queue = answers.get(requestKey(request)) ?? [];
      const answer = queue.shift();
      if (answer === undefined) {
        res.writeHead(599, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: `not in the recording: ${request.method} ${request.path}` }));
        return;
      }
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(answer.response);
    })();
  });
  const baseUrl = await listen(server);
  return { baseUrl, requests: () => [...requests], exchanges: () => [], close: closer(server) };
}
