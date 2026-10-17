// A local HTTP server a chat adapter (Telegram, Slack) is pointed at instead
// of its provider, for recorded parity. Like Dealroom's (dealroom/__test__/
// parity/exchange.ts), but byte-faithful in both directions: chat providers
// take form-encoded and multipart bodies and answer file bytes, so each
// request keeps its content type and its body as sent, and each answer keeps
// its content type and its bytes.
//
// Recording, it forwards each request to the provider (fake-channels) and
// keeps the exchange. Replaying, it answers each request from the recording
// and keeps what was asked, so a second implementation is held to the same
// requests (its writes) and handed the same answers.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request as the provider saw it. */
export interface HttpRequestRecord {
  method: string;
  /** Path and query, relative to the base URL the adapter was given. */
  path: string;
  contentType: string | null;
  authorization: string | null;
  /** JSON when the body parses as JSON, else the text as sent. */
  body: unknown;
}

/** A request and what the provider answered. */
export interface HttpExchange extends HttpRequestRecord {
  status: number;
  responseContentType: string | null;
  /** The answer's bytes, base64. */
  response: string;
}

export interface HttpExchangeServer {
  baseUrl: string;
  requests(): HttpRequestRecord[];
  exchanges(): HttpExchange[];
  close(): Promise<void>;
}

/** What may vary between two runs of the same request and is not part of
 *  what the adapter asked for: a multipart boundary. */
export type BodyNormaliser = (record: HttpRequestRecord) => HttpRequestRecord;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
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

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return typeof value === 'string' ? value : null;
}

async function received(req: IncomingMessage): Promise<{ record: HttpRequestRecord; raw: Buffer }> {
  const raw = await readBody(req);
  return {
    raw,
    record: {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      contentType: header(req, 'content-type'),
      authorization: header(req, 'authorization'),
      body: parsedBody(raw.toString('utf8')),
    },
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function closer(server: Server): () => Promise<void> {
  return () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const identity: BodyNormaliser = (record) => record;

/** Forward to `upstream` and keep each exchange. */
export async function recordingHttpServer(upstream: string, normalise: BodyNormaliser = identity): Promise<HttpExchangeServer> {
  const exchanges: HttpExchange[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const { record, raw } = await received(req);
      const headers: Record<string, string> = {};
      if (record.contentType !== null) headers['content-type'] = record.contentType;
      if (record.authorization !== null) headers.authorization = record.authorization;
      const answer = await fetch(upstream.replace(/\/+$/, '') + record.path, {
        method: record.method,
        headers,
        ...(raw.length > 0 ? { body: raw } : {}),
      });
      const bytes = Buffer.from(await answer.arrayBuffer());
      const responseContentType = answer.headers.get('content-type');
      exchanges.push({ ...normalise(record), status: answer.status, responseContentType, response: bytes.toString('base64') });
      res.writeHead(answer.status, responseContentType !== null ? { 'content-type': responseContentType } : {});
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

export function requestOf(exchange: HttpExchange): HttpRequestRecord {
  const { status: _s, responseContentType: _c, response: _r, ...request } = exchange;
  return request;
}

function requestKey(request: HttpRequestRecord): string {
  return JSON.stringify([request.method, request.path, request.contentType, request.authorization, request.body]);
}

/**
 * Answer from `recorded`, matching each request exactly (method, path,
 * content type, auth and body, after `normalise`), each recorded answer once;
 * a request the recording does not have answers 599, so the implementation under test fails where it
 * diverged rather than later.
 */
export async function replayingHttpServer(
  recorded: readonly HttpExchange[],
  options: {
    normalise?: BodyNormaliser;
    /** Answer a request asked more often than recorded with its last
     *  recorded answer, for a transport whose client repeats a read (it is
     *  still kept among `requests()`, so a test says which repeats it allows). */
    repeatReads?: boolean;
  } = {},
): Promise<HttpExchangeServer> {
  const normalise = options.normalise ?? identity;
  const last = new Map<string, HttpExchange>();
  const answers = new Map<string, HttpExchange[]>();
  for (const exchange of recorded) {
    const key = requestKey(requestOf(exchange));
    answers.set(key, [...(answers.get(key) ?? []), exchange]);
    last.set(key, exchange);
  }
  const requests: HttpRequestRecord[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const record = normalise((await received(req)).record);
      requests.push(record);
      const key = requestKey(record);
      const answer = (answers.get(key) ?? []).shift() ?? (options.repeatReads === true ? last.get(key) : undefined);
      if (answer === undefined) {
        if (process.env.PARITY_DEBUG === '1') console.error('not in the recording', JSON.stringify(record));
        res.writeHead(599, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, description: `not in the recording: ${record.method} ${record.path}` }));
        return;
      }
      res.writeHead(answer.status, answer.responseContentType !== null ? { 'content-type': answer.responseContentType } : {});
      res.end(Buffer.from(answer.response, 'base64'));
    })();
  });
  const baseUrl = await listen(server);
  return { baseUrl, requests: () => [...requests], exchanges: () => [], close: closer(server) };
}
