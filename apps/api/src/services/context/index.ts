import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import EventEmitter from 'node:events';

import * as db from '@prisma/client';
import { Kysely, sql } from 'kysely';
import { maybePrincipal, runWithPrincipalSync, type Principal } from 'principal';

import { prismaClient, prismaReadonlyClient } from '../../prisma';
import { Dataloaders, getDataloaders } from '../../lib/datasources/dataloaders';
import { DEFAULT_TRANSACTION_TIMEOUT } from '../../constants';
import { globalQb } from '../../lib/kysely';
import { sessionContextArgs as coreSessionContextArgs } from '../../lib/core/session';
import { sessionContextArgs } from '../../lib/valuations/session';
import { sessionContextArgs as knowledgeSessionContextArgs } from '../../lib/knowledge/session';
import { sessionContextArgs as automationsSessionContextArgs } from '../../lib/automations/session';
import { readContextIdFrom } from 'movement-engine/public/log';
/**
 * The identity surface the residual Context still exposes (C-10). It is now a
 * PROJECTION of the ambient Principal, not a second copy of it: there is one
 * source of identity in the process, and `ctx.user` is a spelling of it that
 * the ~100 files still reading the Context have not yet been swept off.
 *
 * Nothing writes it. That is what retired `assertPrincipalAgrees` — two
 * writable copies of an identity is a drift class, and the fix was to stop
 * having two rather than to keep asserting they match.
 */
interface UserContext {
  id: string;
  teamId: string;
  /**
   * The team the authenticating api key is pinned to (`api_key.team_id`), or
   * `null` when the key is user-anchored (spans the user's memberships) — and
   * for cookie/session requests, which are never pinned. The MCP team-scoping
   * tools read this to decide whether a `team` argument is allowed.
   */
  pinnedTeamId?: string | null;
  isTeamReadonly?: boolean;
  apiKeyId?: string;
  /** The scopes minted on the authenticating api key, when there is one. A
   *  session request has no narrower surface than the user's own, so this is
   *  absent rather than a wildcard — the Principal supplies '*' there. */
  apiKeyScopes?: readonly string[];
}

interface ClsStorage {
  id: string;
  user?: UserContext;
  skipAuditLogging?: boolean;
  prisma?: db.Prisma.TransactionClient;
  isReadonlyPrisma: boolean;
}

const asyncLocalStorage = new AsyncLocalStorage<Context>();
readContextIdFrom(() => asyncLocalStorage.getStore()?.id);

/**
 * Context
 *
 * Events:
 * - 'end' - cleanup has been triggered and the context is closing successfully
 * - 'close' - cleanup has finished and the context is fully closed
 * - 'error' - an error has occurred within the context, and it will now start cleaning up
 *
 * - 'end_txn' - manually exit a prisma transaction attached to this context
 */
class Context extends EventEmitter implements ClsStorage {
  id: string;
  xRequestId?: string;
  /** The client TAB that issued this request — stamped onto resource-change
   *  events so a tab can ignore the changes it made itself. Cleared for
   *  agent background work (the requesting tab DOES want to see those). */
  originId?: string;
  /** The `X-Mcp-Domain` header this request carried, if any (e.g.
   *  'automation'), stamped once by the auth middleware from the header it
   *  already reads. Records what the request WAS — plain, un-gated — so any
   *  consumer can apply its own gating decision (e.g. `saveMovement` uses it
   *  to keep the user journey's `first_automation_saved` MCP-only for
   *  monotonicity; see plans/2026-07-16-journey-instrumentation/design.md). */
  mcpDomain?: string;
  skipAuditLogging?: boolean;
  isReadonlyPrisma = true;

  /**
   * Bootstrap work that must write with no tenant to be scoped to: the CLI that
   * creates the very first team and user. It used to say this by setting
   * `adminAbilities()`, which chose the writable pool as a side effect of a rule
   * set — so "I need to write" and "I may do anything" were the same sentence,
   * and deleting the ability layer would have silently made every one of those
   * contexts read-only (the 4.2 addendum's blocker (a)).
   */
  private _systemWritable: boolean;

  private _prisma!: db.Prisma.TransactionClient;
  private _dataloaders!: Dataloaders;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _kyselyTrx?: Kysely<any>;

  private cleanups: Promise<void>[] = [];

  constructor(
    opts: {
      xRequestId?: string;
      originId?: string;
      /** Bootstrap work that writes before any tenant exists — the CLI that
       *  creates the first team and user, and nothing else. */
      systemWritable?: boolean;
    } = {},
  ) {
    super();
    this.id = opts.xRequestId ?? randomUUID();
    this.originId = opts.originId;
    this._systemWritable = opts.systemWritable ?? false;

    this.selectConnection();
  }

