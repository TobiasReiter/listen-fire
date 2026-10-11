// The Rust engine's host dispatch: every request a segment makes, by family
// and method, answered from the run's `EngineHost`. This is the one module that
// knows the host's shapes, so a change to the host boundary
// (docs/contracts/host-families.md) is adapted here and in the Rust request builders
// (crates/movement-engine/src/host.rs) and nowhere between.
//
// A request whose family and method are an `EngineHost` method's
// (`HOST_FAMILIES`) is that method's request, in the contract's shape, and is
// forwarded as it is: the engine names the segment the run host opened. Two
// families are the engine's own and never reach an `EngineHost`
// (`ENGINE_OWN_ROUTES`): `check`, the TypeScript checker until the checker is
// Rust, and `builtins`, the TypeScript standard library for the readings the
// Rust engine hands back.
//
// One encoding is this shim's own: a request marked `wire: true` carries its
// values on the eval wire (rust_wire.ts), not as plain JSON, so the host is
// handed exactly the JavaScript values (key order, `undefined`) the TypeScript
// engine hands it in process, and an adapter's result comes back the same way.

import { applyStdlib, languageVersionDiagnostic, stdlibFunctionById, type CatalogSnapshot } from 'movement-lang';
import { isFileRef, type ParkedScopeState } from 'engine-contracts';
import { z } from 'zod';

import { compareValues } from '#shared/expression/filter';
import type { FilterOperator } from '#shared/expression/types';
import { getErrorMessage } from '../../lib/utils/error';
import { logger } from '../logger';
import type { TriggerEvent } from '../translation_graph/triggers/types';
import type { UniquenessConstraints } from '../translation_graph/uniqueness';
import { hasCapability, isModelName } from '../../lib/models/registry';
import { EFFORTS, type Effort, type TierModel } from './ai_tiers';
import { applyMovementFunction } from './builtins';
import { MovementEngineError } from './errors';
import { ADAPTER_METHODS, type AdapterCall, type AdapterMethod, type EngineHost } from './host';
import { hostCallFailure } from './host_adapter';
import { checkAnswer, checkPinned } from './program_check';
import type { MovementRunResult } from './run';
import { publishTrace, runLogFields, type RunContext } from './run_context';
import type { HostAnswer, HostRequest } from './rust_engine';
import { rustRunStats } from './rust_stats';
import {
  REFUSED,
  RunAborted,
  RustShimError,
  WireOut,
  isCallbackParam,
  optionalString,
  optionalStringRecord,
  plainJson,
  record,
  string,
} from './rust_wire';

// ── Routes ────────────────────────────────────────────────────────────────────

export interface RouteContext {
  host: EngineHost;
  /** The segment the run host opened, with the run's trace and account. */
  context: RunContext;
  catalog: CatalogSnapshot;
  hostErrors: unknown[];
  /** The positions the segment registered, by handle (`adapters.call`'s
   *  `positionRef`): each crossed once, and is handed to the host's adapter
   *  as that one object on every call that names it. */
  positions: Map<number, unknown>;
  /** The segment's wire: everything the engine was sent (its event, every
   *  answer) by the id the wire gave it, so a request naming one hands the
   *  host that very object, as the TypeScript engine does. */
  wire: WireOut;
}

type Route = (args: Record<string, unknown>, context: RouteContext) => Promise<unknown>;

/** The routes that are the Rust engine's own, not `EngineHost` methods, and
 *  why each is not on the host boundary. */
export const ENGINE_OWN_ROUTES: Readonly<Record<string, string>> = {
  'check.program': 'the TypeScript checker, which the Rust engine asks for until the checker is Rust',
  'builtins.function': 'a TypeScript standard-library member, for a reading the Rust engine hands back',
  'builtins.compare': "the shared comparator, for a reading the Rust engine hands back",
  'log.write': "the platform's log, for the lines the TypeScript engine writes (sent as a statement ends)",
};

/**
 * Every host call the engine can make, by its path (`park.sink.commitTimerPark`).
 * The request shapes are the engine's (crates/movement-engine/src/host.rs, one
 * builder each); a route reads its args at this boundary and answers plain
 * data.
 */
