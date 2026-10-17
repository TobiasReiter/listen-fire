// A run host backend another process serves: every family of `RunHostStore`
// (store.ts) forwarded over the process's stdin/stdout, one JSON-RPC 2.0
// message per line. It is how the contract suite (contract.ts), written once
// in TypeScript, holds a backend in another language to the same meaning —
// `lf-host --contract-store <state.db>` (crates/lf-host) first.
//
// A method is `<family>.<method>` as `RunHostStore` names it, its params the
// method's one input object, its result the method's answer. The server's
// `RunLeaseLost` error (data.name) is rethrown as the core's `RunLeaseLost`,
// so the rules over the store see the one refusal they handle. Beside the
// live state, the callback family (`callbacks.*`) and the run records
// (`runs.*`) are forwarded the same way, for the callback and cancel cases.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { CALLBACK_PARAM_TYPES } from 'engine-contracts';
import { RunLeaseLost } from '../movement_engine/errors';
import type { RunRecords } from './rules';
import type { CallbackRecord, CallbackStore, ClaimedWork, RunHostStore } from './store';

// The error branch first: `result: z.unknown()` also accepts a reply without one.
const Reply = z.union([
  z.object({
    id: z.number().nullable(),
    error: z.object({
      code: z.number(),
      message: z.string(),
      data: z.object({ name: z.string(), runId: z.string().optional() }).optional(),
    }),
  }),
  z.object({ id: z.number(), result: z.unknown() }),
]);

const Nothing = z.null();
const Leaf = z.object({
  address: z.string(),
  reason: z.string(),
  status: z.enum(['parked', 'resuming']),
  wakeAt: z.string().nullable(),
});
const Claimed = z.object({ reason: z.string(), state: z.unknown() }).nullable();
const Correlated = z.object({ runId: z.string(), teamId: z.string(), address: z.string() });
const Work = z.object({ id: z.string(), kind: z.string(), key: z.string(), payload: z.unknown(), claim: z.string() });
const Callback = z.object({
  id: z.string(),
  teamId: z.string(),
  runId: z.string(),
  address: z.string(),
  params: z.array(z.object({ name: z.string(), type: z.enum(CALLBACK_PARAM_TYPES) })),
  state: z.unknown(),
  calls: z.array(z.object({ at: z.string(), values: z.record(z.string(), z.unknown()), bodyStartedAt: z.string().optional() })),
  singleUse: z.boolean(),
  expiresAt: z.string().nullable(),
  status: z.enum(['live', 'fired', 'revoked']),
});
const Claim = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('recorded'), callback: Callback, callIndex: z.number().int() }),
  z.object({ kind: z.literal('not_found') }),
  z.object({ kind: z.literal('closed'), callback: Callback }),
  z.object({ kind: z.literal('expired'), callback: Callback }),
]);

/** A wire callback as the family's record: `state` is required there, and
 *  `unknown` parses as optional. */
function callbackOf(parsed: z.infer<typeof Callback>): CallbackRecord {
  return { ...parsed, state: parsed.state };
}

/** The work claim the server reads: no more than it needs, whatever the caller spreads in. */
function claimOf(work: ClaimedWork & { dueAt?: string }): Record<string, unknown> {
  return { id: work.id, kind: work.kind, key: work.key, claim: work.claim, ...(work.dueAt !== undefined ? { dueAt: work.dueAt } : {}) };
}

export class RpcStoreBackend {
  readonly store: RunHostStore;
  readonly callbacks: CallbackStore;
  /** The run records over the same file, `closeRun` revoking the run's callbacks. */
  readonly runs: RunRecords;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private exited: Error | undefined;

