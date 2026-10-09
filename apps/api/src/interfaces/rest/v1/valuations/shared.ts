import { randomUUID } from "node:crypto";

import { type Response } from 'express';
import { z } from 'zod';
import { Kysely } from 'kysely';
import { currentPrincipal } from 'principal';

import { getValuationsQb } from '../../../../lib/kysely';
import { requireScope } from '../require_scope';

const VALUATIONS_SCOPE = 'valuations';

/**
 * The CRUD factory drives its queries off a runtime table NAME, so it cannot be
 * typed — which is exactly why this had to be found by running the API rather
 * than by typechecking it. Every table it reaches is valuations-owned.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function valuationsQb(): Kysely<any> {
  return getValuationsQb() as Kysely<any>;
}

/**
 * The tenant this call acts in — valuations' only identity touchpoint, read off
 * the Principal rather than through `Context.user`. `user` is user-SHAPED and
 * throws when there is no user, and an api key or the static single-tenant stub
 * is a machine principal with none (D2): reading it here made every route in
 * this product a 500 in its own standalone deployment.
 */
function teamId(): string {
  return currentPrincipal().teamId;
}

function internalError(res: Response, err: unknown) {
  const traceId = randomUUID();
  console.error(`[valuations-api:${traceId}]`, err);
  return res.status(500).json({
    error: 'internal_error',
    message: 'An internal error occurred.',
    traceId,
  });
}

function fkConflictError(res: Response, err: unknown) {
  if (
    err instanceof Error &&
    'code' in err &&
    (err as { code: string }).code === '23503'
  ) {
    return res.status(409).json({
      error: 'conflict',
      message: 'Cannot delete: record is referenced by other records.',
    });
  }
  return null;
}

const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const uuidParam = z.object({ id: z.string().uuid() });

export {
  VALUATIONS_SCOPE,
  requireScope,
  valuationsQb,
  teamId,
  internalError,
  fkConflictError,
  paginationQuery,
  uuidParam,
};
