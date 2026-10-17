// Fakes for the stores, adapters and queues behind the doors. Each jest.mock in
// the replay test hands its module one of these factories; the doors under test
// stay real. Every fake reports what it was asked to do to `effects`, which is
// how a recording says "this delivery was enqueued" without a database.

import { adapterFor, effects, record, world } from './world';

type AnyRecord = Record<string, unknown>;

function plain(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, inner: unknown) => {
      if (inner instanceof Date) return '<date>';
      if (inner instanceof Set) return [...inner];
      if (typeof inner === 'function') return '<function>';
      if (inner !== null && typeof inner === 'object' && typeof (inner as AnyRecord).toOperationNode === 'function') {
        // A raw sql`...` fragment: its parameters are the values worth pinning.
        const node = (inner as { toOperationNode(): { parameters?: { value?: unknown }[] } }).toOperationNode();
        return { sql: (node.parameters ?? []).map((parameter) => parameter.value) };
      }
      return inner;
    }) ?? 'null',
  );
}

/** A chainable stand-in for a Kysely query builder: it records the chain and
 *  answers the terminal call from `answer`. */
function queryBuilder(answer: (call: { op: string; table: string; steps: [string, unknown[]][] }) => unknown): AnyRecord {
  const steps: [string, unknown[]][] = [];
  let op = 'select';
  let table = '';
  const chain: AnyRecord = new Proxy(
    {},
    {
      get(_target, name: string) {
        if (name === 'then') return undefined;
        if (name === 'execute' || name === 'executeTakeFirst' || name === 'executeTakeFirstOrThrow') {
          return async () => answer({ op, table, steps });
        }
        return (...args: unknown[]) => {
          if (name === 'selectFrom' || name === 'insertInto' || name === 'updateTable' || name === 'deleteFrom') {
            op = name === 'selectFrom' ? 'select' : name === 'insertInto' ? 'insert' : name === 'updateTable' ? 'update' : 'delete';
            table = String(args[0]);
          } else {
            steps.push([name, args]);
          }
          return chain;
        };
      },
    },
  );
  return chain;
}

function whereValue(steps: [string, unknown[]][], column: string): unknown {
  const found = steps.find(([name, args]) => name === 'where' && String(args[0]).endsWith(column));
  return found?.[1][2];
}

export function kyselyFake(): AnyRecord {
  const automations = () =>
    queryBuilder(({ op, table, steps }) => {
      if (table === 'webhook_subscription' && op === 'select') {
        return world.subscriptions[String(whereValue(steps, 'id'))];
      }
      record({ kind: 'db', op, table, steps: plain(steps) });
      return undefined;
    });
  return {
    getAutomationsQb: () => automations(),
    getQb: () => automations(),
    getValuationsQb: () =>
      queryBuilder(({ op, table, steps }) => {
        record({ kind: 'valuations_db', op, table, steps: plain(steps) });
        if (op === 'select') return world.valuationsRows;
        if (op === 'insert') {
          const values = (steps.find(([name]) => name === 'values')?.[1][0] ?? []) as { event_type: string }[];
          return values.map((value, index) => ({ id: `row-new-${index + 1}`, event_type: value.event_type }));
        }
        return { numUpdatedRows: 2n };
      }),
  };
}

export function recordingFake(): AnyRecord {
  return {
    isTestHarnessTeam: (teamId: string) => world.harnessTeams.includes(teamId),
    testHarnessConfig: {},
    getTestHarnessConfig: () => ({}),
    injectFakeBaseUrl: (creds: unknown) => creds,
  };
}

