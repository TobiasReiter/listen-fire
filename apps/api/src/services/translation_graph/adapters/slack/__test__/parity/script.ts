// The calls recorded parity makes, in order, against one Slack
// implementation. The schema is walked from what the adapter itself
// describes — every field of every type read, every readable reference
// walked — from the positions a run would hold: the root, a channel, its
// history, a thread, a delivered message with files, a reaction. Then the
// inbound seams, the actor, the awaited `Replies`, the composition field
// function, and every send with its refusals. The transcript is every answer
// as JSON; two implementations agree when their transcripts and the requests
// they made are identical.
//
// File uploads are not driven: the fake's upload URL names a fixed port of its
// own, outside the recording, so an upload is held by the module's unit tests
// instead.

import type { Adapter } from 'movement-engine/public/adapter';
import type { SourcePosition } from 'movement-engine/public/catalog';

import { makeMetaPosition, makeStablePosition } from 'movement-engine/public/catalog';

export interface SlackParitySubject {
  adapter: Adapter;
  /** False where the host runs no model for the composition function. */
  compose: boolean;
}

export interface TranscriptEntry {
  step: string;
  answer: unknown;
}

function json(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

const DEALFLOW = 'C002';
const ROOT_TS = '1751500000.000100';

const MESSAGE_EVENT = {
  type: 'event_callback',
  team_id: 'T1',
  event_id: 'Ev1',
  event: {
    type: 'message',
    channel: DEALFLOW,
    user: 'U001',
    text: 'Deck attached',
    ts: '1751600000.000100',
    files: [
      { id: 'F100', name: 'deck.pdf', title: 'Deck', mimetype: 'application/pdf', size: 2048, url_private_download: 'https://files.slack.test/F100/deck.pdf' },
      { id: 'F101', title: 'notes', mimetype: 'text/plain' },
    ],
  },
};
const MENTION_EVENT = {
  type: 'event_callback',
  team_id: 'T1',
  event_id: 'Ev2',
  event: { type: 'app_mention', channel: DEALFLOW, user: 'U002', text: '<@B1> summarise', ts: '1751600100.000200' },
};
const THREAD_REPLY_EVENT = {
  type: 'event_callback',
  team_id: 'T1',
  event_id: 'Ev3',
  event: { type: 'message', channel: DEALFLOW, user: 'U002', text: 'replying', ts: '1751600200.000300', thread_ts: ROOT_TS },
};
const REACTION_EVENT = {
  type: 'event_callback',
  team_id: 'T1',
  event_id: 'Ev4',
  event: { type: 'reaction_added', user: 'U001', reaction: 'rocket', item: { type: 'message', channel: DEALFLOW, ts: ROOT_TS }, event_ts: '1751600300.000400' },
};

export async function runSlackParityScript(subject: SlackParitySubject): Promise<TranscriptEntry[]> {
  const { adapter } = subject;
  const transcript: TranscriptEntry[] = [];
  const step = async <T>(name: string, call: () => Promise<T>): Promise<T | undefined> => {
    try {
      const answer = await call();
      transcript.push({ step: name, answer: json(answer) });
      return answer;
    } catch (error) {
      transcript.push({ step: name, answer: { error: error instanceof Error ? error.message : String(error) } });
      return undefined;
    }
  };

  /** Read every field and walk every readable reference `position`'s type
   *  describes; answer the positions the walks reached, by reference name. */
  const walk = async (label: string, position: SourcePosition): Promise<Record<string, SourcePosition[]>> => {
    const reached: Record<string, SourcePosition[]> = {};
    const type = position.recordType;
    if (type === null) return reached;
    const described = await step(`${label} describe`, () => adapter.describe(type));
    for (const field of described?.fields ?? []) {
      await step(`${label}.${field.displayName}`, () => adapter.getFieldValue({ position, fieldId: field.displayName }));
    }
    for (const reference of described?.references ?? []) {
      if (reference.readable === false) continue;
      const name = reference.name ?? reference.fieldId;
      const related = await step(`${label} -[${name}]->`, () => adapter.getRelated({ position, fieldId: name, direction: 'outgoing' }));
      reached[name] = (related ?? []).map((r) => r.position);
    }
    return reached;
  };

  // ── Schema and the root ──
  const entries = await step('listEntryPoints', () => adapter.listEntryPoints());
  for (const entry of entries ?? []) await step(`describe ${entry.displayName}`, () => adapter.describe(entry.displayName));
  for (const type of ['Message', 'Reaction', 'File', 'slack:message', 'Nonexistent']) {
    await step(`describe ${type}`, () => adapter.describe(type));
  }
  const meta = makeMetaPosition('slack');
  await step('edgesFrom meta', async () => (await adapter.edgesFrom?.(meta)) ?? null);
  await step('listEventTypes', async () => (await adapter.listEventTypes?.()) ?? null);
  await step('runtimeCapabilities', async () => adapter.runtimeCapabilities?.() ?? null);
  const channels = await step('Channels', () => adapter.getRelated({ position: meta, fieldId: 'Channels', direction: 'outgoing' }));
  const users = await step('Users', () => adapter.getRelated({ position: meta, fieldId: 'Users', direction: 'outgoing' }));
  await step('meta unknown edge', () => adapter.getRelated({ position: meta, fieldId: 'Nope', direction: 'outgoing' }));
  await step('incoming', () => adapter.getRelated({ position: meta, fieldId: 'Channels', direction: 'incoming' }));

  // ── A channel, its history and a thread ──
  const dealflow = channels?.find((c) => (c.position.identity.data as { id?: string } | undefined)?.id === DEALFLOW)?.position;
  let rootMessage: SourcePosition | undefined;
  if (dealflow !== undefined) {
    const reached = await walk('Channel', dealflow);
    await step('Channel -[Messages]-> LIMIT 1', () => adapter.getRelated({ position: dealflow, fieldId: 'Messages', direction: 'outgoing', limit: 1 }));
    rootMessage = (reached.Messages ?? []).find((m) => (m.identity.data as { ts?: string } | undefined)?.ts === ROOT_TS);
  }
  if (rootMessage !== undefined) await walk('Message', rootMessage);
  const user = users?.[0]?.position;
  if (user !== undefined) await walk('User', user);

  // ── Inbound ──
  for (const [name, raw] of [
    ['message with files', MESSAGE_EVENT],
    ['app_mention', MENTION_EVENT],
    ['thread reply', THREAD_REPLY_EVENT],
    ['reaction_added', REACTION_EVENT],
    ['url_verification', { type: 'url_verification', challenge: 'abc' }],
    ['no event', { type: 'event_callback', team_id: 'T1' }],
    ['not an object', 'hello'],
  ] as const) {
    await step(`preprocessInbound ${name}`, async () => (await adapter.preprocessInbound?.({ raw })) ?? null);
    await step(`wakeKeys ${name}`, async () => (await adapter.wakeKeys?.({ raw })) ?? null);
  }

  // ── Delivered positions ──
  const delivered = async (raw: unknown, recordType: string): Promise<SourcePosition | undefined> => {
    const event = (await adapter.preprocessInbound?.({ raw }))?.events[0];
    if (event === undefined) return undefined;
    return makeStablePosition({ adapterType: 'slack', recordType, recordId: event.externalId ?? '', data: event.payload });
  };
  const fileMessage = await delivered(MESSAGE_EVENT, 'Message');
  if (fileMessage !== undefined) {
    const reached = await walk('Delivered message', fileMessage);
    for (const [index, file] of (reached.Files ?? []).entries()) {
      const fileReached = await walk(`File ${index}`, file);
      void fileReached;
      const value = await step(`File ${index} value`, () => adapter.getFieldValue({ position: file, fieldId: 'File' }));
      if (index === 0 && value !== null && typeof value === 'object') {
        await step('resolveFileRef', async () => {
          const resolved = await adapter.resolveFileRef?.({ ref: value as never });
          return resolved === undefined ? null : { contentType: resolved.contentType ?? null };
        });
      }
    }
  }
  const reaction = await delivered(REACTION_EVENT, 'Reaction');
  if (reaction !== undefined) await walk('Reaction', reaction);

  // ── The actor ──
  const event = (payload: unknown) => ({ payload, actor: undefined }) as never;
  for (const [name, raw] of [['message', MESSAGE_EVENT], ['reaction', REACTION_EVENT]] as const) {
    const payload = (await adapter.preprocessInbound?.({ raw }))?.events[0]?.payload;
    await step(`getActorCandidates ${name}`, async () => (await adapter.getActorCandidates?.({ event: event(payload) })) ?? null);
    await step(`extractActor ${name}`, async () => (await adapter.extractActor?.({ event: event(payload) })) ?? null);
  }
  await step('getActorCandidates no user', async () => (await adapter.getActorCandidates?.({ event: event({ type: 'message' }) })) ?? null);

  // ── The awaited Replies ──
  const awaitable = adapter.awaitable;
  if (awaitable !== undefined) {
    await step('resolveAwait thread with replies', () => awaitable.resolveAwait({ recordId: ROOT_TS, edge: 'Replies', headData: { channelId: DEALFLOW } }));
    await step('resolveAwait thread without', () => awaitable.resolveAwait({ recordId: '1751500100.000200', edge: 'Replies', headData: { channel: DEALFLOW } }));
    await step('resolveAwait no channel', () => awaitable.resolveAwait({ recordId: ROOT_TS, edge: 'Replies' }));
    await step('resolveAwait other edge', () => awaitable.resolveAwait({ recordId: ROOT_TS, edge: 'Files', headData: { channelId: DEALFLOW } }));
  }

  // ── The composition field function ──
  if (subject.compose) {
    await step('invokeFieldFunction SLACK_MESSAGE', async () =>
      (await adapter.invokeFieldFunction?.({ recordType: 'Message', fieldId: 'Message', functionName: 'slack_message', args: { instructions: 'Say hi to @[Ada Okafor]', data: ['deal: Acme', 3] } } as never)) ?? null,
    );
  }
  await step('invokeFieldFunction unknown', async () =>
    (await adapter.invokeFieldFunction?.({ recordType: 'Message', fieldId: 'Message', functionName: 'NOPE', args: {} } as never)) ?? null,
  );

  // ── Sends ──
  const mutationContext = { source: { kind: 'parity' }, occurredAt: '2026-10-17T00:00:00.000Z' };
  const channelParent = { recordType: 'Channel', externalId: DEALFLOW, edgeName: 'Messages', data: { id: DEALFLOW } };
  const rootParent = (edgeName: string) => ({ recordType: 'Message', externalId: ROOT_TS, edgeName, data: { channel: DEALFLOW, ts: ROOT_TS } });
  const write = (name: string, fields: Record<string, unknown>, parentLinks?: unknown[], recordType = 'Message') =>
    step(name, () => adapter.createRecord({ mutationContext, recordType, fields, ...(parentLinks !== undefined ? { parentLinks } : {}) } as never));
  await write('post with a mention', { Message: 'Hi @[Ada Okafor], see the deck' }, [channelParent]);
  await write('reply in the thread', { Message: 'On it' }, [rootParent('Replies')]);
  await write('reply to a composite id', { Message: 'composite' }, [{ recordType: 'Message', externalId: `${DEALFLOW}:${ROOT_TS}`, edgeName: 'Replies', data: {} }]);
  await write('post blocks', { Message: 'fallback', Blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*hi*' } }] }, [channelParent]);
  await write('react', { Emoji: 'rocket' }, [rootParent('Reactions')], 'Reaction');
  await write('react again (already reacted)', { Emoji: 'rocket' }, [rootParent('Reactions')], 'Reaction');
  await write('no parent', { Message: 'x' });
  await write('nothing to say', {}, [channelParent]);
  await write('file and blocks', { Message: 'x', File: { __brand: 'FileRef', name: 'a.txt' }, Blocks: [{ type: 'divider' }] }, [channelParent]);
  await write('blocks not a list', { Message: 'x', Blocks: 'nope' }, [channelParent]);
  await write('reply without a channel', { Message: 'x' }, [{ recordType: 'Message', externalId: ROOT_TS, edgeName: 'Replies', data: {} }]);
  await write('wrong edge', { Message: 'x' }, [{ ...channelParent, edgeName: 'Members' }]);
  await step('updateRecord', () => adapter.updateRecord({ mutationContext, recordType: 'Message', externalId: ROOT_TS, fields: {} } as never));
  await step('deleteRecord', () => adapter.deleteRecord({ mutationContext, recordType: 'Message', externalId: ROOT_TS } as never));
  return transcript;
}
