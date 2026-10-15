// The Linked Users collection — Telegram's one listable noun. The Bot API
// cannot enumerate chats; the handshake's identity table can, and each row's
// user id IS the private chat id a send targets.

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../../../../lib/recording', () => ({
  isTestHarnessTeam: () => false,
  injectFakeBaseUrl: (p: unknown) => p,
}));

jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => '{}',
  encryptToken: async () => '',
}));

const identityRows = [
  {
    telegram_user_id: '111222333',
    email: 'ada@example.com',
    linked_at: new Date('2026-07-01T10:00:00Z'),
  },
];

jest.mock('../../../../../lib/kysely', () => ({
  getQb: () => {
    throw new Error('unexpected public-schema query in this test');
  },
  getCoreQb: () => {
    throw new Error('unexpected public-schema query in this test');
  },
  getAutomationsQb: () => ({
    selectFrom: () => {
      const conds: Record<string, unknown> = {};
      const builder = {
        where: (col: string, _op: string, val: unknown) => {
          conds[col] = val;
          return builder;
        },
        select: () => builder,
        orderBy: () => builder,
        execute: async () => identityRows,
        executeTakeFirst: async () =>
          identityRows.find((r) => r.telegram_user_id === conds.telegram_user_id),
      };
      return builder;
    },
  }),
}));

import type { TeamId } from '../../../../../generated/kysely/core/Team';

import { isStablePosition, makeMetaPosition, makeStablePosition } from 'movement-engine/services/translation_graph/types';
import { TelegramAdapter } from '../index';

describe('Telegram Linked Users collection', () => {
  const adapter = new TelegramAdapter('team-tg' as TeamId, 'cred-1');

  it('publishes the Linked User entry point and descriptor', async () => {
    const entries = await adapter.listEntryPoints();
    const linked = entries.find((e) => e.displayName === 'Linked User');
    expect(linked).toMatchObject({ readable: true, writable: false, collectionName: 'Linked Users' });
    const descriptor = await adapter.describe('Linked User');
    expect(descriptor?.fields.map((f) => f.displayName)).toEqual(['Chat Id', 'Email', 'Linked At']);
  });

  it('meta → Linked Users lists stable positions from the identity table', async () => {
    const landed = await adapter.getRelated({
      position: makeMetaPosition('telegram'),
      fieldId: 'Linked Users',
      direction: 'outgoing',
    });
    expect(landed).toHaveLength(1);
    expect(isStablePosition(landed[0].position)).toBe(true);
    expect(
      await adapter.getFieldValue({ position: landed[0].position, fieldId: 'Chat Id' }),
    ).toBe('111222333');
    expect(
      await adapter.getFieldValue({ position: landed[0].position, fieldId: 'Email' }),
    ).toBe('ada@example.com');
    expect(
      await adapter.getFieldValue({ position: landed[0].position, fieldId: 'Linked At' }),
    ).toBe('2026-07-01T10:00:00.000Z');
  });

  it('publishes the sender back-edge on Message', async () => {
    const descriptor = await adapter.describe('Message');
    expect(descriptor?.references?.map((r) => r.name)).toEqual(['Attachments', 'Replies', 'Sender']);
  });

  it('message → sender resolves the linked user for a bound sender', async () => {
    const message = makeStablePosition({
      adapterType: 'telegram',
      recordType: 'Message',
      recordId: 'msg-1',
      data: { sender_id: '111222333', chat_id: '111222333', chat_type: 'private' },
    });
    const landed = await adapter.getRelated({
      position: message,
      fieldId: 'Sender',
      direction: 'outgoing',
    });
    expect(landed).toHaveLength(1);
    expect(landed[0].position.recordType).toBe('Linked User');
    expect(
      await adapter.getFieldValue({ position: landed[0].position, fieldId: 'Email' }),
    ).toBe('ada@example.com');
  });

  it('message → sender yields nothing for an unlinked sender (group chat / no handshake)', async () => {
    const message = makeStablePosition({
      adapterType: 'telegram',
      recordType: 'Message',
      recordId: 'msg-2',
      data: { sender_id: '999999999', chat_id: '-100500', chat_type: 'group' },
    });
    const landed = await adapter.getRelated({
      position: message,
      fieldId: 'Sender',
      direction: 'outgoing',
    });
    expect(landed).toEqual([]);
  });
});
