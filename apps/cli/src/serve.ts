// `lf serve`: the inbound doors and the work queue. The inbound doors are the
// engine's inbound core (doors.ts): a provider's delivery at
// `/api/public/webhook-sync/<provider>/<install>` is verified and parsed by its
// external and its events queued, `/hooks/<external>/<install>` being lf's
// older name for the same door; an external's pushes arrive at
// `/api/public/adapter/<external>/{emit,wake}` and are queued; a
// callback's call arrives at `/api/cb/<id>` (its url) and runs its body;
// due work — an emitted event, a parked run's timer, a queued await wake — is
// drained on a tick, and at once when a push queues some.
//
// The server listens before the session opens, so the externals the session
// starts are told where to push (LF_HOST_URL).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { answerDelivery, answerEmit, answerWake, PAYLOAD_TOO_LARGE, type InboundAnswer } from 'movement-engine/public/inbound';
import { createLfInboundStores, deliverInline, hookTarget, type LfInboundOptions, type LfInboundStores } from './doors';
import { callCallback, drainWork, type CallOutcome, type RunOutcome, type Session } from './runs';

/** The largest body a door reads; a larger batch is split by its sender. */
const MAX_BODY_BYTES = 1024 * 1024;

/** The webhook door's own limit, the hosted door's: a delivery is a
 *  notification, and a provider's bigger one carries ids to pull. */
const MAX_DELIVERY_BYTES = 100 * 1024;

export interface Serving {
  server: Server;
  port: number;
  session: Session;
  stop(): Promise<void>;
}

export async function serve(
  open: (hostUrl: string) => Promise<Session>,
  options: {
    port: number;
    tickMs?: number;
    log?: (line: string) => void;
    /** How the inbound doors read deliveries and wrap their stores (the
     *  inbound contract suite instruments them). */
    inbound?: Pick<LfInboundOptions, 'adapterOf'> & {
      decorate?(stores: LfInboundStores): LfInboundStores;
      /** Called whenever an inbound door pokes the drain. */
      onNotify?(): void;
    };
  },
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

  const pokeDrain = () => {
    options.inbound?.onNotify?.();
    void tick();
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

    const push = /^\/api\/public\/adapter\/([^/]+)\/(emit|wake)\/?$/.exec(path);
    if (push?.[1] !== undefined && (push[2] === 'emit' || push[2] === 'wake')) {
      let body: unknown;
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        body = undefined;
      }
      const request = { adapterType: decodeURIComponent(push[1]), headers, body };
      const stores = inboundStores(session);
      return send(res, await (push[2] === 'emit' ? answerEmit(stores.push, request) : answerWake(stores.push, request)));
    }

    const delivery = /^\/api\/public\/webhook-sync\/([^/]+)\/([^/]+)\/?$/.exec(path);
    if (delivery?.[1] !== undefined && delivery[2] !== undefined) {
      if (rawBody.length > MAX_DELIVERY_BYTES) return send(res, PAYLOAD_TOO_LARGE);
      return send(
        res,
        await answerDelivery(
          inboundStores(session).store,
          { notify: pokeDrain },
          { provider: decodeURIComponent(delivery[1]), subscriptionId: decodeURIComponent(delivery[2]), rawBody, headers },
        ),
      );
    }

    // lf's older name for the delivery door. Its events run inside the
    // request and the answer lists the runs, as it always has.
    const hook = /^\/hooks\/([^/]+)(?:\/([^/]+))?\/?$/.exec(path);
    if (hook?.[1] === undefined) return json(res, 404, { error: 'not found' });
    const target = hookTarget(session, {
      external: decodeURIComponent(hook[1]),
      ...(hook[2] !== undefined ? { install: decodeURIComponent(hook[2]) } : {}),
    });
    if (target === null) return json(res, 404, { error: 'unknown_provider' });
    const { answer, outcomes } = await deliverInline(session, { ...target, rawBody, headers }, inboundOptions);
    logRuns(outcomes);
    if (answer.status !== 200) return send(res, answer);
    json(res, 202, { runs: outcomes });
    // A delivery may have queued wakes.
    void tick();
  };

  const inboundOptions: Pick<LfInboundOptions, 'notify' | 'adapterOf'> = {
    notify: pokeDrain,
    ...(options.inbound?.adapterOf !== undefined ? { adapterOf: options.inbound.adapterOf } : {}),
  };
  const inboundStores = (session: Session): LfInboundStores => {
    const stores = createLfInboundStores(session, inboundOptions);
    return options.inbound?.decorate?.(stores) ?? stores;
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

function send(res: ServerResponse, answer: InboundAnswer): void {
  json(res, answer.status, answer.body);
  answer.afterAnswer?.();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