  /**
   * Which pool this Context reads and writes through. A `write` principal gets
   * the writable one; a read-only membership, or no identity at all, gets the
   * readonly one. That is the whole rule — the ability no longer has a say
   * (D15), and `access` comes from `team_membership` where the Principal is
   * minted (D44b).
   */
  private selectConnection() {
    this.isReadonlyPrisma =
      !this._systemWritable && this.actingPrincipal?.access !== 'write';
    this.prisma = this.isReadonlyPrisma ? prismaReadonlyClient : prismaClient;
  }

  /**
   * THE database client. There used to be two — an `AuthorizedPrismaClient`
   * that rewrote every query's WHERE from a CASL ability, and the plain one
   * underneath it for the paths that deliberately opted out. With the ability
   * layer gone there is one client and one name for it; scoping is said at the
   * call site now, where a reader can see it (D15/D48d).
   */
  set prisma(prisma: db.Prisma.TransactionClient) {
    this._prisma = prisma;
    this.dataloaders = getDataloaders(prisma);
  }
  get prisma() {
    return this._prisma;
  }

  get dataloaders() {
    return this._dataloaders;
  }
  set dataloaders(dataloaders: Dataloaders) {
    this._dataloaders = dataloaders;
  }

  /** is the context usable? */
  private closed = false;

  get isClosed() {
    return this.closed;
  }

  /**
   * The identity this Context acts as, read from the ambient Principal and
   * falling back to the one parked on the Context itself — which is how the
   * websocket works: tRPC calls `authorise()` lazily, outside any ambient
   * store, so it parks the Principal here and the protected procedure makes it
   * ambient for the call it wraps.
   */
  private get actingPrincipal(): Principal | undefined {
    return maybePrincipal() ?? this._principal;
  }

  /** The acting identity, in the shape the not-yet-swept readers expect. */
  get user(): UserContext {
    const principal = this.actingPrincipal;
    if (principal?.userId === undefined) {
      throw new Error('Missing user');
    }
    return {
      id: principal.userId,
      teamId: principal.teamId,
      pinnedTeamId: principal.pinnedTeamId,
      isTeamReadonly: principal.access === 'read',
      apiKeyId: principal.credentialId,
      apiKeyScopes: principal.credentialId === undefined ? undefined : principal.scopes,
    };
  }

  /**
   * Park the Principal on this Context, for the one caller that establishes an
   * identity outside the ambient store (the websocket's lazy `authorise`).
   * Nothing derives an identity FROM the Context any more, so there is nothing
   * left for the two to disagree about.
   */
  bindPrincipal(principal: Principal) {
    this._principal = principal;
    // A Context is built before the request is authenticated, so this is where
    // the acting identity — and therefore the connection it may write through —
    // becomes known.
    this.selectConnection();
  }

  get principal(): Principal | undefined {
    return this.actingPrincipal;
  }

  private _principal?: Principal;

  get authenticated() {
    return this.actingPrincipal?.userId !== undefined;
  }

  /** instigate successful destruction of the context */
  async end() {
    this.emit('end');
    await this.cleanup();
  }

  /**
   * Instigate destruction of the context due to an error.
   *
   * 'error' is documented above as a passive notification, but `EventEmitter`
   * special-cases that event name: emitting it with no listener attached
   * throws the value synchronously instead of doing nothing, which — inside
   * this `async` method — becomes a rejected promise. Most callers (e.g.
   * `contextInjector`'s `req.on('error', (err) => ctx.error(err))`) don't
   * await or catch that promise, so a Context with nothing actively listening
   * (any request outside an open DB transaction) turned every aborted
   * request into an unhandled rejection. Only emit when someone is actually
   * listening; cleanup always runs either way.
   */
  async error(err: unknown) {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
    await this.cleanup();
  }

  /** wait for any active resources to close */
  async cleanup() {
    this.closed = true;
    const cleanups = this.cleanups;
    this.cleanups = [];
    await Promise.all(cleanups);
    this.emit('close');
    this.removeAllListeners();
  }