const ROUTES: Record<string, Route> = {
  /** The TypeScript checker over the pinned source (program_check.ts):
   *  every diagnostic, the import link and the checker's AST stamps as
   *  data, and the run's version warning for a deprecated pin. A program
   *  that fails its check ends the run with the check's error, exactly as
   *  parseAndCheck throws it. */
  async 'check.program'(request, context) {
    const languageVersion = request.languageVersion;
    if (typeof languageVersion !== 'number') throw new RustShimError('check.program languageVersion must be a number');
    const upgradingFrom = request.upgradingFrom;
    if (upgradingFrom !== undefined && typeof upgradingFrom !== 'number') {
      throw new RustShimError('check.program upgradingFrom must be a number');
    }
    const source = string(request.source, 'check.program source');
    let checked;
    try {
      checked = checkPinned({
        source,
        catalog: context.catalog,
        languageVersion,
        ...(upgradingFrom !== undefined ? { upgradingFrom } : {}),
      });
    } catch (error) {
      throw new RunAborted(error);
    }
    // The run's own version warning, read as the TypeScript engine reads it
    // (run.ts, before the body): the release the engine runs under, not the
    // checker's own view of it, which a host may hold apart.
    const versionWarning = languageVersionDiagnostic(languageVersion);
    return {
      ...checkAnswer(checked),
      ...(versionWarning !== undefined ? { versionWarning: { code: versionWarning.code, message: versionWarning.message } } : {}),
    };
  },
  async 'adapters.resolve'(request, { host }) {
    const role = request.role;
    if (role !== 'source' && role !== 'target') {
      throw new RustShimError(`adapters.resolve role must be "source" or "target", not ${JSON.stringify(role)}`);
    }
    const credentialsId = optionalString(request.credentialsId, 'adapters.resolve credentialsId');
    const constructionArgs = optionalStringRecord(request.constructionArgs, 'adapters.resolve constructionArgs');
    if (request.dryRun !== undefined && request.dryRun !== true) throw new RustShimError('adapters.resolve dryRun is true or absent');
    return host.adapters.resolve({
      segmentId: segmentOf(request),
      // As the dict holds it (absent where it holds none): the host keys its
      // registry by it, as TypeScript's in-process resolution does.
      adapterType: request.adapterType,
      ...(credentialsId !== undefined ? { credentialsId } : {}),
      ...(constructionArgs !== undefined ? { constructionArgs } : {}),
      role,
      ...(request.dryRun === true ? { dryRun: true } : {}),
    });
  },
  /** `{result}` or `{error}`, as data. A host error is held here as the very
   *  error the TypeScript's stand-in raises for it (host_adapter.ts), under
   *  the `ref` its answer carries, so a run that fails with it fails with an
   *  equal error. */
  async 'adapters.call'(request, { host, hostErrors, positions, wire }) {
    const method = adapterMethod(request.method);
    if (request.wire !== true) throw new RustShimError('adapters.call carries its args on the eval wire');
    const rest = wire.read(request.args);
    if (!isCallArgs(rest)) throw new RustShimError(`adapters.call ${method}: args are one object`);
    const args = withPosition(request, rest, positions, wire);
    const answer = await host.adapters.call({
      segmentId: segmentOf(request),
      instance: string(request.instance, 'adapters.call instance'),
      method,
      args,
    });
    if ('error' in answer) {
      hostErrors.push(hostCallFailure(answer.error));
      return new Plain(plainJson({ error: { ...answer.error, ref: hostErrors.length - 1 } }, `adapters.call ${method} error`));
    }
    // An adapter's answer is data, as the event is, whatever keys it carries.
    const result = wire.value(answer.result);
    if (result === REFUSED) throw new RustShimError(`adapters.call ${method} returned a value the eval wire cannot carry as itself`);
    return new Plain({ result });
  },
  /** The identity judge over a write's candidates, a priced call: the
   *  engine's budget goes in, the answer (its cost, or a budget refusal)
   *  comes back as data for the engine's ledger. */
  async 'llm.arbitrateEntities'(request, { host, context, wire }) {
    const asserted = wiredRecord(wire, request.asserted, 'llm.arbitrateEntities asserted');
    const candidates = wire.read(request.candidates);
    if (!Array.isArray(candidates)) throw new RustShimError('llm.arbitrateEntities candidates is a list');
    const constraints = wire.read(request.constraints);
    if (!isUniquenessConstraints(constraints)) throw new RustShimError('llm.arbitrateEntities constraints are {any: [{all}]}');
    const languageVersion = request.languageVersion;
    if (typeof languageVersion !== 'number') throw new RustShimError('llm.arbitrateEntities languageVersion is a number');
    const answer = await host.llm.arbitrateEntities({
      segmentId: segmentOf(request),
      asserted,
      candidates,
      recordType: string(request.recordType, 'llm.arbitrateEntities recordType'),
      constraints,
      languageVersion,
      budget: budgetOf(request.budget),
    });
    // Charged to the run's account as the answer passes, so what the host
    // spent reaches the run even if the segment then faults; the engine's own
    // ledger charges it too, for its budget, and `done` reports it back
    // (rust_engine.ts `readRunResult` holds the two equal).
    context.ledger.charge(answer.cost);
    if ('error' in answer) return answer;
    // `candidates[index]` finds nothing for anything but an integer (NaN,
    // a fraction, `undefined`), exactly as for null: the write creates.
    const { index, ...rest } = answer;
    return { ...rest, index: typeof index === 'number' && Number.isInteger(index) ? index : null };
  },
  /** An extraction region's model call, a priced call: the reply comes back
   *  on the eval wire, so the engine reads `parsedJson` exactly as
   *  `JSON.parse` left it (key order, the numbers past what JSON can write);
   *  its cost is charged to the run's account as it passes, as the judge's. */
  async 'llm.client.call'(request, { host, context, wire }) {
    if (request.wire !== true) throw new RustShimError('llm.client.call takes its answer on the eval wire');
    const effort = optionalString(request.effort, 'llm.client.call effort');
    if (effort !== undefined && !isEffort(effort)) throw new RustShimError(`llm.client.call effort ${JSON.stringify(effort)} is not an effort`);
    const maxTokens = request.maxTokens;
    if (maxTokens !== undefined && (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens))) {
      throw new RustShimError('llm.client.call maxTokens is an integer');
    }
    const answer = await host.llm.client.call({
      segmentId: segmentOf(request),
      system: string(request.system, 'llm.client.call system'),
      userMessage: string(request.userMessage, 'llm.client.call userMessage'),
      label: string(request.label, 'llm.client.call label'),
      model: extractionModel(request.model),
      ...(effort !== undefined ? { effort } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      budget: budgetOf(request.budget),
    });
    context.ledger.charge(answer.cost);
    return new Plain(wired(wire, answer, 'llm.client.call', ['parsedJson', 'rawText']));
  },
  /** A plugin's invocation (`through` or a plain call), a priced call: its
   *  arguments and the entity's fields so far arrive on the eval wire, and
   *  what it brought back goes back on it. */
  async 'llm.transforms.invoke'(request, { host, context, wire }) {
    if (request.wire !== true) throw new RustShimError('llm.transforms.invoke carries its values on the eval wire');
    const answer = await host.llm.transforms.invoke({
      segmentId: segmentOf(request),
      plugin: string(request.plugin, 'llm.transforms.invoke plugin'),
      config: wiredRecord(wire, request.config, 'llm.transforms.invoke config'),
      extractedContext: wiredRecord(wire, request.extractedContext, 'llm.transforms.invoke extractedContext'),
      budget: budgetOf(request.budget),
    });
    context.ledger.charge(answer.cost);
    return new Plain(wired(wire, answer, 'llm.transforms.invoke', ['text', 'data', 'records', 'outcome']));
  },
  /** A source file's text, a priced call: the descriptor on the eval wire. */
  async 'files.resolveFileText'(request, { host, context, wire }) {
    if (request.wire !== true) throw new RustShimError('files.resolveFileText carries its file on the eval wire');
    const file = wire.read(request.file);
    if (!isFileRef(file)) throw new RustShimError('files.resolveFileText file is a FileRef');
    const answer = await host.files.resolveFileText({ segmentId: segmentOf(request), file, budget: budgetOf(request.budget) });
    context.ledger.charge(answer.cost);
    return new Plain(wired(wire, answer, 'files.resolveFileText', ['text', 'rawTextId', 'detail']));
  },
  /** The principal the event acts as (`@user_*`), the event on the eval
   *  wire, and the answer back on it. A host that throws answers an error,
   *  which the engine reads as no user, as the TypeScript engine forgives
   *  the throw (`resolveMovementActingUserUncached`). */
  async 'lookup.resolveActingUser'(request, { host, wire }) {
    if (request.wire !== true) throw new RustShimError('lookup.resolveActingUser carries its event on the eval wire');
    const event = wire.read(request.event);
    if (!isTriggerEvent(event)) throw new RustShimError('lookup.resolveActingUser event is a trigger event');
    const triggerId = optionalString(request.triggerId, 'lookup.resolveActingUser triggerId');
    const actingUser = await host.lookup.resolveActingUser({
      ...(triggerId !== undefined ? { triggerId } : {}),
      instance: string(request.instance, 'lookup.resolveActingUser instance'),
      event,
      // Last, as run_context.ts's binding adds it.
      segmentId: segmentOf(request),
    });
    const value = wire.value(actingUser);
    if (value === REFUSED) throw new RustShimError('lookup.resolveActingUser answered a principal the eval wire cannot carry as itself');
    return new Plain(value);
  },
  /** `FILE(content, type)`: the host renders and stores the artifact; its
   *  descriptor comes back on the eval wire. */
  async 'files.render'(request, { host, wire }) {
    const type = request.type;
    if (type !== 'pdf' && type !== 'text') throw new RustShimError('files.render type is "pdf" or "text"');
    const ref = await host.files.render({ segmentId: segmentOf(request), content: string(request.content, 'files.render content'), type });
    const value = wire.value(ref);
    if (value === REFUSED) throw new RustShimError('files.render answered a descriptor the eval wire cannot carry as itself');
    return new Plain(value);
  },
  /** Fresh ids, for the resources an extraction carries. */
  async 'ids.mint'(request, { host }) {
    const count = request.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) throw new RustShimError('ids.mint count is a positive integer');
    return host.ids.mint({ segmentId: segmentOf(request), count });
  },
  /** The segment's cross-run write locks: a token per acquire. */
  async 'locks.acquire'(request, { host }) {
    return host.locks.acquire({ segmentId: segmentOf(request), names: lockNames(request) });
  },
  async 'locks.release'(request, { host }) {
    await host.locks.release({ segmentId: segmentOf(request), token: string(request.token, 'locks.release token') });
    return undefined;
  },
  /** A timer park, its wake the host clock's answer plus the sleep (the
   *  engine asked `clock.now`). Asked only of a host that serves it. */
  async 'park.sink.commitTimerPark'(request, { host, wire }) {
    const sink = host.park.sink;
    if (sink?.commitTimerPark === undefined) throw notServed('park.sink.commitTimerPark');
    if (request.wire !== true) throw new RustShimError('park.sink.commitTimerPark carries its state on the eval wire');
    await sink.commitTimerPark({
      segmentId: segmentOf(request),
      address: string(request.address, 'park.sink.commitTimerPark address'),
      // On the eval wire: the state's objects in the order the engine wrote them.
      state: wire.read(request.state),
      wakeAt: instant(request.wakeAt, 'park.sink.commitTimerPark wakeAt'),
    });
    return undefined;
  },
  /** An engine-initiated suspension (run.ts `suspendFlow`), asked only of a
   *  sink that can suspend (run.ts `canSuspend`). */
  async 'park.sink.commitSuspension'(request, { host, wire }) {
    const sink = host.park.sink;
    if (sink?.commitSuspension === undefined) throw notServed('park.sink.commitSuspension');
    if (request.wire !== true) throw new RustShimError('park.sink.commitSuspension carries its state on the eval wire');
    await sink.commitSuspension({
      segmentId: segmentOf(request),
      address: string(request.address, 'park.sink.commitSuspension address'),
      state: wire.read(request.state),
    });
    return undefined;
  },
  /** The run is pausing at its cost cap, asked only of a sink that can
   *  suspend and keeps a pause. */
  async 'park.sink.commitLimitPause'(request, { host }) {
    const sink = host.park.sink;
    if (sink?.commitLimitPause === undefined) throw notServed('park.sink.commitLimitPause');
    if (request.limit !== 'cost') throw new RustShimError('park.sink.commitLimitPause limit is "cost"');
    // The segment last, as run_context.ts's sink binding adds it to the
    // TypeScript's pause: the two requests are the same text.
    await sink.commitLimitPause({
      limit: 'cost',
      capMicrodollars: microdollars(request.capMicrodollars, 'park.sink.commitLimitPause capMicrodollars'),
      spentMicrodollars: microdollars(request.spentMicrodollars, 'park.sink.commitLimitPause spentMicrodollars'),
      segmentId: segmentOf(request),
    });
    return undefined;
  },
  /** An await park (an awaitable adapter's edge, a callback's `Called`):
   *  its state on the eval wire and the key a wake names it by. */
  async 'park.sink.commitAwaitPark'(request, { host, wire }) {
    const sink = host.park.sink;
    if (sink?.commitAwaitPark === undefined) throw notServed('park.sink.commitAwaitPark');
    if (request.wire !== true) throw new RustShimError('park.sink.commitAwaitPark carries its state on the eval wire');
    await sink.commitAwaitPark({
      segmentId: segmentOf(request),
      address: string(request.address, 'park.sink.commitAwaitPark address'),
      state: wire.read(request.state),
      adapterType: string(request.adapterType, 'park.sink.commitAwaitPark adapterType'),
      correlationKey: string(request.correlationKey, 'park.sink.commitAwaitPark correlationKey'),
    });
    return undefined;
  },
  /** A join frame's pending count. */
  async 'park.sink.recordJoin'(request, { host }) {
    const sink = host.park.sink;
    if (sink?.recordJoin === undefined) throw notServed('park.sink.recordJoin');
    await sink.recordJoin({
      segmentId: segmentOf(request),
      frameAddress: string(request.frameAddress, 'park.sink.recordJoin frameAddress'),
      parkedChildren: count(request.parkedChildren, 'park.sink.recordJoin parkedChildren'),
    });
    return undefined;
  },
  /** A finished branch's exports at its frame, on the eval wire. */
  async 'park.sink.persistBranchExport'(request, { host, wire }) {
    const sink = host.park.sink;
    if (sink?.persistBranchExport === undefined) throw notServed('park.sink.persistBranchExport');
    if (request.wire !== true) throw new RustShimError('park.sink.persistBranchExport carries its exports on the eval wire');
    const branchIndex = request.branchIndex;
    if (typeof branchIndex !== 'number' || !Number.isInteger(branchIndex)) throw new RustShimError('park.sink.persistBranchExport branchIndex is an integer');
    await sink.persistBranchExport({
      segmentId: segmentOf(request),
      frameAddress: string(request.frameAddress, 'park.sink.persistBranchExport frameAddress'),
      branchAddress: string(request.branchAddress, 'park.sink.persistBranchExport branchAddress'),
      branchIndex,
      exports: wire.read(request.exports),
    });
    return undefined;
  },
  /** A resumed branch's decrement of its frame: `{closed}`. */
  async 'park.sink.decrementJoin'(request, { host }) {
    const sink = host.park.sink;
    if (sink?.decrementJoin === undefined) throw notServed('park.sink.decrementJoin');
    const { closed } = await sink.decrementJoin({
      segmentId: segmentOf(request),
      frameAddress: string(request.frameAddress, 'park.sink.decrementJoin frameAddress'),
      branchAddress: string(request.branchAddress, 'park.sink.decrementJoin branchAddress'),
      leafAddress: string(request.leafAddress, 'park.sink.decrementJoin leafAddress'),
    });
    return { closed: closed === true };
  },
  /** Every branch's exports at a frame, by branch index, as data on the
   *  eval wire (the descriptors keep their key order). */
  async 'park.sink.collectBranchExports'(request, { host, wire }) {
    const sink = host.park.sink;
    if (sink?.collectBranchExports === undefined) throw notServed('park.sink.collectBranchExports');
    const rows = await sink.collectBranchExports({
      segmentId: segmentOf(request),
      frameAddress: string(request.frameAddress, 'park.sink.collectBranchExports frameAddress'),
    });
    const value = wire.value(rows);
    if (value === REFUSED) throw new RustShimError('park.sink.collectBranchExports answered exports the eval wire cannot carry as themselves');
    return new Plain(value);
  },
  /** The race cascade: every park at or below each prefix withdrawn. */
  async 'park.sink.cancelSubtrees'(request, { host }) {
    const sink = host.park.sink;
    if (sink?.cancelSubtrees === undefined) throw notServed('park.sink.cancelSubtrees');
    const subtrees = request.subtreeAddresses;
    if (!Array.isArray(subtrees) || !subtrees.every((address) => typeof address === 'string')) {
      throw new RustShimError('park.sink.cancelSubtrees subtreeAddresses are a list of texts');
    }
    const excludeLeaf = optionalString(request.excludeLeaf, 'park.sink.cancelSubtrees excludeLeaf');
    await sink.cancelSubtrees({
      segmentId: segmentOf(request),
      subtreeAddresses: subtrees,
      ...(excludeLeaf !== undefined ? { excludeLeaf } : {}),
    });
    return undefined;
  },
  /** "Resume whatever is parked on this key." */
  async 'park.wake'(request, { host }) {
    await host.park.wake({
      segmentId: segmentOf(request),
      adapterType: string(request.adapterType, 'park.wake adapterType'),
      correlationKey: string(request.correlationKey, 'park.wake correlationKey'),
    });
    return undefined;
  },
  /** A callback minted, its captured continuation on the eval wire:
   *  `{id, url}`. */
  async 'park.callbacks.mint'(request, { host, wire }) {
    const callbacks = host.park.callbacks;
    if (callbacks === undefined) throw notServed('park.callbacks.mint');
    if (request.wire !== true) throw new RustShimError('park.callbacks.mint carries its state on the eval wire');
    if (typeof request.singleUse !== 'boolean') throw new RustShimError('park.callbacks.mint singleUse is a boolean');
    const params = request.params;
    if (!Array.isArray(params) || !params.every(isCallbackParam)) throw new RustShimError('park.callbacks.mint params are {name, type} each');
    const expiresAt = request.expiresAt === undefined ? undefined : instant(request.expiresAt, 'park.callbacks.mint expiresAt');
    const state = wire.read(request.state);
    if (!isParkedState(state)) throw new RustShimError('park.callbacks.mint state is a parked state');
    return callbacks.mint({
      segmentId: segmentOf(request),
      address: string(request.address, 'park.callbacks.mint address'),
      params,
      state,
      singleUse: request.singleUse,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    });
  },
  /** A callback's live call ledger, as data on the eval wire. */
  async 'park.callbacks.calls'(request, { host, wire }) {
    const callbacks = host.park.callbacks;
    if (callbacks === undefined) throw notServed('park.callbacks.calls');
    const calls = await callbacks.calls({
      segmentId: segmentOf(request),
      callbackId: string(request.callbackId, 'park.callbacks.calls callbackId'),
    });
    const value = wire.value(calls);
    if (value === REFUSED) throw new RustShimError('park.callbacks.calls answered calls the eval wire cannot carry as themselves');
    return new Plain(value);
  },
  /** The host's instant now, read at the boundary as the TypeScript engine
   *  reads it (run_context.ts): an answer naming no instant fails the run. */
  async 'clock.now'(request, { context }) {
    segmentOf(request);
    return { nowIso: (await context.clock.now()).toISOString() };
  },
  /** The cancel gate at a statement boundary. */
  async 'control.cancel.cancelled'(request, { host }) {
    return host.control.cancel.cancelled({ segmentId: segmentOf(request) });
  },
  /** The run's last, undebounced, cancel check. */
  async 'control.cancel.cancelledNow'(request, { host }) {
    return host.control.cancel.cancelledNow({ segmentId: segmentOf(request) });
  },
  /** Entries on the run's trace, as they land: the segment's own trace (the
   *  result's), handed on to the host's. */
  async 'trace.append'(request, { host, context }) {
    segmentOf(request);
    // On the eval wire, so each entry keeps the key order the engine wrote.
    if (request.wire !== true) throw new RustShimError('trace.append carries its entries on the eval wire');
    const entries = new WireOut().read(request.entries);
    if (!Array.isArray(entries)) throw new RustShimError('trace.append entries are a list');
    if (request.closing !== undefined && request.closing !== true) throw new RustShimError('trace.append closing is true or absent');
    context.trace.entries.push(...entries.map(traceEntry));
    try {
      await publishTrace(context, host);
    } catch (error) {
      // The hand-over as the segment ends is never the run's failure: the
      // engine moves on, and the loss is logged, as run_context.ts
      // `closeRunContext` logs its own.
      if (request.closing === true) {
        logger.error('[movement] a segment that ended could not hand the host the rest of its trace', {
          segmentId: context.segmentId,
          error: getErrorMessage(error),
          ...runLogFields(context),
        });
      }
      throw error;
    }
    return undefined;
  },
  /** Lines on the platform's log, each `{level, message, fields}`, the run
   *  they belong to named. */
  async 'log.write'(request, { context }) {
    const lines = request.lines;
    if (!Array.isArray(lines)) throw new RustShimError('log.write lines are a list');
    for (const line of lines) {
      const { level, message, fields } = record(line, 'a log line');
      const text = string(message, 'a log line message');
      const meta = { ...record(fields, 'a log line fields'), ...runLogFields(context) };
      if (level === 'warn') logger.warn(text, meta);
      else if (level === 'info') logger.info(text, meta);
      else if (level === 'error') logger.error(text, meta);
      else throw new RustShimError(`a log line's level is info, warn or error, not ${JSON.stringify(level)}`);
    }
    return undefined;
  },
  /** A built-in the Rust engine hands back for these arguments, answered by
   *  the TypeScript member: its value, or what it throws. */
  async 'builtins.function'(request, { wire }) {
    const id = string(request.id, 'builtins.function id');
    if (!Array.isArray(request.args)) throw new RustShimError('builtins.function args must be an array');
    const values = request.args.map((arg) => wire.read(arg));
    const now = new Date(string(request.now, 'builtins.function now'));
    const spec = stdlibFunctionById(id);
    return builtinAnswer(wire, () => (spec !== undefined ? applyStdlib(spec, values, now) : applyMovementFunction(id, values)));
  },
  /** The shared comparator, likewise. A `WITHIN` measures from `now`, the
   *  host clock's answer the engine asked for it. */
  async 'builtins.compare'(request, { wire }) {
    const op = filterOperator(request.op);
    const left = wire.read(request.left);
    const right = wire.read(request.right);
    if ((op === 'within') !== (request.now !== undefined)) {
      throw new RustShimError('builtins.compare carries `now` for a WITHIN, and only for one');
    }
    const now = op === 'within' ? new Date(instant(request.now, 'builtins.compare now')).getTime() : undefined;
    return builtinAnswer(wire, () => compareValues(left, op, right, now !== undefined ? { now } : {}));
  },
};

