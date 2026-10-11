// Wire protocol server — the counterpart to `client.ts`. Turns ANY in-process
// `Adapter` into a Node `http` request handler that speaks the remote-adapter
// protocol, so a `RemoteAdapter` (driving it over real HTTP) behaves
// identically to driving the adapter in-process.
//
// Symmetry with the client (`client.ts`):
//   • Both `ok:true` and `ok:false` are HTTP 200 — application-level errors
//     ride inside the envelope (see `3_model.md` "Envelope"). The client's
//     `postRpc` only raises a `RemoteTransportError` on non-2xx, so we reserve
//     non-2xx for genuine transport faults (malformed body, auth) and use the
//     `{ok:false}` envelope for every dispatch-level failure.
//   • Auth failure → HTTP 401, matching the client's `RemoteTransportError`
//     (non-retryable status the engine surfaces as an evaluation error).
//
// Every request is checked before dispatch: a protocol version other than
// `PROTOCOL_VERSION` answers `protocol_version`, and params that don't match
// the method's `METHODS` schema answer `bad_request` naming the method and the
// offending path. Both are in-envelope (HTTP 200), non-retryable.
//
// Paged methods (`iterateRelatedPage`, and its v1 spelling `iterateRelated`)
// answer `{ items, nextCursor }`. An adapter that pages natively
// (`Adapter.iterateRelatedPage`) is paged through as-is: its cursor rides the
// wire opaque and comes back on the next call. An adapter with only a stream
// (`Adapter.iterateRelated`) is drained into one page, capped at
// `DRAINED_PAGE_LIMIT` items — past that the page is cut short with no
// `nextCursor` and a warning names the adapter and method, because a stream
// has no cursor to resume from.
//
// `resolveFileRef` answers by URL: bytes never ride the envelope, so a file
// crosses the wire only when its ref carries a fetchable `url` (the client
// fetches it). A ref without one answers `method_not_implemented`.
//
// Dependency-light by design: Node `http` types only, no express.

import { fileValueOf, MANIFEST_PROTOCOL_VERSION, METHODS, PROTOCOL_VERSION, RpcRequest } from 'engine-contracts';

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import type { Adapter } from '../adapter';
import type { MethodName, RpcResponseShape } from 'engine-contracts';

/**
 * Protocol method names that exist purely as server-side concepts (no
 * matching `Adapter` member): `manifest` is synthesised from the adapter's
 * readonly props. Everything else in `METHODS` maps to an `Adapter` member
 * (see `adapterMember`).
 */
const MANIFEST_METHOD = 'manifest' satisfies MethodName;

/** Methods the protocol delivers as paged `{ items, nextCursor }` (see file
 *  header). */
const PAGED_METHODS = new Set<MethodName>(['iterateRelated', 'iterateRelatedPage']);

/**
 * The most items one page carries when the adapter can only stream: a stream
 * has no cursor to resume from, so everything past this is dropped (loudly).
 * An adapter that needs more implements `iterateRelatedPage`.
 */
export const DRAINED_PAGE_LIMIT = 1_000;

/**
 * Thrown by an adapter served through this kit when the REQUEST is wrong in a
 * way the schema cannot see — a cursor it never minted, an id of the wrong
 * shape. Answers `bad_request` (not retryable) instead of the `adapter_error`
 * (retryable) every other throw becomes: asking again with the same input
 * cannot succeed.
 */
export class AdapterBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterBadRequestError';
  }
}

/**
 * A few `Adapter` members take a single POSITIONAL argument rather than an
 * options object, while the wire protocol uniformly wraps params in an object
 * (`describe` → `{ typeId }`). For these the server unwraps the named field
 * before applying the call so the in-process method sees its native
 * positional argument. Every other method takes the wire params object
 * directly.
 */
const POSITIONAL_PARAM_FIELDS: Partial<Record<MethodName, readonly string[]>> = {
  describe: ['typeId'],
  edgesFrom: ['position', 'cursor'],
};