  /** a promise that resolves whenever the named event is emitted and rejects on error */
  waitForEvent<T extends string>(event: T) {
    return new Promise<T>((resolve, reject) => {
      this.on(event, () => {
        resolve(event);
      });
      this.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * A Context's run scope acts as whatever identity was parked on it. This is
   * how the non-request establishers — a dev script, a worker, an inbound
   * channel door, an integration test — install an ambient Principal without
   * each of them having to remember to (C-10). An outer ambient Principal
   * always wins: nesting must not silently re-attribute the work.
   */
  private asPrincipal<T>(fn: () => T): T {
    const parked = this._principal;
    if (parked === undefined || maybePrincipal() !== undefined) {
      return fn();
    }
    return runWithPrincipalSync(parked, fn);
  }

  /** runs a synchronous function, waiting for the context to be closed before continuing */
  async run<T>(fn: () => T) {
    // this listener is registered first in case fn
    // calls "close" synchronously
    const closeListener = this.waitForEvent('close');

    const run = asyncLocalStorage.run(this, () => this.asPrincipal(fn));

    await closeListener;

    return run;
  }

  /** runs an async function, closing the context after the function has finished */
  async runAsync<T>(fn: () => Promise<T>) {
    try {
      const result = await asyncLocalStorage.run(this, () => this.asPrincipal(fn));
      await this.end();
      return result;
    } catch (err) {
      await this.error(err);
      throw err;
    }
  }

  /** enter a prisma + kysely transaction pair, returning once both are entered */
  async enterTransaction() {
    if (this.isClosed) {
      throw new Error('Context is closed');
    }

    const originalPrisma = this.prisma;

    // unauthenticated is automatically read-only
    // TODO: review - users will need to be able to sign up
    const dbClient = this.isReadonlyPrisma ? prismaReadonlyClient : prismaClient;
    // Attribution for the five schemas' audit GUCs. A machine principal has no
    // user, and so did an unauthenticated Context before C-10 — both take the
    // context-id-only branch below, unchanged.
    const acting = this.actingPrincipal;
    const user =
      acting?.userId === undefined ? undefined : { id: acting.userId, teamId: acting.teamId };
    const apiKeyId = acting?.credentialId;

    const prismaEntered = new Promise<void>((resolve, reject) => {
      const txnResult = dbClient
        .$transaction(
          async (prisma) => {
            if (user) {
              const [vTeamId, vActorType, vActorId, vContextId] = sessionContextArgs({
                teamId: user.teamId,
                userId: user.id,
                apiKeyId,
                contextId: this.id,
              });
              await prisma.$executeRaw`
              SELECT set_current_user_id(${user.id}),
                set_current_team_id(${user.teamId}),
                set_current_context_id(${this.id}),
                set_current_api_key_id(${apiKeyId ?? ''})
            `;
              // V-17: the valuations unit reads its own GUCs, so that its audit
              // trail and outbox attribution survive without core.
              await prisma.$executeRaw`
              SELECT valuations.set_session_context(${vTeamId}, ${vActorType}, ${vActorId}, ${vContextId})
            `;
              // Core owns its own set for the same reason: its audit trail is
              // in `core.audit_log`, and standalone there is no `public` schema
              // to read `core.current_*` from (D35(c)).
              const [cTeamId, cActorType, cActorId, cContextId] = coreSessionContextArgs({
                teamId: user.teamId,
                userId: user.id,
                apiKeyId,
                contextId: this.id,
              });
              await prisma.$executeRaw`
              SELECT core.set_session_context(${cTeamId}, ${cActorType}, ${cActorId}, ${cContextId})
            `;
              // Knowledge reads its own too: its audit trail is in
              // `knowledge.audit_log` and its thirteen agent policies tenant on
              // `knowledge.current_team_id()` (D37(h)).
              const [kTeamId, kActorType, kActorId, kContextId] = knowledgeSessionContextArgs({
                teamId: user.teamId,
                userId: user.id,
                apiKeyId,
                contextId: this.id,
              });
              await prisma.$executeRaw`
              SELECT knowledge.set_session_context(${kTeamId}, ${kActorType}, ${kActorId}, ${kContextId})
            `;
              // And automations, the last of the four: nine audit triggers and
              // two agent policies of its own to feed (D43(b)).
              const [aTeamId, aActorType, aActorId, aContextId] = automationsSessionContextArgs({
                teamId: user.teamId,
                userId: user.id,
                apiKeyId,
                contextId: this.id,
              });
              await prisma.$executeRaw`
              SELECT automations.set_session_context(${aTeamId}, ${aActorType}, ${aActorId}, ${aContextId})
            `;
            } else {
              await prisma.$executeRaw`SELECT set_current_context_id(${this.id})`;
            }

            // if the context has closed while we're entering the transaction
            if (this.isClosed) {
              resolve();

              // return to exit the transaction immediately
              return;
            }

            this.prisma = prisma;
            this._exitTransaction = () => {
              this.prisma = originalPrisma;
              this._exitTransaction = undefined;
            };
            this.cleanups.push(txnResult);

            // now we're in the transaction, with the current_user_id etc set
            // we can allow the surrounding code to continue
            resolve();

            // end the transaction if the whole context ends
            // or if the transaction is explictly told to end
            const event = await Promise.race([
              this.waitForEvent('end'),
              this.waitForEvent('end_txn'),
              this.waitForEvent('error'),
            ]);
            if (event === 'error' && this._exitTransaction) {
              this._exitTransaction();
              throw new Error('Transaction ended due to error');
            }
          },
          {
            timeout: parseInt(process.env.TRANSACTION_TIMEOUT ?? DEFAULT_TRANSACTION_TIMEOUT),
          },
        )
        .catch((err) => {
          reject(err);
        })
        .finally(() => {
          this._exitTransaction?.();
        });
    });

    const kyselyEntered = new Promise<void>((resolve, reject) => {
      const trxResult = globalQb
        .transaction()
        .execute(async (trx) => {
          if (user) {
            const [vTeamId, vActorType, vActorId, vContextId] = sessionContextArgs({
              teamId: user.teamId,
              userId: user.id,
              apiKeyId,
              contextId: this.id,
            });
            await sql`
              SELECT set_current_user_id(${user.id}),
                set_current_team_id(${user.teamId}),
                set_current_context_id(${this.id}),
                set_current_api_key_id(${apiKeyId ?? ''})
            `.execute(trx);
            // V-17: the valuations unit reads its own GUCs, so that its audit
            // trail and outbox attribution survive without core.
            await sql`
              SELECT valuations.set_session_context(${vTeamId}, ${vActorType}, ${vActorId}, ${vContextId})
            `.execute(trx);
            // Core owns its own set for the same reason: its audit trail is in
            // `core.audit_log`, and standalone there is no `public` schema to
            // read `core.current_*` from (D35(c)).
            const [cTeamId, cActorType, cActorId, cContextId] = coreSessionContextArgs({
              teamId: user.teamId,
              userId: user.id,
              apiKeyId,
              contextId: this.id,
            });
            await sql`
              SELECT core.set_session_context(${cTeamId}, ${cActorType}, ${cActorId}, ${cContextId})
            `.execute(trx);
            // Knowledge reads its own too: its audit trail is in
            // `knowledge.audit_log` and its thirteen agent policies tenant on
            // `knowledge.current_team_id()` (D37(h)).
            const [kTeamId, kActorType, kActorId, kContextId] = knowledgeSessionContextArgs({
              teamId: user.teamId,
              userId: user.id,
              apiKeyId,
              contextId: this.id,
            });
            await sql`
              SELECT knowledge.set_session_context(${kTeamId}, ${kActorType}, ${kActorId}, ${kContextId})
            `.execute(trx);
            // And automations, the last of the four: nine audit triggers and two
            // agent policies of its own to feed (D43(b)).
            const [aTeamId, aActorType, aActorId, aContextId] = automationsSessionContextArgs({
              teamId: user.teamId,
              userId: user.id,
              apiKeyId,
              contextId: this.id,
            });
            await sql`
              SELECT automations.set_session_context(${aTeamId}, ${aActorType}, ${aActorId}, ${aContextId})
            `.execute(trx);
          } else {
            await sql`SELECT set_current_context_id(${this.id})`.execute(trx);
          }

          if (this.isClosed) {
            resolve();
            return;
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          this._kyselyTrx = trx as unknown as Kysely<any>;
          this._exitKyselyTransaction = () => {
            this._kyselyTrx = undefined;
            this._exitKyselyTransaction = undefined;
          };
          this.cleanups.push(trxResult);

          resolve();

          const event = await Promise.race([
            this.waitForEvent('end'),
            this.waitForEvent('end_txn'),
            this.waitForEvent('error'),
          ]);
          if (event === 'error' && this._exitKyselyTransaction) {
            this._exitKyselyTransaction();
            throw new Error('Transaction ended due to error');
          }
        })
        .catch((err) => {
          reject(err);
        })
        .finally(() => {
          this._exitKyselyTransaction?.();
        });
    });

    await Promise.all([prismaEntered, kyselyEntered]);
  }

  private _exitTransaction: (() => void) | undefined;
  private _exitKyselyTransaction: (() => void) | undefined;

  /** manually exit the transaction pair attached to the context */
  exitTransaction() {
    this.emit('end_txn');
  }

  get inTransaction() {
    return !!this._exitTransaction;
  }

  /** transactional Kysely client when in a context transaction; otherwise undefined */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get kyselyTrx(): Kysely<any> | undefined {
    return this._kyselyTrx;
  }

  onChangesCommitted(fn: () => unknown) {
    if (this.inTransaction) {
      this.on('close', () => fn());
    } else {
      fn();
    }
  }
}

function currentContext(): Context {
  const store = asyncLocalStorage.getStore();
  if (store === undefined) {
    throw new Error('Async local storage undefined');
  }
  return store;
}

function unsafeCurrentContext(): Context | undefined {
  return asyncLocalStorage.getStore();
}

export { Context, currentContext, unsafeCurrentContext, type UserContext };
