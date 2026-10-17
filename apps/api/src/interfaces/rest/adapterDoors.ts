// The push doors a remote adapter calls — the shared inbound core's
// `answerEmit` / `answerWake` over the platform's store
// (services/webhook_sync/adapter_doors.ts):
//
//   POST /api/public/adapter/:adapterType/emit    { events: WireDiscriminableEvent[] }
//   POST /api/public/adapter/:adapterType/wake    { keys: string[] }
//   POST /api/public/adapter/:adapterType/models  HostModelRequest → HostModelAnswer
//
// The models door is how a module served as a process asks the platform for
// a model call (module kit `hostModels`; serve-module reads LF_HOST_URL and
// LF_HOST_TOKEN, so it reaches an install whose secret is sent as a bearer
// token). It answers 200 with the text and its cost, 400 for a request the
// models refuse, 502 when the call fails.
//
// Both answer 202 `{ accepted }` once the work rows are queued; 401 (no detail)
// when the presented credential matches no install — whether or not anyone
// installed the type, so the door says nothing about who did, and always for a
// type whose slug a built-in answers to; 409 when it matches installs on
// several teams and no `x-listen-fire-team` names one; 400 for a malformed
// body; 413 for a body over 1 MB.

import express, { Router } from 'express';

import type { Request, Response } from 'express';

import { MB } from '../../constants';
import { answerEmit, answerModels, answerWake, type HostModelCall, type PushStore } from 'movement-engine/public/inbound';
import { platformPushStore } from '../../services/webhook_sync/adapter_doors';
import { platformModelCall } from '../../services/webhook_sync/models_door';
import { inboundBodyRefusals, sendInboundAnswer } from './inbound_answer';

/** The doors over any store: the platform's below, an in-memory one in the
 *  inbound contract suite. The models door is mounted only for a host that
 *  answers it (`models`). */
export function createAdapterDoorsRouter<Captured>(store: PushStore<Captured>, models?: HostModelCall): ReturnType<typeof Router> {
  const router: ReturnType<typeof Router> = Router();
  // The doors are self-authorising (the presented credential is the auth), so
  // they mount before the app's JSON parser and bring their own. A body over the
  // limit is refused 413 before anything is authenticated or read; a batch that
  // large is split by its sender.
  router.use(express.json({ type: 'application/json', limit: MB }));
  router.post('/:adapterType/emit', async (req: Request, res: Response) => {
    sendInboundAnswer(res, await answerEmit(store, { adapterType: req.params.adapterType, headers: req.headers, body: req.body }));
  });
  router.post('/:adapterType/wake', async (req: Request, res: Response) => {
    sendInboundAnswer(res, await answerWake(store, { adapterType: req.params.adapterType, headers: req.headers, body: req.body }));
  });
  if (models !== undefined) {
    router.post('/:adapterType/models', async (req: Request, res: Response) => {
      sendInboundAnswer(res, await answerModels(store, { adapterType: req.params.adapterType, headers: req.headers, body: req.body }, models));
    });
  }
  router.use(inboundBodyRefusals);
  return router;
}

const adapterDoorsRouter: ReturnType<typeof Router> = createAdapterDoorsRouter(platformPushStore, platformModelCall);

export { adapterDoorsRouter };
