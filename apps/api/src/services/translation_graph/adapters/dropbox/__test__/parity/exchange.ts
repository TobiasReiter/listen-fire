// A local HTTP server an adapter is pointed at instead of Dropbox, for
// recorded parity. Recording, it forwards each request to the provider (the
// fake-channels Dropbox) and keeps the exchange. Replaying, it answers each
// request from the recording and keeps what was asked, so a second
// implementation can be held to the same requests (its writes) and handed the
// same answers. Bodies are bytes (an upload is raw), kept as base64.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request as the provider saw it, and what it answered. */
export interface Exchange {
  method: string;
  /** Path and query, relative to the base URL the adapter was given. */
  path: string;
  authorization: string | null;
  /** The `Dropbox-API-Arg` header an upload or download carries. */
  apiArg: string | null;
  contentType: string | null;
  /** The request body, base64. */
  body: string;
  status: number;
  responseContentType: string | null;
  /** The response body, base64. */
  response: string;
}

export type ExchangeRequest = Omit<Exchange, 'status' | 'response' | 'responseContentType'>;

export interface ExchangeServer {
  baseUrl: string;
  /** Every request received, in arrival order. */
  requests(): ExchangeRequest[];
  /** Recording only: every exchange, in arrival order. */
  exchanges(): Exchange[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return typeof value === 'string' ? value : null;
}

function requestKey(request: ExchangeRequest): string {
  return JSON.stringify([request.method, request.path, request.authorization, request.apiArg, request.contentType, request.body]);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function closer(server: Server): () => Promise<void> {
  return () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function received(req: IncomingMessage): Promise<ExchangeRequest> {
  return {
    method: req.method ?? 'GET',
    path: req.url ?? '/',
    authorization: header(req, 'authorization'),
    apiArg: header(req, 'dropbox-api-arg'),
    contentType: header(req, 'content-type'),
    body: (await readBody(req)).toString('base64'),
  };
}

/** Forward to `upstream` and keep each exchange. */
export async function recordingServer(upstream: string): Promise<ExchangeServer> {
  const exchanges: Exchange[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const request = await received(req);
      const headers: Record<string, string> = {};
      if (request.authorization !== null) headers.authorization = request.authorization;
      if (request.apiArg !== null) headers['dropbox-api-arg'] = request.apiArg;
      if (request.contentType !== null) headers['content-type'] = request.contentType;
      const body = Buffer.from(request.body, 'base64');
      const answer = await fetch(upstream.replace(/\/+$/, '') + request.path, {
        method: request.method,
        headers,
        ...(body.length > 0 ? { body } : {}),
      });
      const response = Buffer.from(await answer.arrayBuffer());
      const responseContentType = answer.headers.get('content-type');
      exchanges.push({ ...request, status: answer.status, responseContentType, response: response.toString('base64') });
      res.writeHead(answer.status, responseContentType !== null ? { 'content-type': responseContentType } : {});
      res.end(response);
    })();
  });
  const baseUrl = await listen(server);
  return {
    baseUrl,
    requests: () => exchanges.map(({ status: _s, response: _r, responseContentType: _c, ...request }) => request),
    exchanges: () => [...exchanges],
    close: closer(server),
  };
}

/**
 * Answer from `recorded`, matching each request exactly (method, path, auth,
 * the API argument and the body); a request the recording does not have
 * answers 599, so the implementation under test fails where it diverged
 * rather than later.
 */
export async function replayingServer(recorded: readonly Exchange[]): Promise<ExchangeServer> {
  const answers = new Map<string, Exchange[]>();
  for (const exchange of recorded) {
    const key = requestKey(exchange);
    answers.set(key, [...(answers.get(key) ?? []), exchange]);
  }
  const requests: ExchangeRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const request = await received(req);
      requests.push(request);
      const answer = (answers.get(requestKey(request)) ?? []).shift();
      if (answer === undefined) {
        res.writeHead(599, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: `not in the recording: ${request.method} ${request.path}` }));
        return;
      }
      res.writeHead(answer.status, answer.responseContentType !== null ? { 'content-type': answer.responseContentType } : {});
      res.end(Buffer.from(answer.response, 'base64'));
    })();
  });
  const baseUrl = await listen(server);
  return { baseUrl, requests: () => [...requests], exchanges: () => [], close: closer(server) };
}