/**
 * Map a method's wire params into the argument LIST the in-process `Adapter`
 * member expects — unwrapping the named fields in order for positional-arg
 * methods, otherwise forwarding the params object verbatim as a single
 * argument. Ordered rather than single-valued: a positional method may take
 * more than one argument, and plucking just the first would silently drop the
 * rest at the in-process bridge (the failure mode when `describe` grows a
 * position — see plans/2026-07-10-adapter-entry-positions/3_edges_from.md).
 */
function callArgs(method: MethodName, params: unknown): unknown[] {
  const fields = POSITIONAL_PARAM_FIELDS[method];
  if (fields && params !== null && typeof params === 'object') {
    return fields.map((field) => Reflect.get(params, field));
  }
  return [params];
}

/**
 * The in-process member a protocol method dispatches to, as (receiver, member
 * name). Most methods are the adapter member of the same name; the exceptions
 * are the ones whose in-process home differs from their wire name. The paged
 * methods (`servePage`) and `resolveFileRef` (answered by URL in the handler)
 * don't forward their params verbatim, but still advertise and dispatch
 * through the member named here.
 */
function adapterMember(
  adapter: Adapter,
  method: MethodName,
): { receiver: object; name: string } | undefined {
  switch (method) {
    case 'manifest':
      return undefined;
    case 'resolveAwait':
      return adapter.awaitable ? { receiver: adapter.awaitable, name: 'resolveAwait' } : undefined;
    case 'iterateRelated':
    case 'iterateRelatedPage':
      return {
        receiver: adapter,
        name: adapter.iterateRelatedPage ? 'iterateRelatedPage' : 'iterateRelated',
      };
    default:
      return { receiver: adapter, name: method };
  }
}

/** The bound in-process function behind a protocol method, when the adapter
 *  implements it (own or prototype member; a member pruned to `undefined`, as
 *  `RemoteAdapter` does, counts as absent). */
function implementation(
  adapter: Adapter,
  method: MethodName,
): ((...args: unknown[]) => unknown) | undefined {
  const member = adapterMember(adapter, method);
  if (!member) return undefined;
  const fn: unknown = Reflect.get(member.receiver, member.name);
  if (typeof fn !== 'function') return undefined;
  return (...args) => Reflect.apply(fn, member.receiver, args);
}

/**
 * The protocol methods this adapter actually implements. `manifest` is always
 * implemented (synthesised).
 */
function implementedMethods(adapter: Adapter): MethodName[] {
  return METHOD_NAMES.filter(
    (method) => method === MANIFEST_METHOD || implementation(adapter, method) !== undefined,
  );
}

const METHOD_NAMES: readonly MethodName[] = Object.keys(METHODS).filter(isMethodName);

function isMethodName(method: string): method is MethodName {
  // Own keys only: `'toString' in METHODS` is true.
  return Object.hasOwn(METHODS, method);
}

/** `<method>: <path>: <message>` for the first zod issue — enough for a
 *  third-party author to find the field they got wrong. */