/** Every route's path: each an `EngineHost` method or one of
 *  `ENGINE_OWN_ROUTES`, which the seam guard holds. */
export function shimRoutePaths(): string[] {
  return Object.keys(ROUTES);
}

/** The segment a forwarded request names (`serve` has held it to the one
 *  the run host opened). */
function segmentOf(request: Record<string, unknown>): string {
  return string(request.segmentId, 'a host request segmentId');
}

/** An adapter call's one argument object. The engine builds each method's
 *  (crates/movement-engine/src/write.rs, run.rs) as the TypeScript engine
 *  does; what the shim can hold it to here is that it is one object, and the
 *  host's adapter reads it as its protocol `params`. */
/** An event as the engine hands it back: the run's own, off the wire. */
function isTriggerEvent(value: unknown): value is TriggerEvent {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'adapterType') === 'string' && typeof Reflect.get(value, 'triggerType') === 'string';
}

function isCallArgs(value: unknown): value is AdapterCall['args'] {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A call whose position the engine sent by handle: `positionRef` numbers a
 * position of the segment's, and `position` (on the eval wire) registers it
 * the first time. The adapter receives `{position, ...args}` — the position
 * leads every argument object that has one (`getFieldValue`, `getRelated`,
 * `iterateRelatedPage`), so the key order is the TypeScript engine's. Read
 * before the call awaits anything, so a registration and a call naming it
 * that are in flight together are served in the order the engine made them.
 */
function withPosition(request: Record<string, unknown>, rest: AdapterCall['args'], positions: Map<number, unknown>, wire: WireOut): AdapterCall['args'] {
  const reference = request.positionRef;
  if (reference === undefined) return rest;
  if (typeof reference !== 'number' || !Number.isInteger(reference)) throw new RustShimError('adapters.call positionRef is an integer');
  if (request.position !== undefined) {
    if (positions.has(reference)) throw new RustShimError(`adapters.call registered position ${reference} twice`);
    positions.set(reference, wire.read(request.position));
  }
  if (!positions.has(reference)) throw new RustShimError(`adapters.call named position ${reference}, which was never registered`);
  const position = positions.get(reference);
  const args = { position, ...rest };
  if (!isCallArgs(args)) throw new RustShimError('adapters.call args are one object');
  return args;
}

function adapterMethod(value: unknown): AdapterMethod {
  const method = ADAPTER_METHODS.find((m) => m === value);
  if (method === undefined) throw new RustShimError(`adapters.call method ${JSON.stringify(value)} is not an adapter method`);
  return method;
}

function budgetOf(value: unknown): { remainingMicrodollars: number | null } {
  const remaining = record(value, 'a priced call budget').remainingMicrodollars;
  if (remaining !== null && (typeof remaining !== 'number' || !Number.isFinite(remaining))) {
    throw new RustShimError('a budget is {remainingMicrodollars: number | null}');
  }
  return { remainingMicrodollars: remaining };
}

function microdollars(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RustShimError(`${what} is a finite number`);
  return value;
}

/** A method the engine asked of a host that does not serve it: the engine
 *  asks an optional one only where the segment input says it is served. */
function notServed(path: string): RustShimError {
  return new RustShimError(`the engine asked ${path} of a host that does not serve it`);
}

/** The parked state's own fields, as the engine writes them; the rest is
 *  the engine's to read back. */
function isParkedState(value: unknown): value is ParkedScopeState {
  if (typeof value !== 'object' || value === null) return false;
  return (
    Reflect.get(value, 'version') === 1
    && typeof Reflect.get(value, 'address') === 'string'
    && Array.isArray(Reflect.get(value, 'scopeChain'))
  );
}

function count(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new RustShimError(`${what} is a count`);
  return value;
}

function instant(value: unknown, what: string): string {
  const text = string(value, what);
  if (Number.isNaN(new Date(text).getTime())) throw new RustShimError(`${what} is not an ISO 8601 instant`);
  return text;
}

/**
 * A host's answer on the eval wire, as the engine reads it. A member the wire
 * cannot carry as itself (a reply's `__proto__` key or lone surrogate, both of
 * which `JSON.parse` can make) is left out and named under `uncarried`: the
 * call was made and charged, so the engine decides what an unreadable answer
 * means for the run, never the shim. The cost and every other member cross.
 */
function wired(wire: WireOut, answer: object, method: string, members: readonly string[]): unknown {
  // Tried apart first: what goes out on the segment's wire is what the
  // engine reads, every id it names included.
  const carries = (value: unknown) => new WireOut().value(value) !== REFUSED;
  if (carries(answer)) return wire.value(answer);
  const kept: Record<string, unknown> = {};
  const uncarried: string[] = [];
  for (const [key, value] of Object.entries(answer)) {
    if (members.includes(key) && !carries(value)) uncarried.push(key);
    else kept[key] = value;
  }
  const value = { ...kept, uncarried };
  if (!carries(value)) throw new RustShimError(`${method} answered a value the eval wire cannot carry as itself`);
  return wire.value(value);
}

function isEffort(value: string): value is Effort {
  return EFFORTS.some((effort) => effort === value);
}

/** The models a call names: the built-in aliases, or a logical model a
 *  deployment's tier assignment chose (`TierModel`). */
function extractionModel(value: unknown): TierModel {
  switch (value) {
    case 'opus':
    case 'opus5':
    case 'sonnet':
    case 'haiku':
      return value;
    default:
      if (typeof value === 'string' && isModelName(value) && hasCapability(value, 'chat')) return value;
      throw new RustShimError(`llm.client.call model ${JSON.stringify(value)} is not a model a call names`);
  }
}

function wiredRecord(wire: WireOut, value: unknown, what: string): Record<string, unknown> {
  const read = wire.read(value);
  if (typeof read !== 'object' || read === null || Array.isArray(read)) throw new RustShimError(`${what} is an object`);
  return Object.fromEntries(Object.entries(read));
}

function isUniquenessConstraints(value: unknown): value is UniquenessConstraints {
  if (typeof value !== 'object' || value === null) return false;
  const any: unknown = Reflect.get(value, 'any');
  return Array.isArray(any) && any.every((branch) => typeof branch === 'object' && branch !== null && Array.isArray(Reflect.get(branch, 'all')));
}

function lockNames(request: Record<string, unknown>): string[] {
  const names = request.names;
  if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) {
    throw new RustShimError('locks.acquire names are a list of texts');
  }
  return names;
}

