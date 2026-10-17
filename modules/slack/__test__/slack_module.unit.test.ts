// The module over a host context: where a credential reaches Slack, what a
// host without a model or without a credential gets, how a file value's
// bytes are found and uploaded, and what the module declares about its
// inbound. The whole surface's answers are held to the legacy adapter by
// apps/api's recorded parity (slack_parity.unit.test.ts).

import type { CredentialFields, ModuleCredential, ModuleFiles } from 'module-kit';

import { adapterInProcess, noCredential, refusingFiles, refusingKv } from 'module-kit';
import { makeMetaPosition } from 'movement-engine/public/catalog';

import { slackModule, slackModuleWith, type SlackHosted } from '../index';

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function credential(fields: CredentialFields): ModuleCredential {
  return { name: 'slack', fields: async () => fields, update: async () => {} };
}

interface Call {
  url: string;
  authorization: string | null;
  contentType: string | null;
  body: string;
}

/** A Slack Web API that answers every method well, and the upload URL and a
 *  file URL; every request kept. */
function fakeSlack(): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    const body = init?.body === undefined || init.body === null ? '' : Buffer.from(init.body as Uint8Array).toString('utf8');
    calls.push({ url, authorization: headers.get('authorization'), contentType: headers.get('content-type'), body });
    if (url.startsWith('https://files.example/')) return new Response('remote bytes', { status: 200, headers: { 'content-type': 'text/csv' } });
    if (url.endsWith('/files.getUploadURLExternal')) {
      return Response.json({ ok: true, upload_url: 'https://upload.example/F9', file_id: 'F9' });
    }
    if (url.endsWith('/conversations.info')) return Response.json({ ok: true, channel: { id: 'C1', is_member: true } });
    return Response.json({ ok: true, ts: '1.2', channels: [], members: [] });
  };
  return { fetch, calls };
}

function load(input: { credential: ModuleCredential; hosted?: SlackHosted; files?: ModuleFiles; fetch?: typeof fetch }) {
  const definition = input.hosted === undefined ? slackModule : slackModuleWith(input.hosted);
  return adapterInProcess(definition, {
    tenant: 'team-1',
    credential: input.credential,
    ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
    log: silent,
    files: input.files ?? refusingFiles('no files'),
    kv: refusingKv('no kv'),
    validateResults: true,
  });
}

describe('@lf/slack', () => {
  it('declares the signed inbound the platform door has always verified, and its credential', () => {
    const { manifest } = load({ credential: credential({ accessToken: 'xoxb-1' }) });
    expect(manifest.inbound).toEqual({
      providerKey: 'slack',
      scheme: 'slack_v0',
      signatureHeaders: ['x-slack-signature'],
      intercepts: ['slack_url_verification'],
    });
    expect(manifest.credentials?.[0]).toMatchObject({ name: 'slack', kind: 'static' });
  });

  it('with no credential, a root read refuses by name and makes no request', async () => {
    const { adapter } = load({ credential: noCredential('nothing connected') });
    await expect(adapter.getRelated({ position: makeMetaPosition('slack'), fieldId: 'Channels', direction: 'outgoing' })).rejects.toThrow(
      /no usable Slack credential for team team-1 \(credentialsId=unset\)\. Connect Slack\./,
    );
  });

  it('the composition function refuses without a host model, and writes with one', async () => {
    const invoke = (adapter: ReturnType<typeof load>['adapter']) =>
      adapter.invokeFieldFunction?.({ recordType: 'Message', fieldId: 'Message', functionName: 'SLACK_MESSAGE', args: { instructions: 'say hi', data: ['x'] } } as never);
    await expect(invoke(load({ credential: credential({ accessToken: 'xoxb-1' }) }).adapter)).rejects.toThrow(/needs a model/);
    const asked: string[] = [];
    const hosted = load({
      credential: credential({ accessToken: 'xoxb-1' }),
      hosted: { chat: async (input) => (asked.push(input.userMessage), '  *hi*  ') },
    });
    await expect(invoke(hosted.adapter)).resolves.toBe('*hi*');
    expect(asked).toEqual(['say hi\n\nData you can use:\n- x']);
  });

  it('a file value with a URL is fetched with the host’s fetch and uploaded with the bot token', async () => {
    const slack = fakeSlack();
    const { slackSourcesFrom } = await import('../index');
    const { moduleContext } = await import('module-kit');
    const { createUnifiedMessage } = await import('../write');
    const ctx = moduleContext({ tenant: 't', credential: credential({}), fetch: slack.fetch, log: silent, files: refusingFiles('x'), kv: refusingKv('x'), validateResults: false });
    // A stub Web API client: the module's own client posts through
    // @slack/web-api's HTTP stack; only file bytes go through the host's fetch.
    const client = {
      api: {
        token: 'xoxb-1',
        conversations: { info: async () => ({ ok: true, channel: { is_member: true } }) },
        files: {
          getUploadURLExternal: async () => ({ ok: true, upload_url: 'https://upload.example/F9', file_id: 'F9' }),
          completeUploadExternal: async () => ({ ok: true }),
        },
      },
    } as never;
    const result = await createUnifiedMessage({
      client,
      host: slackSourcesFrom(ctx),
      anchor: { kind: 'post', channelId: 'C1' },
      fields: { file: { __brand: 'FileRef', name: 'a.csv', url: 'https://files.example/a.csv' } },
    });
    expect(result.externalId).toBe('F9');
    expect(slack.calls.map((c) => [c.url, c.authorization, c.contentType, c.body])).toEqual([
      ['https://files.example/a.csv', null, null, ''],
      ['https://upload.example/F9', 'Bearer xoxb-1', 'text/csv', 'remote bytes'],
    ]);
  });

  it('without a URL, a file value’s bytes come from the host’s files', async () => {
    const read = jest.fn(async () => new TextEncoder().encode('stored bytes'));
    const files: ModuleFiles = { put: async () => ({ __brand: 'FileRef' }), read };
    const { slackSourcesFrom } = await import('../index');
    const { moduleContext } = await import('module-kit');
    const ctx = moduleContext({ tenant: 't', credential: credential({}), log: silent, files, kv: refusingKv('x'), validateResults: false });
    const sources = slackSourcesFrom(ctx);
    const ref = { __brand: 'FileRef' as const, name: 'n', source: { adapterType: 'gmail', handle: 'h' } };
    await expect(sources.readFile(ref)).resolves.toEqual({ body: Buffer.from('stored bytes') });
    expect(read).toHaveBeenCalledWith(ref);
  });

  it('a delivery fires its event with Slack’s idempotency key; a message is a create', async () => {
    const { adapter } = load({ credential: credential({}) });
    const raw = { type: 'event_callback', event_id: 'Ev9', event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '9.1' } };
    await expect(adapter.preprocessInbound?.({ raw })).resolves.toEqual({
      events: [
        {
          payload: raw.event,
          externalId: '9.1',
          recordType: 'slack:message',
          eventType: 'message',
          idempotencyKey: 'Ev9',
          changeType: 'create',
        },
      ],
    });
    await expect(adapter.preprocessInbound?.({ raw: { type: 'url_verification', challenge: 'c' } })).resolves.toEqual({ events: [] });
    await expect(adapter.wakeKeys?.({ raw: { type: 'event_callback', event: { type: 'message', channel: 'C1', ts: '9.2', thread_ts: '9.1' } } })).resolves.toEqual(['C1:9.1']);
  });
});
