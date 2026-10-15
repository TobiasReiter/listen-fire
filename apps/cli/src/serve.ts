// `lf serve`: the inbound door and the work queue. A request at
// `/hooks/<external>/<install>` is verified and parsed by its external and
// routed like any event; due work (a parked run's timer) is drained on a tick.

import { createServer, type Server } from 'node:http';
import { receiveWebhook, resumeRun, WebhookRefused, type Session } from './runs';
import { z } from 'zod';

const ResumePayload = z.object({ runId: z.string() });

export interface Serving {
  server: Server;
  port: number;
  stop(): Promise<void>;
}

export async function serve(session: Session, options: { port: number; tickMs?: number; log?: (line: string) => void }): Promise<Serving> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const match = /^\/hooks\/([^/?]+)(?:\/([^/?]+))?\/?(?:\?.*)?$/.exec(req.url ?? '');
      if (req.method !== 'POST' || match?.[1] === undefined) {
        res.writeHead(404).end();
        return;
      }
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) headers[key] = Array.isArray(value) ? value[0] : value;
      receiveWebhook(session, {
        external: decodeURIComponent(match[1]),
        ...(match[2] !== undefined ? { install: decodeURIComponent(match[2]) } : {}),
        rawBody: Buffer.concat(chunks),
        headers,
      })
        .then((outcomes) => {
          for (const o of outcomes) log(`run ${o.runId} ${o.file}:${o.movement} ${o.status}${o.error ? ` — ${o.error}` : ''}`);
          res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ runs: outcomes }));
        })
        .catch((error: unknown) => {
          const status = error instanceof WebhookRefused ? error.status : 500;
          res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error instanceof Error ? error.message : error) }));
        });
    });
  });

  // The drain: due parked runs resume. One tick at a time, so one lf process
  // never resumes a run twice (the in-process lease).
  let draining = false;
  const tick = async () => {
    if (draining) return;
    draining = true;
    try {
      for (const item of session.state.claimDue(new Date().toISOString())) {
        const payload = ResumePayload.parse(JSON.parse(item.payload));
        const run = session.state.run(payload.runId);
        if (run?.status === 'parked') {
          const outcome = await resumeRun(session, payload.runId);
          log(`resumed ${outcome.runId} ${outcome.file}:${outcome.movement} ${outcome.status}`);
        }
        session.state.finishWork(item.id);
      }
    } finally {
      draining = false;
    }
  };
  const timer = setInterval(() => void tick(), options.tickMs ?? 1000);

  await new Promise<void>((resolve) => server.listen(options.port, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  return {
    server,
    port,
    stop: async () => {
      clearInterval(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
