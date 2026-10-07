// The push doors a remote adapter calls (services/webhook_sync/adapter_doors.ts):
//
//   POST /api/public/adapter/:adapterType/emit  { events: WireDiscriminableEvent[] }
//   POST /api/public/adapter/:adapterType/wake  { keys: string[] }
//
// Both answer 202 `{ accepted }` once the work rows are queued. 404 when no team
// has installed the adapter type, 401 (no detail) when the presented credential
// matches none of its installs, 400 for a malformed body.

import express, { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { MB } from '../../constants';
import { WireDiscriminableEvent } from '../../services/translation_graph/protocol/schema';
import {
  authenticateAdapterDoor,
  emitAdapterEvents,
  wakeAdapterKeys,
  type AdapterDoorCaller,
} from '../../services/webhook_sync/adapter_doors';
import { logger } from '../../services/logger';

const MAX_BATCH = 1000;

const EmitBody = z.object({ events: z.array(WireDiscriminableEvent).min(1).max(MAX_BATCH) });
const WakeBody = z.object({ keys: z.array(z.string().min(1)).min(1).max(MAX_BATCH) });

const adapterDoorsRouter: ReturnType<typeof Router> = Router();

// The doors are self-authorising (the presented credential is the auth), so they
// mount before the app's JSON parser and bring their own.
adapterDoorsRouter.use(express.json({ type: 'application/json', limit: 25 * MB }));

/** Authenticate, or answer the refusal. */
async function callerOf(req: Request, res: Response): Promise<AdapterDoorCaller | null> {
  const auth = await authenticateAdapterDoor({
    adapterType: req.params.adapterType,
    headers: req.headers,
  });
  switch (auth.kind) {
    case 'authenticated':
      return auth.caller;
    case 'unknown_adapter':
      res.status(404).json({ error: 'unknown_adapter' });
      return null;
    case 'unauthorized':
      res.status(401).json({ error: 'unauthorized' });
      return null;
  }
}

function badRequest(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: 'bad_request',
    issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  });
}

adapterDoorsRouter.post('/:adapterType/emit', async (req: Request, res: Response) => {
  try {
    const body = EmitBody.safeParse(req.body);
    // Authenticate before judging the body, so an unauthenticated caller learns
    // nothing about the shape the door wants.
    const caller = await callerOf(req, res);
    if (!caller) return;
    if (!body.success) {
      badRequest(res, body.error);
      return;
    }
    // zod reads `payload: unknown` as optional; an event always has one.
    const events = body.data.events.map((event) => ({ ...event, payload: event.payload }));
    const { accepted, failed } = await emitAdapterEvents({ caller, events });
    if (failed > 0) {
      res.status(500).json({ error: 'capture_failed', accepted, failed });
      return;
    }
    res.status(202).json({ accepted });
  } catch (err) {
    logger.error('[AdapterDoors] emit failed', { err });
    res.status(500).json({ error: 'internal' });
  }
});

adapterDoorsRouter.post('/:adapterType/wake', async (req: Request, res: Response) => {
  try {
    const body = WakeBody.safeParse(req.body);
    const caller = await callerOf(req, res);
    if (!caller) return;
    if (!body.success) {
      badRequest(res, body.error);
      return;
    }
    res.status(202).json(await wakeAdapterKeys({ caller, keys: body.data.keys }));
  } catch (err) {
    logger.error('[AdapterDoors] wake failed', { err });
    res.status(500).json({ error: 'internal' });
  }
});

export { adapterDoorsRouter };
