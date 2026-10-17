/* eslint-disable @typescript-eslint/no-var-requires, import/order -- jest.mock factories run before this file's imports exist, and './env' must load before the routers are imported */
// Replays the golden corpus against today's inbound handlers.
//
// Each case in cases/ is a request; each recording in recordings/ is what the
// handlers answered and did the day the corpus was recorded. This test sends
// every case through the real routers (app.ts) over HTTP, with the stores,
// adapters and queues behind them faked (fakes.ts), and requires the answer —
// status, headers that matter, body bytes — and the effects (what was
// captured, queued, fired, sent) to match the recording exactly.
//
// To re-record after an intended change: GOLDEN_RECORD=1 pnpm test:unit
// --testPathPattern 'inbound/__golden__'. A diff in a recording is the review.

import './env';

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../lib/kysely', () => ({ ...jest.requireActual('../../../lib/kysely'), ...require('./fakes').kyselyFake() }));
jest.mock('../../../lib/recording', () => ({ ...jest.requireActual('../../../lib/recording'), ...require('./fakes').recordingFake() }));
jest.mock('../../translation_graph/adapters/resolve', () => ({
  ...jest.requireActual('../../translation_graph/adapters/resolve'),
  ...require('./fakes').resolveFake(),
}));
jest.mock('../../translation_graph/adapters/remote/store', () => ({
  ...jest.requireActual('../../translation_graph/adapters/remote/store'),
  ...require('./fakes').remoteStoreFake(),
}));
jest.mock('../../translation_graph/storage/tg_table', () => ({
  ...jest.requireActual('../../translation_graph/storage/tg_table'),
  ...require('./fakes').triggerTableFake(),
}));
jest.mock('../../translation_graph/triggers/dispatch_event', () => ({
  ...jest.requireActual('../../translation_graph/triggers/dispatch_event'),
  ...require('./fakes').dispatchEventFake(),
}));
jest.mock('../../translation_graph/triggers/event_store', () => ({
  ...jest.requireActual('../../translation_graph/triggers/event_store'),
  ...require('./fakes').eventStoreFake(),
}));
jest.mock('../../movement_engine/await_wake', () => ({
  ...jest.requireActual('../../movement_engine/await_wake'),
  ...require('./fakes').awaitWakeFake(),
}));
jest.mock('../../webhook_sync/linked_object_refresh', () => ({
  ...jest.requireActual('../../webhook_sync/linked_object_refresh'),
  ...require('./fakes').linkedObjectFake(),
}));
jest.mock('../../work/drain', () => ({ ...jest.requireActual('../../work/drain'), ...require('./fakes').workDrainFake() }));
jest.mock('../../work/store', () => ({ ...jest.requireActual('../../work/store'), ...require('./fakes').workStoreFake() }));
jest.mock('../../movement_engine/callback_fire', () => {
  const actual = jest.requireActual('../../movement_engine/callback_fire');
  return require('./fakes').callbackFireFake(actual);
});
jest.mock('../../movement_engine/callback_store', () => {
  const actual = jest.requireActual('../../movement_engine/callback_store');
  return require('./fakes').callbackStoreFake(actual);
});
jest.mock('../../translation_graph/adapters/ask/store', () => {
  const actual = jest.requireActual('../../translation_graph/adapters/ask/store');
  return require('./fakes').askStoreFake(actual);
});
jest.mock('../../translation_graph/adapters/ask/answer_door', () => {
  const actual = jest.requireActual('../../translation_graph/adapters/ask/answer_door');
  return require('./fakes').askAnswerFake(actual);
});
jest.mock('../../webhook_sync/telegram_builtin', () => ({
  ...jest.requireActual('../../webhook_sync/telegram_builtin'),
  ...require('./fakes').telegramBuiltinServiceFake(),
}));
jest.mock('../../webhook_sync/slack_events', () => ({
  ...jest.requireActual('../../webhook_sync/slack_events'),
  ...require('./fakes').slackEventsServiceFake(),
}));
jest.mock('../../translation_graph/adapters/telegram', () => {
  const actual = jest.requireActual('../../translation_graph/adapters/telegram');
  return require('./fakes').telegramAdapterFake(actual);
});
jest.mock('../../whatsapp/metaApi', () => ({ ...jest.requireActual('../../whatsapp/metaApi'), ...require('./fakes').whatsappApiFake() }));
jest.mock('../../whatsapp/dispatch', () => ({
  ...jest.requireActual('../../whatsapp/dispatch'),
  ...require('./fakes').whatsappDispatchFake(),
}));
jest.mock('../../whatsapp/utils', () => {
  const actual = jest.requireActual('../../whatsapp/utils');
  return require('./fakes').whatsappUtilsFake(actual);
});
jest.mock('../../../lib/slack', () => ({ ...jest.requireActual('../../../lib/slack'), ...require('./fakes').slackNotificationFake() }));
jest.mock('../../translation_graph/adapters/email/inbound_door', () => {
  const actual = jest.requireActual('../../translation_graph/adapters/email/inbound_door');
  return require('./fakes').inboundDoorFake(actual);
});
jest.mock('../../translation_graph/adapters/email/resend', () => {
  const actual = jest.requireActual('../../translation_graph/adapters/email/resend');
  return require('./fakes').resendApiFake(actual);
});
jest.mock('../../principal', () => {
  const actual = jest.requireActual('../../principal');
  return require('./fakes').directoryFake(actual);
});
jest.mock('../../translation_graph/adapters/acting_user/resolve', () => require('./fakes').actingUserFake());
jest.mock('principal', () => ({ ...jest.requireActual('principal'), ...require('./fakes').principalFake() }));
jest.mock('../../context', () => ({ ...jest.requireActual('../../context'), ...require('./fakes').contextFake() }));

