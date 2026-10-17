// `lf serve`: the inbound doors and the work queue. A request at
// `/hooks/<external>/<install>` is verified and parsed by its external and
// routed like any event; an external's pushes arrive at
// `/api/public/adapter/<external>/{emit,wake}` (doors.ts) and are queued; a
// callback's call arrives at `/api/cb/<id>` (its url) and runs its body;
// due work — an emitted event, a parked run's timer, a queued await wake — is
// drained on a tick, and at once when a push queues some.
//
// The server listens before the session opens, so the externals the session
// starts are told where to push (LF_HOST_URL).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { receiveAdapterPush } from './doors';
import { callCallback, drainWork, receiveWebhook, WebhookRefused, type CallOutcome, type RunOutcome, type Session } from './runs';

/** The largest body a door reads; a larger batch is split by its sender. */
const MAX_BODY_BYTES = 1024 * 1024;

export interface Serving {
  server: Server;
  port: number;
  session: Session;
  stop(): Promise<void>;
}

export async function serve(
  open: (hostUrl: string) => Promise<Session>,
  options: { port: number; tickMs?: number; log?: (line: string) => void },
): Promise<Serving> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const logRuns = (outcomes: RunOutcome[]) => {
    for (const o of outcomes) {
      log(`${o.entry === 'fired' ? 'run' : o.entry} ${o.runId} ${o.file}:${o.movement} ${o.status}${o.error ? ` — ${o.error}` : ''}`);
    }
  };
  let session: Session | undefined;

  // The drain: one pass at a time in this process; the run lease keeps any
  // other lf process from stepping the same run meanwhile. A pass asked for
  // while one runs is run once after it.
  let draining = false;
  let again = false;
  const tick = async (): Promise<void> => {
    if (session === undefined) return;
    if (draining) {
      again = true;
      return;
    }
    draining = true;
    try {
      do {
        again = false;
        logRuns(await drainWork(session, { log }));
      } while (again);
    } catch (error) {
      log(`drain failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      draining = false;
    }
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return json(res, 413, { error: 'payload_too_large' });
      if (session === undefined) return json(res, 503, { error: 'starting' });
      void route(session, req, Buffer.concat(chunks), res).catch((error: unknown) => {
        json(res, 500, { error: String(error instanceof Error ? error.message : error) });
      });
    });
  });

  const route = async (session: Session, req: IncomingMessage, rawBody: Buffer, res: ServerResponse): Promise<void> => {
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) headers[key] = Array.isArray(value) ? value[0] : value;
    const [path = '', query = ''] = (req.url ?? '').split('?');
    if (req.method !== 'POST') return json(res, 404, { error: 'not found' });

    const callback = /^\/api\/cb\/([^/]+)\/?$/.exec(path);
    if (callback?.[1] !== undefined) {
      const values = callValues(rawBody, query);
      if (values === null) return json(res, 400, { outcome: 'mismatch', message: 'the body is not a JSON object of values' });
      const called = await callCallback(session, { id: decodeURIComponent(callback[1]), values });
      logRuns(called.outcomes);
      const answer = callAnswer(called);
      json(res, answer.status, { outcome: called.call.kind, message: answer.message });
      // A queued body, and the wake backstop, are drained work.
      void tick();
      return;
    }

    const door = /^\/api\/public\/adapter\/([^/]+)\/(emit|wake)\/?$/.exec(path);
    if (door?.[1] !== undefined && (door[2] === 'emit' || door[2] === 'wake')) {
      let body: unknown;
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        body = undefined;
      }
      const answer = await receiveAdapterPush(
        session,
        { external: decodeURIComponent(door[1]), door: door[2], headers, body },
        { onQueued: () => void tick() },
      );
      return json(res, answer.status, answer.body);
    }

    const hook = /^\/hooks\/([^/]+)(?:\/([^/]+))?\/?$/.exec(path);
    if (hook?.[1] === undefined) return json(res, 404, { error: 'not found' });
    try {
      const outcomes = await receiveWebhook(session, {
        external: decodeURIComponent(hook[1]),
        ...(hook[2] !== undefined ? { install: decodeURIComponent(hook[2]) } : {}),
        rawBody,
        headers,
      });
      logRuns(outcomes);
      json(res, 202, { runs: outcomes });
      // A delivery may have queued wakes.
      void tick();
    } catch (error) {
      const status = error instanceof WebhookRefused ? error.status : 500;
      json(res, status, { error: String(error instanceof Error ? error.message : error) });
    }
  };

  await new Promise<void>((resolve) => server.listen(options.port, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    session = await open(`http://127.0.0.1:${port}`);
  } catch (error) {
    await close();
    throw error;
  }
  const timer = setInterval(() => void tick(), options.tickMs ?? 1000);
  void tick();
  return {
    server,
    port,
    session,
    stop: async () => {
      clearInterval(timer);
      await close();
    },
  };
}

/** A call's values: the JSON body's keys over the query string's, every key
 *  passed raw (the callback's signature validates them). Null when the body
 *  is not a JSON object. */
function callValues(rawBody: Buffer, query: string): Record<string, unknown> | null {
  const values: Record<string, unknown> = Object.fromEntries(new URLSearchParams(query));
  if (rawBody.length === 0) return values;
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  return { ...values, ...body };
}

/** The door's answer, as the hosted door gives it. */
function callAnswer({ call, queued }: CallOutcome): { status: number; message: string } {
  switch (call.kind) {
    case 'recorded':
      return { status: queued ? 202 : 200, message: 'recorded; the run is carrying on' };
    case 'not_found':
      return { status: 404, message: 'no such callback' };
    case 'closed':
      return { status: 410, message: 'this callback is closed: it was already used, or its run has finished' };
    case 'expired':
      return { status: 410, message: 'this callback has expired' };
    case 'mismatch':
      return { status: 400, message: call.message };
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