export async function serve(request: HostRequest, context: RouteContext): Promise<HostAnswer> {
  const label = `${request.family}.${request.method}`;
  const route = Object.hasOwn(ROUTES, label) ? ROUTES[label] : undefined;
  if (route === undefined) throw new RustShimError(`the shim has no route for ${label}`);
  rustRunStats.hostCalls[label] = (rustRunStats.hostCalls[label] ?? 0) + 1;
  const args = record(request.args, label);
  // Every request bound for the host names the segment the run host opened
  // for this engine: it has no other.
  if (!Object.hasOwn(ENGINE_OWN_ROUTES, label) && args.segmentId !== context.context.segmentId) {
    throw new RustShimError(`${label} named segment ${String(args.segmentId)}, not this engine's ${context.context.segmentId}`);
  }
  let value: unknown;
  try {
    value = await route(args, context);
  } catch (error) {
    if (error instanceof RustShimError) throw error;
    if (error instanceof RunAborted) throw error.abortedWith;
    // The host's own failure: the engine decides what it means for the run.
    // The error itself stays here, under the `ref` its answer carries, so a
    // run that fails with it fails with this very object.
    context.hostErrors.push(error);
    return { error: { ...errorAnswer(error), ref: context.hostErrors.length - 1 } };
  }
  if (value instanceof Plain) return { value: value.json };
  return value === undefined ? {} : { value: plainJson(value, adapterCallName(request) ?? label) };
}