import { allCases } from './cases';
import { buildGoldenApp } from './app';
import { RECORD_MODE, readRecording, readSnapshot, writeSnapshot, run, serve, writeRecording, type GoldenCase, type RecordedCase, type Served } from './harness';
import { FIXED_NOW_MS } from './secrets';
import { mountLines, routerTables, targetUrls } from './mounts';
import { record, resetWorld } from './world';

let served: Served;
let realFetch: typeof fetch;

beforeAll(async () => {
  // Only the clock is faked: handlers stamp `new Date()` into what they store,
  // and Svix checks timestamp drift. Timers stay real so the server runs.
  jest.useFakeTimers({
    now: FIXED_NOW_MS,
    doNotFake: [
      'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
      'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
      'setTimeout', 'clearTimeout',
    ],
  });
  // express logs the errors it turns into a response (the 413); the recording
  // already carries the response.
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  served = await serve(buildGoldenApp());
  realFetch = global.fetch;
  // Outbound posts (Slack's response_url) are an effect, not a network call.
  global.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url.startsWith(served.baseUrl)) return realFetch(input, init);
    record({ kind: 'outbound_post', url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
});

afterAll(async () => {
  jest.useRealTimers();
  global.fetch = realFetch;
  await served.close();
});

const byDoor = new Map<string, GoldenCase[]>();
for (const entry of allCases) byDoor.set(entry.door, [...(byDoor.get(entry.door) ?? []), entry]);

describe.each([...byDoor.entries()])('golden corpus: %s', (door, cases) => {
  it('has unique case ids', () => {
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(cases.length);
  });

  it(RECORD_MODE ? 'records every case' : 'replays every case byte for byte', async () => {
    const results: RecordedCase[] = [];
    for (const entry of cases) {
      resetWorld();
      const restore = entry.arrange?.();
      try {
        results.push(await run(served, entry));
      } finally {
        if (typeof restore === 'function') restore();
      }
    }
    if (RECORD_MODE) {
      writeRecording(door, results);
      return;
    }
    const recorded = readRecording(door);
    expect(recorded).not.toBeNull();
    expect(results.map((entry) => entry.id)).toEqual((recorded ?? []).map((entry) => entry.id));
    for (const [index, actual] of results.entries()) {
      expect(actual).toEqual(recorded?.[index]);
    }
  });
});

describe('golden corpus: mount paths and callback URLs', () => {
  const MOUNTS = 'mount_paths';
  const URLS = 'webhook_target_urls';
  const compare = (name: string, actual: unknown) => {
    if (RECORD_MODE) {
      writeSnapshot(name, actual);
      return;
    }
    expect(actual).toEqual(readSnapshot(name));
  };

  it('mounts every inbound door at the path it has today', () => {
    compare(MOUNTS, { routers: routerTables(), mountLines: mountLines() });
  });

  it('tells every provider key to call back the same URL as today', () => {
    compare(URLS, targetUrls());
  });
});