  constructor(command: string, args: readonly string[]) {
    this.child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stderr: string[] = [];
    this.child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
    createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line));
    this.child.on('exit', (code) => {
      this.exited = new Error(`the store process exited (${code})${stderr.length > 0 ? `: ${stderr.join('').trim()}` : ''}`);
      for (const waiter of this.waiting.values()) waiter.reject(this.exited);
      this.waiting.clear();
    });
    this.store = this.families();
    this.callbacks = this.callbackFamily();
    this.runs = {
      cancelRequest: (input) => this.call('runs.cancelRequest', input, z.object({ reason: z.string().nullable() }).nullable()),
      markFailed: async (input) => {
        await this.call('runs.markFailed', input, Nothing);
      },
      closeRun: async (input) => {
        await this.call('runs.closeRun', input, Nothing);
      },
    };
  }

  /** One call; its result read by `schema`. */
  async call<S extends z.ZodType>(method: string, params: object, schema: S): Promise<z.infer<S>> {
    if (this.exited !== undefined) throw this.exited;
    const id = this.nextId++;
    const result = await new Promise<unknown>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    const parsed = schema.safeParse(result);
    if (!parsed.success) throw new Error(`${method} answered ${JSON.stringify(result)}: ${parsed.error.issues[0]?.message}`);
    return parsed.data;
  }

  /** A run row the backend can park against (the contract's `newRun`). */
  async startRun(input: { id: string; file: string; movement: string; startedAt: string; input: string }): Promise<void> {
    await this.call('runs.start', input, Nothing);
  }

  /** An operator asks to cancel the run (the contract's `requestCancel`). */
  async requestCancel(input: { runId: string; reason: string | null }): Promise<void> {
    await this.call('runs.requestCancel', input, Nothing);
  }

  /** The run's status as its row holds it, or `missing`. */
  runStatus(runId: string): Promise<string> {
    return this.call('runs.status', { runId }, z.string());
  }

  /** Settle the run completed, as the host does when a run ends. */
  async completeRun(runId: string): Promise<void> {
    await this.call('runs.complete', { runId }, Nothing);
  }

  /** End the process: its stdin closes, and it exits once it has answered. */
  async close(): Promise<void> {
    if (this.exited !== undefined) return;
    const exited = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    this.child.stdin.end();
    await exited;
  }

  private receive(line: string): void {
    let reply: z.infer<typeof Reply>;
    try {
      reply = Reply.parse(JSON.parse(line));
    } catch {
      for (const waiter of this.waiting.values()) waiter.reject(new Error(`the store process answered what is not a reply: ${line}`));
      this.waiting.clear();
      return;
    }
    if (reply.id === null) return;
    const waiter = this.waiting.get(reply.id);
    if (waiter === undefined) return;
    this.waiting.delete(reply.id);
    if (!('error' in reply)) {
      waiter.resolve(reply.result ?? null);
    } else if (reply.error.data?.name === 'RunLeaseLost') {
      waiter.reject(new RunLeaseLost(reply.error.data.runId ?? ''));
    } else {
      waiter.reject(new Error(reply.error.message));
    }
  }

  private callbackFamily(): CallbackStore {
    const call = this.call.bind(this);
    return {
      mint: (input) => call('callbacks.mint', input, z.object({ id: z.string() })),
      get: async (input) => {
        const got = await call('callbacks.get', input, Callback.nullable());
        return got === null ? null : callbackOf(got);
      },
      record: async (input) => {
        const claim = await call('callbacks.record', input, Claim);
        return claim.kind === 'not_found' ? claim : { ...claim, callback: callbackOf(claim.callback) };
      },
      markBodyStarted: (input) => call('callbacks.markBodyStarted', input, z.boolean()),
      landed: (input) => call('callbacks.landed', input, z.array(z.string())),
      revokeRun: async (input) => {
        await call('callbacks.revokeRun', input, Nothing);
      },
    };
  }

  private families(): RunHostStore {
    const call = this.call.bind(this);
    return {
      parks: {
        putLeaf: async (input) => {
          await call('parks.putLeaf', input, Nothing);
        },
        claimLeaf: (input) => call('parks.claimLeaf', input, Claimed),
        finishLeaf: async (input) => {
          await call('parks.finishLeaf', input, Nothing);
        },
        leaves: (input) => call('parks.leaves', input, z.array(Leaf)),
        deleteLeaves: async (input) => {
          await call('parks.deleteLeaves', input, Nothing);
        },
      },
      joins: {
        recordJoin: async (input) => {
          await call('joins.recordJoin', input, Nothing);
        },
        decrementJoin: (input) => call('joins.decrementJoin', input, z.object({ closed: z.boolean() })),
        persistBranchExport: async (input) => {
          await call('joins.persistBranchExport', input, Nothing);
        },
        collectBranchExports: (input) =>
          call('joins.collectBranchExports', input, z.array(z.object({ branchAddress: z.string(), branchIndex: z.number(), exports: z.unknown() }))),
        hasPendingJoins: (input) => call('joins.hasPendingJoins', input, z.boolean()),
        frames: (input) => call('joins.frames', input, z.array(z.string())),
        deleteFrames: async (input) => {
          await call('joins.deleteFrames', input, Nothing);
        },
      },
      correlations: {
        correlate: async (input) => {
          await call('correlations.correlate', input, Nothing);
        },
        correlated: (input) => call('correlations.correlated', input, z.array(Correlated)),
        ofRun: (input) => call('correlations.ofRun', input, z.array(Correlated.extend({ correlationKey: z.string() }))),
        drop: async (input) => {
          await call('correlations.drop', input, Nothing);
        },
        dropRun: async (input) => {
          await call('correlations.dropRun', input, Nothing);
        },
      },
      leases: {
        claim: (input) => call('leases.claim', input, z.object({ token: z.string() }).nullable()),
        renew: (input) => call('leases.renew', input, z.boolean()),
        release: async (input) => {
          await call('leases.release', input, Nothing);
        },
        dropRunState: (input) => call('leases.dropRunState', input, z.boolean()),
      },
      work: {
        enqueue: async (input) => {
          await call('work.enqueue', input, Nothing);
        },
        claimDue: (input) => call('work.claimDue', input, z.array(Work)),
        complete: async (work) => {
          await call('work.complete', claimOf(work), Nothing);
        },
        release: async (work) => {
          await call('work.release', claimOf(work), Nothing);
        },
      },
      sources: {
        put: async (input) => {
          await call('sources.put', input, Nothing);
        },
        get: (input) => call('sources.get', input, z.string().nullable()),
      },
    };
  }
}