/** A route's answer that is already the JSON to send (an eval-wire value
 *  inside it). */
class Plain {
  constructor(readonly json: unknown) {}
}

/** `{value: wire}` or `{threw: {class, code?, message}}`. */
function builtinAnswer(segment: WireOut, run: () => unknown): unknown {
  let value: unknown;
  try {
    value = run();
  } catch (error) {
    if (error instanceof MovementEngineError) return { threw: { class: 'MovementEngineError', code: error.code, message: unprefixed(error) } };
    if (error instanceof RangeError) return { threw: { class: 'RangeError', message: error.message } };
    if (error instanceof TypeError) return { threw: { class: 'TypeError', message: error.message } };
    if (error instanceof Error && error.constructor === Error) return { threw: { class: 'Error', message: error.message } };
    throw new RustShimError(`a built-in threw what the Rust engine cannot rethrow: ${String(error)}`);
  }
  if (new WireOut().value(value) === REFUSED) throw new RustShimError('a built-in answered a value the eval wire cannot carry as itself');
  return { value: segment.value(value) };
}

/** A MovementEngineError's message without the `CODE: ` its constructor adds. */
function unprefixed(error: MovementEngineError): string {
  const prefix = `${error.code}: `;
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

function filterOperator(value: unknown): FilterOperator {
  switch (value) {
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'exists':
    case 'in':
    case 'contains':
    case 'within':
      return value;
    default:
      throw new RustShimError(`builtins.compare op ${JSON.stringify(value)} is not an operator`);
  }
}

/** The trace entry kinds the Rust engine appends (crates/movement-engine/src/trace.rs). */
function traceEntry(value: unknown): MovementRunResult['trace'][number] {
  const entry = record(value, 'trace.append entry');
  switch (entry.kind) {
    case 'gate':
      if (typeof entry.outcome !== 'boolean') throw new RustShimError('a gate trace entry has a boolean outcome');
      return { kind: 'gate', outcome: entry.outcome };
    case 'warning':
      return { kind: 'warning', code: string(entry.code, 'a warning code'), message: string(entry.message, 'a warning message') };
    case 'block': {
      const positions = entry.positions;
      if (typeof positions !== 'number' || !Number.isInteger(positions)) throw new RustShimError('a block trace entry counts its positions');
      return { kind: 'block', root: string(entry.root, 'a block root'), positions };
    }
    case 'read':
      return readTraceEntry(entry);
    case 'ai':
      if (typeof entry.hasValue !== 'boolean') throw new RustShimError('an ai trace entry says whether the model answered');
      return { kind: 'ai', prompt: string(entry.prompt, 'an ai prompt'), hasValue: entry.hasValue };
    case 'extraction':
      return extractionTraceEntry(entry);
    case 'plugin':
      return pluginTraceEntry(entry);
    case 'field_miss': {
      const available = entry.available;
      if (!Array.isArray(available) || !available.every((key) => typeof key === 'string')) {
        throw new RustShimError('a field_miss trace entry lists its available keys');
      }
      return {
        kind: 'field_miss',
        binding: string(entry.binding, 'a field_miss binding'),
        field: string(entry.field, 'a field_miss field'),
        available,
      };
    }
    default:
      throw new RustShimError(`the Rust engine appended a trace entry this shim does not know: ${String(entry.kind)}`);
  }
}

type ExtractionTraceEntry = Extract<MovementRunResult['trace'][number], { kind: 'extraction' }>;
type PluginTraceEntry = Extract<MovementRunResult['trace'][number], { kind: 'plugin' }>;

const counts = z.record(z.string(), z.number());
const pluginOutcome = z.object({ plugin: z.string(), outcome: z.enum(['skipped', 'empty', 'dropped']) });
const tracedFile = z.union([
  z.object({ name: z.string().optional(), contentType: z.string().optional(), chars: z.number(), truncatedFrom: z.number().optional() }),
  z.object({
    name: z.string().optional(),
    contentType: z.string().optional(),
    unreadable: z.enum(['unsupported_type', 'bytes_unavailable', 'extraction_failed', 'no_text']),
    detail: z.string().optional(),
  }),
]);

type ReadTraceEntry = Extract<MovementRunResult['trace'][number], { kind: 'read' }>;

/** A `READ(file)`'s trace entry: the file as an extraction's entry names it. */
function readTraceEntry(entry: Record<string, unknown>): ReadTraceEntry {
  const { kind: _kind, ...file } = entry;
  const parsed = tracedFile.safeParse(file);
  if (!parsed.success) throw new RustShimError(`a read trace entry does not read: ${parsed.error.message}`);
  return { kind: 'read', ...parsed.data };
}

/** An extraction's trace entry as crates/movement-engine/src/extract/run.rs
 *  writes it, held to expression.ts's type member by member. */
const extractionTraceEntrySchema: z.ZodType<ExtractionTraceEntry> = z.strictObject({
  kind: z.literal('extraction'),
  node: z.string().optional(),
  inputChars: z.number(),
  inputs: z.array(z.object({ classification: z.string(), chars: z.number() })).optional(),
  inputsTruncated: z.number().optional(),
  files: z.array(tracedFile).optional(),
  filesTruncated: z.number().optional(),
  model: z.string().optional(),
  durationMs: z.number().optional(),
  effortSteppedDown: z.object({ from: z.string(), to: z.string() }).optional(),
  continued: z.literal(true).optional(),
  continuations: z.number().optional(),
  skipped: z.enum(['empty_source', 'no_enrichment']).optional(),
  plugins: z.array(pluginOutcome).optional(),
  failed: z.literal('invalid_reply').optional(),
  fallback: z.literal('kept_previous_stage').optional(),
  retried: z.array(z.string()).optional(),
  reply: z
    .object({
      why: z.array(z.enum(['no_entities', 'dropped_records', 'retried', 'failed'])),
      keys: z.array(z.string()),
      sample: z.string(),
      path: z.string().optional(),
    })
    .optional(),
  emissions: counts,
  empty: counts.optional(),
  dropped: counts.optional(),
  coerced: z.record(z.string(), z.array(z.string())).optional(),
  evidenceCoerced: z.record(z.string(), z.array(z.string())).optional(),
  envelopeRepaired: z.string().optional(),
  entities: z.record(z.string(), z.array(z.object({ fields: z.record(z.string(), z.string().nullable()) }))).optional(),
  truncatedCount: counts.optional(),
});

/** A plugin's trace entry, likewise. */
const pluginTraceEntrySchema: z.ZodType<PluginTraceEntry> = z.strictObject({
  kind: z.literal('plugin'),
  plugin: z.string(),
  node: z.string().optional(),
  url: z.string().optional(),
  durationMs: z.number(),
  chars: z.number().optional(),
  fields: z.array(z.string()).optional(),
  skippedParam: z.string().optional(),
  outcome: z.string().optional(),
  returned: z.enum(['value', 'absent']).optional(),
});

/** The entry as the engine wrote it, in its own key order (a parse would
 *  rebuild it in the schema's), once the schema has read it whole. */
function isExtractionTraceEntry(entry: Record<string, unknown>): entry is ExtractionTraceEntry {
  return extractionTraceEntrySchema.safeParse(entry).success;
}

function isPluginTraceEntry(entry: Record<string, unknown>): entry is PluginTraceEntry {
  return pluginTraceEntrySchema.safeParse(entry).success;
}

function extractionTraceEntry(entry: Record<string, unknown>): ExtractionTraceEntry {
  if (!isExtractionTraceEntry(entry)) {
    throw new RustShimError(`an extraction trace entry has the shape the engine writes: ${extractionTraceEntrySchema.safeParse(entry).error?.message}`);
  }
  return entry;
}

function pluginTraceEntry(entry: Record<string, unknown>): PluginTraceEntry {
  if (!isPluginTraceEntry(entry)) {
    throw new RustShimError(`a plugin trace entry has the shape the engine writes: ${pluginTraceEntrySchema.safeParse(entry).error?.message}`);
  }
  return entry;
}

function adapterCallName(request: HostRequest): string | undefined {
  if (request.family !== 'adapters' || request.method !== 'call') return undefined;
  const args = request.args;
  const method = typeof args === 'object' && args !== null ? Reflect.get(args, 'method') : undefined;
  return typeof method === 'string' ? `adapters.call ${method}` : undefined;
}

function errorAnswer(error: unknown): { message: string; name?: string } {
  if (error instanceof Error) return { message: error.message, name: error.name };
  return { message: String(error) };
}

