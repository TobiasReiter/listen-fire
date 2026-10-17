// Express glue for the shared inbound core: the core decides every answer
// (movement-engine/public/inbound); express only sends it.

import type { ErrorRequestHandler, Response } from 'express';
import type { InboundAnswer } from 'movement-engine/public/inbound';

import { PAYLOAD_TOO_LARGE } from 'movement-engine/public/inbound';

export function sendInboundAnswer(res: Response, answer: InboundAnswer): void {
  res.status(answer.status).json(answer.body);
  answer.afterAnswer?.();
}

/** A body over the door's parser limit, answered in the door's JSON shape
 *  rather than express's HTML page; any other parser error carries on. */
export const inboundBodyRefusals: ErrorRequestHandler = (err, _req, res, next) => {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 413) {
    sendInboundAnswer(res, PAYLOAD_TOO_LARGE);
    return;
  }
  next(err);
};
