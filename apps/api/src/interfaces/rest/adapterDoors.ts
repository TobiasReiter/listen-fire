// The push doors a remote adapter calls (services/webhook_sync/adapter_doors.ts):
//
//   POST /api/public/adapter/:adapterType/emit  { events: WireDiscriminableEvent[] }
//   POST /api/public/adapter/:adapterType/wake  { keys: string[] }
//
// Both answer 202 `{ accepted }` once the work rows are queued; 401 (no detail)
// when the presented credential matches no install — whether or not anyone
// installed the type, so the door says nothing about who did, and always for a
// type whose slug a built-in answers to; 409 when it matches installs on
// several teams and no `x-listen-fire-team` names one; 400 for a malformed
// body; 413 for a body over 1 MB.

import express, { Router } from 'express';
import { z } from 'zod';
import { AdapterEmitBody as EmitBody, AdapterWakeBody as WakeBody } from 'engine-contracts';

import type { Request, Response } from 'express';

import { MB } from '../../constants';
import {
  authenticateAdapterDoor,
  emitAdapterEvents,
  wakeAdapterKeys,
  type AdapterDoorCaller,
} from '../../services/webhook_sync/adapter_doors';
import { ADAPTER_TEAM_HEADER } from 'movement-engine/services/translation_graph/protocol/client';
import { neverAsAny } from 'movement-engine/lib/utils/types';
import { logger } from 'movement-engine/services/logger';

const adapterDoorsRouter: ReturnType<typeof Router> = Router();

// The doors are self-authorising (the presented credential is the auth), so they
// mount before the app's JSON parser and bring their own. A body over the limit
// is refused 413 before anything is authenticated or read; a batch that large
// is split by its sender.
adapterDoorsRouter.use(express.json({ type: 'application/json', limit: MB }));

/** Authenticate, or answer the refusal. */
async function callerOf(req: Request, res: Response): Promise<AdapterDoorCaller | null> {
  const auth = await authenticateAdapterDoor({
    adapterType: req.params.adapterType,
    headers: req.headers,
  });
  switch (auth.kind) {
    case 'authenticated':
      return auth.caller;
    case 'unauthorized':
      res.status(401).json({ error: 'unauthorized' });
      return null;
    case 'ambiguous':
      res.status(409).json({
        error: 'ambiguous_credential',
        message: `this credential belongs to more than one team's install; name the team in the ${ADAPTER_TEAM_HEADER} header`,
      });
      return null;
    default:
      return neverAsAny(auth);
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
    const { accepted, failed } = await emitAdapterEvents({ caller, events: body.data.events });
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
