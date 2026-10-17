// The module over a host context: which bot a credential reaches, where it
// reaches it, what the host's linked identities become, and how an owned file
// names its install. The whole surface's answers are held to the legacy
// adapter by apps/api's recorded parity (telegram_parity.unit.test.ts).

import type { CredentialFields, LinkedIdentity, ModuleCredential } from 'module-kit';

import { adapterInProcess, noCredential, refusingFiles, refusingKv } from 'module-kit';
import { makeMetaPosition, makeStablePosition, makeUnstablePosition } from 'movement-engine/public/catalog';

import { telegramModule } from '../index';

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function credential(fields: CredentialFields): ModuleCredential {
  return { name: 'telegram', fields: async () => fields, update: async () => {} };
}

const ADA: LinkedIdentity = { externalId: '777', email: 'Ada@Example.com ', linkedAt: '2026-06-01T12:00:00.000Z' };

function load(input: { credential: ModuleCredential; baseUrlOverride?: string; credentialRef?: string; identities?: boolean }) {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 9, chat: { id: 777 } } }), { status: 200 });
  };
  const loaded = adapterInProcess(telegramModule, {
    tenant: 'team-1',
    credential: input.credential,
    fetch,
    log: silent,
    files: refusingFiles('no files'),
    kv: refusingKv('no kv'),
    ...(input.identities === false
      ? {}
      : { identities: { list: async () => [ADA], find: async (id: string) => (id === ADA.externalId ? ADA : null) } }),
    ...(input.baseUrlOverride !== undefined ? { baseUrlOverride: input.baseUrlOverride } : {}),
    ...(input.credentialRef !== undefined ? { credentialRef: input.credentialRef } : {}),
    validateResults: true,
  });
  return { adapter: loaded.adapter, manifest: loaded.manifest, calls };
}

const dm = (adapter: ReturnType<typeof load>['adapter']) =>
  adapter.createRecord({
    mutationContext: { source: {}, occurredAt: '2026-10-17T00:00:00.000Z' },
    recordType: 'Message',
    fields: { Text: 'hi' },
    parentLinks: [{ recordType: 'Linked User', externalId: '777', edgeName: 'Messages', data: {} }],
  } as never);

describe('@lf/telegram', () => {
  it('declares its credential and its inbound, verified by the secret token a team bot is registered with', () => {
    const { manifest } = load({ credential: credential({ botToken: 'T' }) });
    expect(manifest.adapterType).toBe('telegram');
    expect(manifest.credentials?.[0]?.name).toBe('telegram');
    expect(manifest.inbound).toEqual({ providerKey: 'telegram', scheme: 'telegram_secret_token', signatureHeaders: ['x-telegram-bot-api-secret-token'] });
  });

  it('sends with the credential’s bot token at its base URL', async () => {
    const { adapter, calls } = load({ credential: credential({ botToken: 'T1', baseUrl: 'http://bots.test/' }) });
    await expect(dm(adapter)).resolves.toMatchObject({ externalId: '9', data: { chat_id: '777' } });
    expect(calls).toEqual(['http://bots.test/botT1/sendMessage']);
  });

  it('the host’s base URL override wins over the credential’s', async () => {
    const { adapter, calls } = load({ credential: credential({ botToken: 'T1', baseUrl: 'http://bots.test' }), baseUrlOverride: 'http://fake.test/telegram' });
    await dm(adapter);
    expect(calls).toEqual(['http://fake.test/telegram/botT1/sendMessage']);
  });

  it.each([
    ['a blank token', credential({ botToken: '  ' })],
    ['no token', credential({})],
    ['an unreadable credential', noCredential('nothing connected')],
  ])('with %s, reads still answer and a send refuses by name', async (_name, given) => {
    const { adapter, calls } = load({ credential: given });
    await expect(adapter.listEntryPoints()).resolves.toHaveLength(3);
    await expect(dm(adapter)).rejects.toThrow(/no usable Telegram bot token for this install/);
    expect(calls).toEqual([]);
  });

  it('linked users and the actor come from the host’s identities', async () => {
    const { adapter } = load({ credential: credential({ botToken: 'T' }) });
    const users = await adapter.getRelated({ position: makeMetaPosition('telegram'), fieldId: 'Linked Users', direction: 'outgoing' });
    expect(users.map((u) => u.position.identity.data)).toEqual([{ chat_id: '777', email: 'Ada@Example.com ', linked_at: '2026-06-01T12:00:00.000Z' }]);
    const actor = await adapter.extractActor?.({ event: { payload: { sender_id: '777', sender_username: 'adas' } } as never });
    expect(actor).toMatchObject({ identifier: '777', email: 'ada@example.com', label: '@adas' });
    await expect(adapter.extractActor?.({ event: { payload: { sender_id: '888' } } as never })).resolves.toBeNull();
  });

  it('a host with no identities refuses the listing and resolves no actor', async () => {
    const { adapter } = load({ credential: credential({ botToken: 'T' }), identities: false });
    await expect(adapter.getRelated({ position: makeMetaPosition('telegram'), fieldId: 'Linked Users', direction: 'outgoing' })).rejects.toThrow(
      /keeps no linked identities/,
    );
    await expect(adapter.extractActor?.({ event: { payload: { sender_id: '777' } } as never })).resolves.toBeNull();
    const message = makeStablePosition({ adapterType: 'telegram', recordType: 'Message', recordId: '1', data: { sender_id: '777' } });
    await expect(adapter.getRelated({ position: message, fieldId: 'Sender', direction: 'outgoing' })).resolves.toEqual([]);
  });

  it('an attachment’s file names the install the host gave', async () => {
    const attachment = makeUnstablePosition({ adapterType: 'telegram', recordType: 'Attachment', data: { file_id: 'F1', name: 'a.pdf' } });
    const named = load({ credential: credential({ botToken: 'T' }), credentialRef: 'cred-1' });
    await expect(named.adapter.getFieldValue({ position: attachment, fieldId: 'File' })).resolves.toMatchObject({
      source: { adapterType: 'telegram', credentialId: 'cred-1', handle: 'F1' },
    });
    const unnamed = load({ credential: credential({ botToken: 'T' }) });
    await expect(unnamed.adapter.getFieldValue({ position: attachment, fieldId: 'File' })).resolves.toEqual({
      __brand: 'FileRef',
      name: 'a.pdf',
      source: { adapterType: 'telegram', handle: 'F1' },
    });
  });

  it('a delivery fires one tagged message event; anything else none', async () => {
    const { adapter } = load({ credential: credential({}) });
    const raw = { update_id: 1, message: { message_id: 5, chat: { id: 7, type: 'private' }, from: { id: 7 }, text: 'hey' } };
    await expect(adapter.preprocessInbound?.({ raw })).resolves.toEqual({
      events: [
        {
          payload: expect.objectContaining({ message_id: '5', chat_id: '7', text: 'hey', attachments: [] }),
          externalId: '5',
          recordType: 'telegram:message',
          eventType: 'message',
          tag: 'message',
          changeType: 'create',
        },
      ],
    });
    await expect(adapter.preprocessInbound?.({ raw: { callback_query: { id: 'x' } } })).resolves.toEqual({ events: [] });
  });
});
