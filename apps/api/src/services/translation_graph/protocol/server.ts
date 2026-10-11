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
// Streaming methods (`iterateRelated`) return an `AsyncIterable`
// from the adapter. The protocol pages them as `{ items, nextCursor }`. The
// degenerate-but-correct implementation here drains the whole iterable into a
// single page on the first (cursorless) call and returns no `nextCursor`; the
// client's page loop terminates immediately. A production server would slice
// the iterable into bounded pages and emit an opaque `nextCursor` — a single
// page is a valid cursor implementation (one page, no continuation).
//
// Dependency-light by design: Node `http` types only, no express.

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

import { z } from 'zod';

import { neverAsAny } from '../../../lib/utils/types';
import type { Adapter } from '../adapter';
import { edgeNaturalName } from '../adapters/name_resolution';
import { META_RECORD_TYPE } from '../types';
import type { SchemaEntryPoint, SchemaTypeDescriptor } from '../types';
import { RpcRequest, METHODS } from './schema';
import type { MethodName, RpcResponseShape } from './schema';

/**
 * Protocol method names that exist purely as server-side concepts (no
 * matching `Adapter` member): `manifest` is synthesised from the adapter's
 * readonly props. Everything else in `METHODS` maps 1:1 to an `Adapter`
 * member of the same name.
 */
const MANIFEST_METHOD = 'manifest' satisfies MethodName;

/**
 * Methods the protocol delivers as paged `{ items, nextCursor }` even though
 * the underlying `Adapter` member returns an `AsyncIterable`. The server
 * drains the iterable into a single page (see file header).
 */
const STREAMING_METHODS = new Set<MethodName>(['iterateRelated']);

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
  if (fields && params && typeof params === 'object') {
    return fields.map((field) => (params as Record<string, unknown>)[field]);
  }
  return [params];
}

/**
 * Compute the set of protocol methods this adapter actually implements —
 * a member is "implemented" when it is a function on the instance (own or
 * prototype). `manifest` is always implemented (synthesised). Optional
 * `Adapter` methods the instance pruned to `undefined` (the `RemoteAdapter`
 * pattern) or never defined are excluded.
 */
// ── Wire ids → natural names ─────────────────────────────────────────────
//
// The wire speaks the adapter's INTERNAL ids: the remote shim resolves the
// program's natural names against the manifest it fetched and forwards the ids
// (Decision #3, wire protocol unchanged). An in-process `Adapter` takes NATURAL
// names and resolves them itself. So this bridge turns the ids back into
// natural names, from the adapter's own introspection, before the call — the
// mirror of the shim's forward translation, method for method. Without it an
// adapter whose ids differ from its names (email: edge `attachments`, named
// `Attachments`) reads every id as an unknown name and reports drift.
//
// An id with no natural name passes through as itself, so the adapter is
// still the one that judges it.

/** Reverse lookups over one adapter's introspection, fetched on first use and
 *  kept for the handler's lifetime (the shim's resolver has the same span). */
interface WireNames {
  typeName(typeId: string): Promise<string>;
  fieldName(typeRef: string, fieldId: string): Promise<string>;
  edgeName(typeRef: string, edgeReadId: string): Promise<string>;
}

function wireNames(adapter: Adapter): WireNames {
  let entries: Promise<SchemaEntryPoint[]> | undefined;
  const descriptors = new Map<string, Promise<SchemaTypeDescriptor | null>>();
  const entryList = (): Promise<SchemaEntryPoint[]> => {
    entries ??= adapter.listEntryPoints().catch((err: unknown) => {
      entries = undefined;
      throw err;
    });
    return entries;
  };
  /** A position's type is the NATURAL name (the shim never rewrites a
   *  position); a write's is the internal id. Accept either. */
  const descriptorOf = async (typeRef: string): Promise<SchemaTypeDescriptor | null> => {
    const list = await entryList();
    const entry =
      list.find((e) => e.displayName === typeRef) ?? list.find((e) => e.typeId === typeRef);
    if (!entry) return null;
    let descriptor = descriptors.get(entry.typeId);
    if (!descriptor) {
      descriptor = adapter.describe(entry.typeId).catch((err: unknown) => {
        descriptors.delete(entry.typeId);
        throw err;
      });
      descriptors.set(entry.typeId, descriptor);
    }
    return descriptor;
  };
  return {
    typeName: async (typeId) =>
      (await entryList()).find((e) => e.typeId === typeId)?.displayName ?? typeId,
    fieldName: async (typeRef, fieldId) =>
      (await descriptorOf(typeRef))?.fields.find((f) => f.fieldId === fieldId)?.displayName ??
      fieldId,
    edgeName: async (typeRef, edgeReadId) => {
      const ref = (await descriptorOf(typeRef))?.references.find((r) => r.fieldId === edgeReadId);
      return ref ? edgeNaturalName(ref) : edgeReadId;
    },
  };
}