export function resolveFake(): AnyRecord {
  return {
    resolveAdapter: async (input: { adapterType: string; teamId: string; credentialsId?: string }) => {
      const fake = adapterFor(input.adapterType);
      return {
        adapterType: fake.adapterType,
        listEventTypes: async () => [],
        ...(fake.hasPreprocess
          ? {
              preprocessInbound: async ({ raw }: { raw: unknown }) => {
                const out = fake.preprocess(raw);
                record({ kind: 'adapter_preprocess', adapterType: fake.adapterType, teamId: input.teamId });
                return out;
              },
            }
          : {}),
        ...(fake.wakeKeys !== undefined ? { wakeKeys: async ({ raw }: { raw: unknown }) => fake.wakeKeys!(raw) } : {}),
      };
    },
    loadRemoteAdapterSecret: async (_credentialsId: string, teamId: string, adapterType: string) => {
      const install = world.remoteInstalls.find((row) => row.team_id === teamId && row.adapter_type === adapterType);
      return install?.secret ?? '';
    },
  };
}

export function remoteStoreFake(): AnyRecord {
  const rows = (adapterType?: string, teamId?: string) =>
    world.remoteInstalls.filter(
      (row) => (adapterType === undefined || row.adapter_type === adapterType) && (teamId === undefined || row.team_id === teamId),
    );
  return {
    listRemoteAdapters: async (input: { teamId: string }) => rows(undefined, input.teamId),
    listRemoteAdaptersOfType: async (input: { adapterType: string; teamId?: string }) => rows(input.adapterType, input.teamId),
  };
}

export function triggerTableFake(): AnyRecord {
  return {
    findTriggersByKind: async (input: { teamId: string; kinds: string[] }) => {
      record({ kind: 'find_triggers', teamId: input.teamId, kinds: input.kinds });
      return world.triggers.filter((trigger) => input.kinds.includes(trigger.kind));
    },
    loadTriggerById: async (id: string) => {
      const trigger = world.triggers.find((row) => row.id === id);
      return trigger ? { ...trigger, movementId: world.emailTriggerLive ? trigger.movementId : null } : null;
    },
  };
}

export function dispatchEventFake(): AnyRecord {
  return {
    captureDiscriminableEvent: async (input: { triggerId: string; movementId: string; event: AnyRecord; adapterType: string; teamId: string; triggerType: string }) => {
      if (world.captureFails) throw new Error('capture refused');
      record({
        kind: 'capture_receipt',
        triggerId: input.triggerId,
        movementId: input.movementId,
        teamId: input.teamId,
        adapterType: input.adapterType,
        triggerType: input.triggerType,
        event: input.event,
      });
      return { receiptId: `receipt-${input.triggerId}` };
    },
    enqueueCapturedEvents: async (captured: AnyRecord[]) => {
      if (world.enqueueFails) throw new Error('queue unavailable');
      record({ kind: 'enqueue_receipts', receipts: captured });
    },
    readReceiptGroupOutcomes: async (input: { groups: { group: unknown }[] }) => ({
      cleared: input.groups.map((entry) => entry.group),
      failed: [],
    }),
  };
}

export function eventStoreFake(): AnyRecord {
  return {
    receiveTriggerEvent: async (input: AnyRecord) => {
      record({ kind: 'store_trigger_event', ...input });
      return { eventId: 'event-1', duplicate: false };
    },
  };
}

export function awaitWakeFake(): AnyRecord {
  return {
    enqueueAwaitWakes: async (input: AnyRecord) => {
      if (world.enqueueFails && Array.isArray(input.correlationKeys) && input.correlationKeys.length > 0) {
        throw new Error('queue unavailable');
      }
      record({ kind: 'enqueue_wakes', ...input });
    },
  };
}

export function linkedObjectFake(): AnyRecord {
  return {
    hasBridgedLinkedObjects: async () => world.bridgedLinkedObjects,
    enqueueLinkedObjectRefresh: async (input: AnyRecord) => record({ kind: 'enqueue_linked_object_refresh', ...input }),
  };
}

export function workDrainFake(): AnyRecord {
  return {
    notifyWork: () => record({ kind: 'notify_work' }),
    drainUntilIdle: async (input: AnyRecord) => {
      record({ kind: 'drain_until_idle', ...input });
      return { claimed: 0, ran: 0, recovered: 0, failed: 0 };
    },
  };
}

export function workStoreFake(): AnyRecord {
  return { awaitTeamWorkSettled: async () => true };
}

