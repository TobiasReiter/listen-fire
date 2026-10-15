// `lf serve`: the inbound doors and the work queue. A request at
// `/hooks/<external>/<install>` is verified and parsed by its external and
// routed like any event; an external's pushes arrive at
// `/api/public/adapter/<external>/{emit,wake}` (doors.ts); due work — a parked
// run's timer, a queued await wake — is drained on a tick, and at once when a
// wake arrives.
//
// The server listens before the session opens, so the externals the session
// starts are told where to push (LF_HOST_URL).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { receiveAdapterPush } from './doors';
import { drainWork, receiveWebhook, WebhookRefused, type RunOutcome, type Session } from './runs';

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
    for (const o of outcomes) log(`run ${o.runId} ${o.file}:${o.movement} ${o.status}${o.error ? ` — ${o.error}` : ''}`);
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
        for (const o of await drainWork(session, { log })) log(`resumed ${o.runId} ${o.file}:${o.movement} ${o.status}${o.error ? ` — ${o.error}` : ''}`);
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
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (req.method !== 'POST') return json(res, 404, { error: 'not found' });

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
        { onRuns: logRuns, onWake: () => void tick() },
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

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