function describeParamsError(method: MethodName, error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return `${method}: params did not match the protocol schema`;
  const path = issue.path.length > 0 ? issue.path.join('.') : '(params)';
  return `${method}: ${path}: ${issue.message}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: RpcResponseShape): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function errorEnvelope(code: string, message: string, retryable: boolean): RpcResponseShape {
  return { ok: false, error: { code, message, retryable } };
}

/**
 * Build the server handler for one adapter instance.
 *
 * `methods` defaults to the methods the adapter actually implements (computed
 * by inspecting which `Adapter` members are functions on the instance). Pass
 * an explicit list to advertise a narrower / different set in the `manifest`
 * response.
 *
 * `authenticate`, when provided, gates every request: returning `false`
 * responds HTTP 401 with a non-retryable `unauthorized` envelope.
 */
export function createAdapterProtocolHandler(opts: {
  adapter: Adapter;
  methods?: readonly string[];
  authenticate?: (headers: IncomingHttpHeaders) => boolean;
  /** Where a served-but-degraded answer is reported (a drained page cut at
   *  `DRAINED_PAGE_LIMIT`). Defaults to `console.warn`, keeping the kit free
   *  of the host's logger. */
  warn?: (message: string) => void;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { adapter, authenticate } = opts;
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  const advertisedMethods = opts.methods ?? implementedMethods(adapter);

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // ── Auth ──────────────────────────────────────────────────────────────
    // 401 (not an in-envelope error) so the client's transport layer treats
    // it the same as any other non-2xx — see `client.ts` `postRpc`.
    if (authenticate && !authenticate(req.headers)) {
      send(res, 401, errorEnvelope('unauthorized', 'Authentication failed.', false));
      return;
    }

    // ── Parse ─────────────────────────────────────────────────────────────
    let parsed;
    try {
      const raw = await readBody(req);
      parsed = RpcRequest.parse(JSON.parse(raw));
    } catch (err) {
      // Genuinely malformed transport (non-JSON / envelope shape violation)
      // → HTTP 400. The client raises a (retryable) transport error; a
      // well-formed client never hits this.
      send(
        res,
        400,
        errorEnvelope(
          'bad_request',
          `Malformed request: ${err instanceof Error ? err.message : String(err)}`,
          false,
        ),
      );
      return;
    }

    const { method, params } = parsed;

    // The envelope survives a version change; what rides inside it does not
    // (v2 moved the wire to natural names), so a mismatched peer is refused
    // before anything is interpreted.
    if (parsed.protocolVersion !== PROTOCOL_VERSION) {
      send(
        res,
        200,
        errorEnvelope('protocol_version', `expected protocol version ${PROTOCOL_VERSION}`, false),
      );
      return;
    }

    // Unknown method (not in the registry) is a dispatch-level failure.
    if (!isMethodName(method)) {
      send(
        res,
        200,
        errorEnvelope('method_not_implemented', `Unknown method "${method}".`, false),
      );
      return;
    }

    const validated = METHODS[method].params.safeParse(params);
    if (!validated.success) {
      send(res, 200, errorEnvelope('bad_request', describeParamsError(method, validated.error), false));
      return;
    }

    // ── Manifest ──────────────────────────────────────────────────────────
    if (method === MANIFEST_METHOD) {
      send(res, 200, {
        ok: true,
        result: {
          protocolVersion: MANIFEST_PROTOCOL_VERSION,
          adapterType: adapter.adapterType,
          supportedTriggers: adapter.supportedTriggers,
          runtimeCapabilities: adapter.runtimeCapabilities(),
          methods: advertisedMethods,
          webhookEventTypeId: adapter.webhookEventTypeId,
        },
      });
      return;
    }

    const call = implementation(adapter, method);
    if (!call) {
      send(
        res,
        200,
        errorEnvelope(
          'method_not_implemented',
          `Adapter does not implement "${method}".`,
          false,
        ),
      );
      return;
    }

    // `resolveFileRef`'s in-process answer is a stream, which can't ride the
    // envelope; the wire answer is a URL the client fetches. Only a ref that
    // already carries one is servable — the kit hosts no bytes itself.
    if (method === 'resolveFileRef') {
      const { ref } = METHODS.resolveFileRef.params.parse(params);
      if (typeof ref.url === 'string') {
        send(res, 200, {
          ok: true,
          result: { url: ref.url, ...(ref.contentType !== undefined ? { contentType: ref.contentType } : {}) },
        });
      } else {
        send(
          res,
          200,
          errorEnvelope(
            'method_not_implemented',
            'resolveFileRef: this file is not served by URL, and remote adapters serve bytes only by URL.',
            false,
          ),
        );
      }
      return;
    }

    // ── Dispatch ──────────────────────────────────────────────────────────
    // The adapter receives the request's own params, not zod's parsed copy:
    // the wire schemas are structural mirrors that drop keys they don't name,
    // and validation is the gate, not a transform.
    const args = callArgs(method, params);
    try {
      if (PAGED_METHODS.has(method)) {
        const result = await servePage({
          adapter,
          method,
          call,
          native: adapterMember(adapter, method)?.name === 'iterateRelatedPage',
          params,
          warn,
        });
        send(res, 200, { ok: true, result });
        return;
      }

      const result = await call(...(method === 'createRecord' || method === 'updateRecord' ? [await withDeclaredFiles(adapter, args[0])] : args));
      send(res, 200, { ok: true, result: result ?? null });
    } catch (err) {
      if (err instanceof AdapterBadRequestError) {
        send(res, 200, errorEnvelope('bad_request', `${method}: ${err.message}`, false));
        return;
      }
      // Any other throw inside the adapter becomes a retryable dispatch error —
      // the engine decides whether to retry. Source-only adapters that throw
      // on writes (email) surface here as a structured envelope, not a 500.
      send(
        res,
        200,
        errorEnvelope(
          'adapter_error',
          err instanceof Error ? err.message : String(err),
          true,
        ),
      );
    }
  };
}

/**
 * A write as the in-process adapter takes it: each field the adapter's own
 * catalog declares a file (`describe` of the written type) holds a file —
 * the descriptor the wire spelled there, made one. Any other field's value is
 * data, whatever keys it carries, exactly as it is on the host's side of the
 * wire.
 */
async function withDeclaredFiles(adapter: Adapter, input: unknown): Promise<unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  const recordType: unknown = Reflect.get(input, 'recordType');
  const fields: unknown = Reflect.get(input, 'fields');
  if (typeof recordType !== 'string' || fields === null || typeof fields !== 'object' || Array.isArray(fields)) return input;
  const descriptor = await adapter.describe(recordType).catch(() => null);
  const files = new Set(
    (descriptor?.fields ?? []).filter((field) => field.kind === 'file').flatMap((field) => [field.fieldId, field.displayName]),
  );
  if (files.size === 0) return input;
  const typed: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    typed[name] = !files.has(name)
      ? value
      : Array.isArray(value)
        ? value.map((member) => fileValueOf(member) ?? member)
        : (fileValueOf(value) ?? value);
  }
  return { ...input, fields: typed };
}

/**
 * One page of a traversal: the adapter's own page when it pages natively,
 * else its stream drained up to `DRAINED_PAGE_LIMIT`. Which of the two `call`
 * is was decided once, by `adapterMember`.
 */
async function servePage(input: {
  adapter: Adapter;
  method: MethodName;
  call: (...args: unknown[]) => unknown;
  /** `call` is the adapter's own pager (`iterateRelatedPage`), not a stream. */
  native: boolean;
  params: unknown;
  warn: (message: string) => void;
}): Promise<unknown> {
  const { adapter, method, call, native, warn } = input;
  // The cursor rides beside the traversal input on the wire; in process it is
  // `iterateRelatedPage`'s second argument, and a stream takes none.
  const params: Record<string, unknown> =
    input.params !== null && typeof input.params === 'object' ? { ...input.params } : {};
  const { cursor, ...related } = params;

  if (native) return call(related, cursor);
  const iterable = call(related);
  if (!isAsyncIterable(iterable)) {
    throw new Error(`${method}: the adapter's iterateRelated did not return an AsyncIterable`);
  }
  const items: unknown[] = [];
  for await (const item of iterable) {
    if (items.length === DRAINED_PAGE_LIMIT) {
      warn(
        `[protocol] ${adapter.adapterType}.${method}: drained page cut at ${DRAINED_PAGE_LIMIT} items ` +
          '(the adapter only streams, so the rest cannot be resumed; implement iterateRelatedPage to page)',
      );
      break;
    }
    items.push(item);
  }
  return { items };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof Reflect.get(value, Symbol.asyncIterator) === 'function'
  );
}