export function callbackFireFake(actual: AnyRecord): AnyRecord {
  return {
    ...actual,
    fireCallback: async (input: AnyRecord) => {
      record({ kind: 'fire_callback', ...input });
      return world.fireCallback(input as never);
    },
  };
}

export function callbackStoreFake(actual: AnyRecord): AnyRecord {
  return {
    ...actual,
    getCallback: async (id: string) => {
      if (!(actual.isCallbackId as (value: string) => boolean)(id)) return null;
      const found = world.callbacks[id];
      return found ? { ...found, expiresAt: found.expiresAt } : null;
    },
  };
}

export function askStoreFake(actual: AnyRecord): AnyRecord {
  return { ...actual, lookupAskByToken: async (token: string) => world.asks[token] ?? null };
}

export function askAnswerFake(actual: AnyRecord): AnyRecord {
  return {
    ...actual,
    answerAskByToken: async (token: string, raw: unknown) => {
      record({ kind: 'answer_ask', token, raw });
      return world.askAnswer(token, raw);
    },
  };
}

export function telegramBuiltinServiceFake(): AnyRecord {
  return {
    handleSharedBotInbound: async (raw: unknown) => {
      record({ kind: 'telegram_shared_bot_inbound', raw });
      return world.telegramBuiltin(raw);
    },
  };
}

export function slackEventsServiceFake(): AnyRecord {
  return {
    handleSlackEventsInbound: async (raw: unknown) => {
      record({ kind: 'slack_events_inbound', raw });
      return world.slackEvents(raw);
    },
  };
}

export function telegramAdapterFake(actual: AnyRecord): AnyRecord {
  class FakeTelegramAdapter {
    constructor(
      readonly teamId: string,
      readonly credentialsId?: string | null,
    ) {}
    async answerCallbackQuery(input: AnyRecord): Promise<void> {
      record({ kind: 'telegram_answer_callback_query', teamId: this.teamId, ...input });
    }
    async clearReplyMarkup(input: AnyRecord): Promise<void> {
      record({ kind: 'telegram_clear_reply_markup', teamId: this.teamId, ...input });
    }
  }
  return { ...actual, TelegramAdapter: FakeTelegramAdapter };
}

export function whatsappApiFake(): AnyRecord {
  return {
    getMetaWhatsappApi: (businessPhoneNumberId?: string) => ({
      sendTextMessage: async (to: string, text: string, options: AnyRecord) =>
        record({ kind: 'whatsapp_send_text', businessPhoneNumberId: businessPhoneNumberId ?? null, to, text, options }),
    }),
  };
}

export function whatsappDispatchFake(): AnyRecord {
  return {
    dispatchWhatsappMessage: async (input: AnyRecord) => record({ kind: 'whatsapp_dispatch_message', ...input }),
  };
}

export function whatsappUtilsFake(actual: AnyRecord): AnyRecord {
  return { ...actual, resolveWhatsappSender: async () => world.whatsappSender };
}

export function slackNotificationFake(): AnyRecord {
  return { sendSlackNotification: async (input: AnyRecord) => record({ kind: 'ops_notification', ...input }) };
}

export function inboundDoorFake(actual: AnyRecord): AnyRecord {
  return { ...actual, routeInboundEmail: async () => world.emailRoute };
}

export function resendApiFake(actual: AnyRecord): AnyRecord {
  return {
    ...actual,
    fetchReceivedEmail: async (emailId: string) => {
      if (world.resendFetch === 'fail') throw new Error('resend api unavailable');
      record({ kind: 'resend_fetch', emailId });
      return world.resendFetch;
    },
    listReceivedAttachments: async () => [],
  };
}

export function actingUserFake(): AnyRecord {
  return { resolveActingUser: async () => world.emailActingUser };
}

export function principalFake(): AnyRecord {
  return { currentPrincipal: () => ({ teamId: 'team-1', userId: 'user-1' }) };
}

export function contextFake(): AnyRecord {
  return { currentContext: () => ({ id: 'request-1' }) };
}

export { effects };