// Only the name-bearing members are read; `passthrough` keeps the rest of the
// params exactly as the client sent them.
const RelatedNames = z
  .object({
    position: z.object({ recordType: z.string().nullable() }).passthrough(),
    fieldId: z.string(),
  })
  .passthrough();
const WriteNames = z
  .object({
    recordType: z.string(),
    fields: z.record(z.string(), z.unknown()),
    evidence: z.record(z.string(), z.unknown()).optional(),
    parentLinks: z.array(z.object({ recordType: z.string() }).passthrough()).optional(),
  })
  .passthrough();
const ResolveEntityNames = z
  .object({
    recordType: z.string(),
    record: z.record(z.string(), z.unknown()),
    constraints: z
      .object({
        any: z.array(
          z.object({ all: z.array(z.object({ field: z.string() }).passthrough()) }).passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough();
const RecordTypeNames = z.object({ recordType: z.string() }).passthrough();
const FieldFunctionNames = z.object({ recordType: z.string(), fieldId: z.string() }).passthrough();
const EntityTypeNames = z.object({ entityType: z.string() }).passthrough();
const TypeRefNames = z.object({ typeRef: z.string() }).passthrough();

async function renameKeys(
  bag: Record<string, unknown>,
  rename: (key: string) => Promise<string>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bag)) out[await rename(key)] = value;
  return out;
}

/** A method's wire params with every internal id the shim produced turned
 *  back into the adapter's natural name. Methods that carry no translated
 *  name (positions the adapter minted, raw events, opaque ids) pass through. */
async function naturalParams(method: MethodName, params: unknown, names: WireNames): Promise<unknown> {
  switch (method) {
    case 'getFieldValue': {
      const p = RelatedNames.parse(params);
      if (p.position.recordType === null) return p;
      return { ...p, fieldId: await names.fieldName(p.position.recordType, p.fieldId) };
    }
    case 'getRelated':
    case 'iterateRelated': {
      const p = RelatedNames.parse(params);
      const holder = p.position.recordType;
      if (holder === null) return p;
      // A meta-root hop names a collection (a type); any other hop names an
      // edge on the position's type.
      if (holder === META_RECORD_TYPE) return { ...p, fieldId: await names.typeName(p.fieldId) };
      return { ...p, fieldId: await names.edgeName(holder, p.fieldId) };
    }
    case 'createRecord':
    case 'updateRecord': {
      const p = WriteNames.parse(params);
      const field = (id: string): Promise<string> => names.fieldName(p.recordType, id);
      return {
        ...p,
        recordType: await names.typeName(p.recordType),
        fields: await renameKeys(p.fields, field),
        ...(p.evidence ? { evidence: await renameKeys(p.evidence, field) } : {}),
        // A parent link's edge already rides as its natural name (the shim
        // sends the write name, which is the reference name where one is set).
        ...(p.parentLinks
          ? {
              parentLinks: await Promise.all(
                p.parentLinks.map(async (link) => ({
                  ...link,
                  recordType: await names.typeName(link.recordType),
                })),
              ),
            }
          : {}),
      };
    }
    case 'deleteRecord': {
      const p = RecordTypeNames.parse(params);
      return { ...p, recordType: await names.typeName(p.recordType) };
    }
    case 'resolveEntity': {
      const p = ResolveEntityNames.parse(params);
      const field = (id: string): Promise<string> => names.fieldName(p.recordType, id);
      return {
        ...p,
        recordType: await names.typeName(p.recordType),
        record: await renameKeys(p.record, field),
        constraints: {
          ...p.constraints,
          any: await Promise.all(
            p.constraints.any.map(async (branch) => ({
              ...branch,
              all: await Promise.all(
                branch.all.map(async (entry) => ({ ...entry, field: await field(entry.field) })),
              ),
            })),
          ),
        },
      };
    }
    case 'invokeFieldFunction': {
      const p = FieldFunctionNames.parse(params);
      return {
        ...p,
        recordType: await names.typeName(p.recordType),
        fieldId: await names.fieldName(p.recordType, p.fieldId),
      };
    }
    case 'translateFilter': {
      const p = EntityTypeNames.parse(params);
      return { ...p, entityType: await names.typeName(p.entityType) };
    }
    case 'getDedupRules': {
      const p = TypeRefNames.parse(params);
      return { ...p, typeRef: await names.typeName(p.typeRef) };
    }
    // `describe` takes an internal id or a natural name alike; positions and
    // events are the adapter's own; the rest carry no names.
    case 'manifest':
    case 'listEntryPoints':
    case 'describe':
    case 'edgesFrom':
    case 'preprocessInbound':
    case 'listEventTypes':
    case 'readRecord':
    case 'getActorCandidates':
    case 'extractActor':
    case 'describeOpaqueId':
    case 'resolveFileRef':
      return params;
    default:
      return neverAsAny(method);
  }
}

function implementedMethods(adapter: Adapter): MethodName[] {
  const all = Object.keys(METHODS) as MethodName[];
  return all.filter((method) => {
    if (method === MANIFEST_METHOD) return true;
    // `resolveFileRef`'s wire bridging (stream → hosted URL) is not yet
    // implemented by the generic server (see the dispatch guard); never
    // advertise it from the in-process bridge.
    if (method === 'resolveFileRef') return false;
    return typeof (adapter as unknown as Record<string, unknown>)[method] === 'function';
  });
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
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { adapter, authenticate } = opts;
  const advertisedMethods = opts.methods ?? implementedMethods(adapter);
  const names = wireNames(adapter);

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

    // ── Manifest ──────────────────────────────────────────────────────────
    if (method === MANIFEST_METHOD) {
      send(res, 200, {
        ok: true,
        result: {
          adapterType: adapter.adapterType,
          supportedTriggers: adapter.supportedTriggers,
          runtimeCapabilities: adapter.runtimeCapabilities(),
          methods: advertisedMethods,
          webhookEventTypeId: adapter.webhookEventTypeId,
        },
      });
      return;
    }

    // Unknown method (not in the registry) is a dispatch-level failure.
    if (!(method in METHODS)) {
      send(
        res,
        200,
        errorEnvelope('method_not_implemented', `Unknown method "${method}".`, false),
      );
      return;
    }

    // `resolveFileRef` is the one method whose in-process return shape
    // (`{ stream }`) does NOT match its wire result shape (`{ url }`): a Node
    // stream can't ride the JSON envelope. A server fronting a file-owning
    // adapter must host the bytes behind a URL and return that — which needs
    // the registry/token + pass-through machinery on the server side. That
    // wiring lands in a later slice (no in-process adapter emits FileRefs in
    // 1a), so the generic dispatch below would mis-serialise the stream.
    // Until then, advertise it as unimplemented so the generic path never
    // runs for it. The client (`RemoteAdapter.resolveFileRef`) is the
    // consumer; it talks to a real owner server, not this generic bridge.
    if (method === 'resolveFileRef') {
      send(
        res,
        200,
        errorEnvelope(
          'method_not_implemented',
          'resolveFileRef url-hosting is not yet implemented by the generic protocol server.',
          false,
        ),
      );
      return;
    }

    const member = (adapter as unknown as Record<string, unknown>)[method];
    if (typeof member !== 'function') {
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

    // ── Dispatch ──────────────────────────────────────────────────────────
    try {
      const args = callArgs(
        method as MethodName,
        await naturalParams(method as MethodName, params, names),
      );
      if (STREAMING_METHODS.has(method as MethodName)) {
        const result = await drainStream(member.call(adapter, ...args));
        send(res, 200, { ok: true, result });
        return;
      }

      const result = await member.call(adapter, ...args);
      send(res, 200, { ok: true, result: result ?? null });
    } catch (err) {
      // Any throw inside the adapter becomes a retryable dispatch error —
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
 * Drain an `AsyncIterable` into a single protocol page. Real servers would
 * page; one page (no `nextCursor`) is the degenerate-but-correct
 * implementation — the client's page loop terminates after it.
 */
async function drainStream(iterable: unknown): Promise<{ items: unknown[] }> {
  const items: unknown[] = [];
  for await (const item of iterable as AsyncIterable<unknown>) {
    items.push(item);
  }
  return { items };
}
