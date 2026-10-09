// The Slack adapter's AWAITABLE capability (asks-as-adapter §A/D, S18) — the
// proof the capability isn't ask-shaped. Pins the parts that need no live Slack
// client or DB: the correlation key (`channel:thread_ts`) a pending await names,
// the same key an inbound thread reply wakes (`wakeKeys`), the edge-name guard,
// and the WHERE CANDIDATE SURFACE (a landing reads back through the ordinary
// message `getFieldValue`, so the engine's pure WHERE over `o.User` /
// `o.`Message`` resolves without knowing any of Slack's internal keys). The live
// thread re-check (`resolveAwait` against `conversations.replies`) is covered
// e2e in the dev loop.

import type { TeamId } from '../../../generated/kysely/core/Team';

import { SlackAdapter, SLACK_MESSAGE_TYPE_ID } from '../adapters/slack';
import { makeUnstablePosition } from '../types';

const TEAM_ID = 'team-1' as TeamId;

// No credential: no Slack client, so a check-now cannot read the thread and
// answers pending — which is exactly where the key shows.
function makeAdapter(): SlackAdapter {
  return new SlackAdapter(TEAM_ID);
}

function pendingKey(recordId: string, headData?: Record<string, unknown>): Promise<unknown> {
  return makeAdapter().awaitable.resolveAwait({
    recordId,
    edge: 'Replies',
    ...(headData !== undefined ? { headData } : {}),
  });
}

describe('SlackAdapter.awaitable — the key a pending await names', () => {
  it('is channel:thread_ts of a top-level message write handle (thread root = its own ts)', async () => {
    // A `write ch-[:Messages]->` handle: externalId is the bare ts, channel rides
    // the write-result data as `channelId` — no thread_ts, so the reply lands
    // under the message's own ts.
    expect(await pendingKey('1700000000.000100', { channelId: 'C123', ts: '1700000000.000100' })).toEqual({
      status: 'pending',
      correlationKey: 'C123:1700000000.000100',
    });
  });

  it('anchors to the THREAD ROOT when the awaited message is itself a reply', async () => {
    expect(
      await pendingKey('1700000000.000200', {
        channelId: 'C123',
        ts: '1700000000.000200',
        threadTs: '1700000000.000000',
      }),
    ).toEqual({ status: 'pending', correlationKey: 'C123:1700000000.000000' });
  });

  it('refuses loudly when the channel cannot be recovered (nothing to wake on)', async () => {
    await expect(pendingKey('1700000000.000100', {})).rejects.toThrow(/channel/i);
    await expect(pendingKey('1700000000.000100')).rejects.toThrow(/channel/i);
  });
});

describe('SlackAdapter.wakeKeys — the keys an inbound delivery wakes', () => {
  const envelope = (event: Record<string, unknown>) => ({ type: 'event_callback', event_id: 'Ev1', event });

  it('a thread reply wakes its thread: the key its await parked on', async () => {
    const reply = envelope({
      type: 'message',
      channel: 'C123',
      ts: '1700000000.000200',
      thread_ts: '1700000000.000100',
      text: 'approved',
    });
    expect(await makeAdapter().wakeKeys({ raw: reply })).toEqual(['C123:1700000000.000100']);
    // The same key the awaited message's handle named when it parked.
    expect(await pendingKey('1700000000.000100', { channelId: 'C123', ts: '1700000000.000100' })).toMatchObject({
      correlationKey: 'C123:1700000000.000100',
    });
  });

  it('a top-level message, a non-event envelope, or junk wakes nothing', async () => {
    const adapter = makeAdapter();
    expect(await adapter.wakeKeys({ raw: envelope({ type: 'message', channel: 'C123', ts: '1.0' }) })).toEqual([]);
    expect(await adapter.wakeKeys({ raw: { type: 'url_verification', challenge: 'x' } })).toEqual([]);
    expect(await adapter.wakeKeys({ raw: 'not json' })).toEqual([]);
  });
});

describe('SlackAdapter.awaitable — edge guard', () => {
  it('resolveAwait rejects an edge that is not Replies', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.awaitable.resolveAwait({ recordId: '1700000000.1', edge: 'Author' }),
    ).rejects.toThrow(/not an awaitable edge/);
  });
});

describe('SlackAdapter.awaitable — WHERE candidate surface', () => {
  it('a landing reads its reply fields back through the ordinary message getFieldValue', async () => {
    const adapter = makeAdapter();
    // The landing the resume path binds: recordType = the natural Message type,
    // data = the raw reply payload (what resolveAwait returns). The engine's pure
    // WHERE (`o.User == "U9"`) reads each candidate THROUGH this same
    // getFieldValue — so it must surface the reply's author and body under the
    // author-facing field names.
    const landing = makeUnstablePosition({
      adapterType: 'slack',
      recordType: 'Message',
      data: {
        text: 'Please hold off',
        user: 'U9',
        channel: 'C123',
        ts: '1700000000.000200',
      },
    });
    expect(await adapter.getFieldValue({ position: landing, fieldId: 'Message' })).toBe(
      'Please hold off',
    );
    expect(await adapter.getFieldValue({ position: landing, fieldId: 'User' })).toBe('U9');
    expect(await adapter.getFieldValue({ position: landing, fieldId: 'Channel' })).toBe('C123');
  });
});

// Reference the message type id so a rename of the constant fails this test loudly.
it('the awaitable Replies edge targets the Message type', () => {
  expect(SLACK_MESSAGE_TYPE_ID).toBe('slack:message');
});
