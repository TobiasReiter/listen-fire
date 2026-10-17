// Replaying for a module served as a process. Such a module is built afresh
// for every request, so whatever an instance memoised in process (a
// workspace's attributes, a resolver's names) it reads again: more GETs than
// the recording made, of questions the recording already holds. This server
// answers a repeated read with the recorded answer to the same question; every
// other request must be in the recording exactly as `replayingServer`
// requires. Writes are held to the recording's order.

import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Exchange, ExchangeRequest } from '../../dealroom/__test__/parity/exchange';

function body(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (data += chunk));
    req.on('end', () => {
      if (data === '') return resolve(null);
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(data);
      }
    });
    req.on('error', reject);
  });
}

const keyOf = (request: ExchangeRequest): string => JSON.stringify([request.method, request.path, request.authorization, request.body]);

export async function statelessReplayingServer(recorded: readonly Exchange[]): Promise<{
  baseUrl: string;
  requests(): ExchangeRequest[];
  close(): Promise<void>;
}> {
  const queues = new Map<string, Exchange[]>();
  const lastRead = new Map<string, Exchange>();
  for (const exchange of recorded) queues.set(keyOf(exchange), [...(queues.get(keyOf(exchange)) ?? []), exchange]);
  const requests: ExchangeRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const authorization = req.headers.authorization;
      const request: ExchangeRequest = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        authorization: typeof authorization === 'string' ? authorization : null,
        body: await body(req),
      };
      requests.push(request);
      const key = keyOf(request);
      const answer = queues.get(key)?.shift() ?? (request.method === 'GET' ? lastRead.get(key) : undefined);
      if (answer === undefined) {
        res.writeHead(599, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: `not in the recording: ${request.method} ${request.path}` }));
        return;
      }
      if (request.method === 'GET') lastRead.set(key, answer);
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(answer.response);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests: () => [...requests],
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

/** Requests as parity holds a stateless subject to them: every distinct
 *  question, and every write in order. */
export function statelessView(requests: readonly ExchangeRequest[]): { questions: string[]; writes: ExchangeRequest[] } {
  return {
    questions: [...new Set(requests.map(keyOf))].sort(),
    writes: requests.filter((request) => request.method !== 'GET'),
  };
}
