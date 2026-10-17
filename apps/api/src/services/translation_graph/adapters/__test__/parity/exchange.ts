// A local HTTP server an adapter is pointed at instead of its provider, for
// recorded parity. Recording, it forwards each request to the provider (a
// fake-channels service) and keeps the exchange. Replaying, it answers each
// request from the recording and keeps what was asked, so a second
// implementation can be held to the same requests (its writes) and handed the
// same answers.
//
// A body is kept as JSON when it parses, else as text. A multipart body (a
// Drive upload) is kept as its parts, each with its content type and its own
// body read the same way: the boundary is random per request, so the parts are
// what two implementations must agree on. A body or response that is not
// UTF-8 is kept as base64. A response that is not JSON keeps its content type
// (a file's bytes), and is answered with it again on replay.
//
// A caller may normalize each request before it is kept and matched (a
// message's random MIME boundary, a header stamped with the time): what is
// forwarded upstream is always the request as sent.

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
  /** Set only when the provider answered something other than JSON. */
  responseContentType?: string;
  /** Set only when the response is not UTF-8: `response` is then base64. */
  responseEncoding?: 'base64';
}

export type ExchangeRequest = Pick<Exchange, 'method' | 'path' | 'authorization' | 'headers' | 'body'>;

/** The request half of a recorded exchange. */
export function requestOf(exchange: Exchange): ExchangeRequest {
  return {
    method: exchange.method,
    path: exchange.path,
    authorization: exchange.authorization,
    ...(exchange.headers !== undefined ? { headers: exchange.headers } : {}),
    body: exchange.body,
  };
}

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

/** The bytes as UTF-8 text, or undefined when they are not UTF-8. */
function utf8(bytes: Buffer): string | undefined {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : undefined;
}

function parsedText(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parsedBytes(bytes: Buffer): unknown {
  const text = utf8(bytes);
  return text === undefined ? { base64: bytes.toString('base64') } : parsedText(text);
}

/** A multipart body as its parts, without the boundary. */
function multipartParts(bytes: Buffer, boundary: string): Array<{ contentType: string | null; body: unknown }> {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Array<{ contentType: string | null; body: unknown }> = [];
  let at = bytes.indexOf(delimiter);
  while (at >= 0) {
    const start = at + delimiter.length;
    const next = bytes.indexOf(delimiter, start);
    if (next < 0) break;
    // Between delimiters: CRLF, headers, a blank line, the body, CRLF.
    const part = bytes.subarray(start, next);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const contentType = /^content-type:\s*(.+)$/im.exec(headers)?.[1]?.trim() ?? null;
      const body = part.subarray(headerEnd + 4);
      const trimmed = body.subarray(0, body.length - (body.subarray(-2).toString() === '\r\n' ? 2 : 0));
      parts.push({ contentType, body: parsedBytes(trimmed) });
    }
    at = next;
  }
  return parts;
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

interface Received {
  request: ExchangeRequest;
  /** As sent, for forwarding. */
  raw: Buffer;
  contentType: string | undefined;
}

async function received(req: IncomingMessage, tracked: readonly string[]): Promise<Received> {
  const authorization = req.headers.authorization;
  const headers: Record<string, string> = {};
  for (const name of tracked) {
    const value = req.headers[name.toLowerCase()];
    if (typeof value === 'string') headers[name.toLowerCase()] = value;
  }
  const contentType = req.headers['content-type'];
  const raw = await readBody(req);
  const boundary = contentType !== undefined && /^multipart\//i.test(contentType) ? /boundary="?([^";]+)"?/i.exec(contentType)?.[1] : undefined;
  return {
    request: {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      authorization: typeof authorization === 'string' ? authorization : null,
      ...(tracked.length > 0 ? { headers } : {}),
      body: raw.length === 0 ? null : boundary !== undefined ? { multipart: multipartParts(raw, boundary) } : parsedBytes(raw),
    },
    raw,
    contentType,
  };
}

const isJson = (contentType: string | null): boolean => contentType === null || /json/i.test(contentType);

export interface ExchangeOptions {
  /** Request headers beyond `authorization` that are part of the exchange (a
   *  provider that refuses a request without its version header). */
  headers?: readonly string[];
  /** Applied to each request before it is kept and matched. */
  normalize?: (request: ExchangeRequest) => ExchangeRequest;
}

/** Forward to `upstream` and keep each exchange. */
export async function recordingServer(upstream: string, options: ExchangeOptions = {}): Promise<ExchangeServer> {
  const normalize = options.normalize ?? ((request: ExchangeRequest) => request);
  const exchanges: Exchange[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const { request: sent, raw, contentType } = await received(req, options.headers ?? []);
      const request = normalize(sent);
      const headers: Record<string, string> = { accept: 'application/json', ...sent.headers };
      if (sent.authorization !== null) headers.authorization = sent.authorization;
      if (raw.length > 0) headers['content-type'] = contentType ?? 'application/json';
      const answer = await fetch(upstream.replace(/\/+$/, '') + sent.path, {
        method: sent.method,
        headers,
        ...(raw.length > 0 ? { body: raw } : {}),
      });
      const bytes = Buffer.from(await answer.arrayBuffer());
      const answeredType = answer.headers.get('content-type');
      const text = utf8(bytes);
      exchanges.push({
        ...request,
        status: answer.status,
        response: text ?? bytes.toString('base64'),
        ...(isJson(answeredType) ? {} : { responseContentType: answeredType ?? undefined }),
        ...(text === undefined ? { responseEncoding: 'base64' as const } : {}),
      });
      res.writeHead(answer.status, { 'content-type': isJson(answeredType) ? 'application/json' : (answeredType ?? 'application/octet-stream') });
      res.end(bytes);
    })();
  });
  const baseUrl = await listen(server);
  return {
    baseUrl,
    requests: () => exchanges.map(requestOf),
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
  const normalize = options.normalize ?? ((request: ExchangeRequest) => request);
  const answers = new Map<string, Exchange[]>();
  for (const exchange of recorded) {
    const key = requestKey(exchange);
    answers.set(key, [...(answers.get(key) ?? []), exchange]);
  }
  const requests: ExchangeRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const request = normalize((await received(req, options.headers ?? [])).request);
      requests.push(request);
      const queue = answers.get(requestKey(request)) ?? [];
      const answer = queue.shift();
      if (answer === undefined) {
        res.writeHead(599, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: `not in the recording: ${request.method} ${request.path}` }));
        return;
      }
      res.writeHead(answer.status, { 'content-type': answer.responseContentType ?? 'application/json' });
      res.end(answer.responseEncoding === 'base64' ? Buffer.from(answer.response, 'base64') : answer.response);
    })();
  });
  const baseUrl = await listen(server);
  return { baseUrl, requests: () => [...requests], exchanges: () => [], close: closer(server) };
}
