// Wire protocol client — the dependency-light RPC layer the Phase 4
// `RemoteAdapter` forwards every method through. Uses the global `fetch`.
//
// Transport faults (non-2xx) raise a retryable `RemoteTransportError`;
// application-level failures (`ok:false`) raise a typed `RemoteProtocolError`
// carrying the server's structured error. Both `ok:true` and `ok:false` arrive
// as HTTP 200 — see `3_model.md` "Envelope".

import { z } from 'zod';
import { PROTOCOL_VERSION, RpcResponse } from 'engine-contracts';
import { reportRunCost } from '../../../lib/run_spend';

import type { RpcErrorShape, WireCredentialShape, WireCredentialUpdateShape } from 'engine-contracts';

/**
 * The header naming a team, both ways: the host sends it on every call to a
 * remote adapter, so a vendor serving several teams learns which install is
 * calling, and a vendor names its team in it at the push doors when one
 * credential is shared by several teams' installs.
 */
export const ADAPTER_TEAM_HEADER = 'x-listen-fire-team';

/**
 * A protocol response that didn't match the schema for its method — the
 * adapter returned the wrong shape (e.g. a bare array where an object was
 * expected, or a missing `{ ok, result }` envelope). Carries the method and
 * adapter so the author sees *what* they returned and *what was expected*,
 * instead of a naked Zod dump. Not retryable — the shape won't fix itself.
 */
export class RemoteResponseShapeError extends Error {
  constructor(
    readonly method: string,
    readonly adapter: string,
    readonly received: unknown,
    readonly zodError: z.ZodError,
  ) {
    super(
      `Remote adapter "${adapter}" returned an unexpected shape from "${method}": ` +
        `${describeReceived(received)}. ${describeZodError(zodError)}`,
    );
    this.name = 'RemoteResponseShapeError';
  }
}

function describeReceived(value: unknown): string {
  if (Array.isArray(value)) {
    return `received an array (${value.length} item${value.length === 1 ? '' : 's'})`;
  }
  if (value === null) return 'received null';
  if (typeof value === 'object') {
    return `received an object with keys [${Object.keys(value).join(', ')}]`;
  }
  return `received ${typeof value}`;
}

function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'the shape did not match the protocol schema';
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `${issue.message} at ${path}`;
}

/**
 * Validate a protocol value against its schema, raising a method-scoped
 * `RemoteResponseShapeError` on mismatch. Used for both the response envelope
 * and each method's result, so a non-conformant adapter fails with an
 * actionable message rather than a bare "expected object, received array".
 */
export function parseWireResult<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  context: { method: string; adapter: string },
): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new RemoteResponseShapeError(context.method, context.adapter, raw, parsed.error);
  }
  return parsed.data;
}

export class RemoteTransportError extends Error {
  readonly retryable = true;
  constructor(
    readonly status: number,
    readonly method: string,
  ) {
    super(`Remote adapter transport error (HTTP ${status}) for method "${method}"`);
    this.name = 'RemoteTransportError';
  }
}

export class RemoteProtocolError extends Error {
  constructor(
    readonly error: RpcErrorShape,
    readonly method: string,
  ) {
    super(`Remote adapter error for method "${method}": ${error.code} — ${error.message}`);
    this.name = 'RemoteProtocolError';
  }
}

export type AuthStrategy = { kind: 'bearer' } | { kind: 'shared_secret'; header?: string };

const DEFAULT_SHARED_SECRET_HEADER = 'x-listen-fire-adapter-secret';

export function authHeader(strategy: AuthStrategy, secret: string): Record<string, string> {
  switch (strategy.kind) {
    case 'bearer':
      return { Authorization: `Bearer ${secret}` };
    case 'shared_secret':
      return { [strategy.header ?? DEFAULT_SHARED_SECRET_HEADER]: secret };
  }
}

export async function postRpc(opts: {
  baseUrl: string;
  auth: Record<string, string>;
  /** The team whose install is calling, sent as `x-listen-fire-team`: the
   *  host's own tenant identifier, opaque here. */
  teamId: string;
  method: string;
  cacheScopeId: string;
  params: unknown;
  /** The install's credential, for a module that declares it. */
  credential?: WireCredentialShape;
  /** Called with the response's `credentialUpdate`, on a failed response
   *  too, before the result is returned or the failure thrown: a rotated
   *  refresh token must be stored either way. */
  onCredentialUpdate?: (update: WireCredentialUpdateShape) => Promise<void>;
  /** Called with the response's `retryAfter` (seconds), on a failed
   *  response too: the provider asked for no call for that long. */
  onThrottle?: (retryAfterSeconds: number) => Promise<void>;
}): Promise<unknown> {
  const res = await fetch(opts.baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [ADAPTER_TEAM_HEADER]: opts.teamId, ...opts.auth },
    body: JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      method: opts.method,
      cacheScopeId: opts.cacheScopeId,
      params: opts.params,
      ...(opts.credential !== undefined ? { credential: opts.credential } : {}),
    }),
  });

  if (!res.ok) throw new RemoteTransportError(res.status, opts.method);

  // Parsed here rather than by `res.json()`: its objects are made by fetch's
  // own realm, and a caller that tells a file descriptor by its prototype
  // (`fileDescriptorOf`) must see this realm's plain objects (a jest VM is
  // another realm than Node's fetch).
  const body = parseWireResult(RpcResponse, JSON.parse(await res.text()), {
    method: opts.method,
    adapter: opts.baseUrl,
  });
  if (body.credentialUpdate !== undefined && opts.onCredentialUpdate !== undefined) {
    await opts.onCredentialUpdate(body.credentialUpdate);
  }
  if (body.retryAfter !== undefined && opts.onThrottle !== undefined) await opts.onThrottle(body.retryAfter);
  // What the module spent on paid services is the run's, whether or not the
  // call then failed: charged to the call being served, so the run's cost
  // cap counts it.
  for (const line of body.cost ?? []) reportRunCost({ source: { kind: 'adapter', name: line.label }, microdollars: line.microdollars });
  if (!body.ok) throw new RemoteProtocolError(body.error, opts.method);
  return body.result;
}
