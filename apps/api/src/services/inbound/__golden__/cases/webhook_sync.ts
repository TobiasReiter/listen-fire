// POST /api/public/webhook-sync/:provider/:subscriptionId — the per-provider
// signature chain, the Slack challenge short-circuit, the capture-then-ack
// pipeline and its failure modes.

import { createHmac } from 'node:crypto';

import type { GoldenCase } from '../harness';

import { withEnv } from '../env';
import { SECRETS, hmacBase64, hmacHex, slackSignature } from '../secrets';
import { GOLDEN_CALLBACK, world } from '../world';
import { REMOTE_SIGNATURE_HEADER_FOR_CASES } from './names';
import { define, givenSubscription, givenTrigger, json, post, text } from './support';

const ATTIO_BODY = { events: [{ event_type: 'record.created', id: { record_id: 'rec-1' } }], event_id: 'evt-attio-1' };
const SLACK_TIMESTAMP = '1760702400';
const slackHeaders = (secret: string) => (body: Buffer) => ({
  'x-slack-request-timestamp': SLACK_TIMESTAMP,
  'x-slack-signature': slackSignature({ secret, timestamp: SLACK_TIMESTAMP, body }),
});
const SLACK_EVENT = {
  type: 'event_callback',
  event_id: 'Ev1',
  team_id: 'T1',
  event: { type: 'message', channel: 'C1', user: 'U1', ts: '1760702400.000100', text: 'hello' },
};
const META_TEXT = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'waba-1',
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { display_phone_number: '15550001111', phone_number_id: 'pn-1' },
            contacts: [{ wa_id: '15550002222', profile: { name: 'Ada' } }],
            messages: [{ from: '15550002222', id: 'wamid.1', timestamp: '1760702400', type: 'text', text: { body: 'hi' } }],
          },
        },
      ],
    },
  ],
};
const META_INTERACTIVE = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'waba-1',
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { display_phone_number: '15550001111', phone_number_id: 'pn-1' },
            messages: [
              {
                from: '15550002222',
                id: 'wamid.2',
                timestamp: '1760702400',
                type: 'interactive',
                interactive: { type: 'button_reply', button_reply: { id: 'cb_golden0001', title: 'Approve' } },
              },
            ],
          },
        },
      ],
    },
  ],
};

const attioArrange = () => {
  givenSubscription({ webhook_secret: SECRETS.attio });
  givenTrigger();
};

const PATH = (provider: string, id = 'sub-1') => `/api/public/webhook-sync/${provider}/${id}`;

const TG_BRING = { 'x-telegram-bot-api-secret-token': SECRETS.telegramBring };

export const webhookSyncCases: GoldenCase[] = define('webhook_sync', [
  // ── Attio: the default header chain ─────────────────────────────────────
  {
    id: 'attio-good-signature',
    note: 'Attio-Signature over the raw body: captured, queued before the 200, drain poked after.',
    arrange: attioArrange,
    request: post(PATH('attio'), json(ATTIO_BODY), (body) => ({ 'attio-signature': hmacHex(SECRETS.attio, body) })),
  },
  {
    id: 'attio-bad-signature',
    note: 'A wrong signature is refused 401 before anything is parsed or captured.',
    arrange: attioArrange,
    request: post(PATH('attio'), json(ATTIO_BODY), { 'attio-signature': 'a'.repeat(64) }),
  },
  {
    id: 'attio-missing-signature',
    note: 'No signature header at all is the same 401.',
    arrange: attioArrange,
    request: post(PATH('attio'), json(ATTIO_BODY)),
  },
  {
    id: 'attio-signature-via-x-attio-signature',
    note: 'The second header in the chain is honoured.',
    arrange: attioArrange,
    request: post(PATH('attio'), json(ATTIO_BODY), (body) => ({ 'x-attio-signature': hmacHex(SECRETS.attio, body) })),
  },
  {
    id: 'attio-signature-via-x-webhook-signature',
    note: 'The outbox worker header, last in the chain, is honoured.',
    arrange: attioArrange,
    request: post(PATH('attio'), json(ATTIO_BODY), (body) => ({ 'x-webhook-signature': hmacHex(SECRETS.attio, body) })),
  },
  {
    id: 'attio-first-header-in-chain-wins',
    note: 'With a bad attio-signature and a good x-webhook-signature the FIRST present header is the one checked: 401.',
    arrange: attioArrange,
    request: post(PATH('attio'), json(ATTIO_BODY), (body) => ({
      'attio-signature': 'b'.repeat(64),
      'x-webhook-signature': hmacHex(SECRETS.attio, body),
    })),
  },
  {
    id: 'attio-remote-header-ignored-for-builtin',
    note: 'x-listen-fire-signature verifies remote installs only, so a bad one beside a good attio-signature is ignored: 200. (Before the shared inbound core it headed every chain and shadowed the good one: 401.)',
    arrange: attioArrange,
    request: post(PATH('attio'), json(ATTIO_BODY), (body) => ({
      [REMOTE_SIGNATURE_HEADER_FOR_CASES]: 'c'.repeat(64),
      'attio-signature': hmacHex(SECRETS.attio, body),
    })),
  },
  {
    id: 'provider-path-is-case-insensitive',
    note: 'The path segment is upper-cased to the provider key.',
    arrange: attioArrange,
    request: post(PATH('ATTIO'), json(ATTIO_BODY), (body) => ({ 'attio-signature': hmacHex(SECRETS.attio, body) })),
  },

  // ── The refusals before a signature is read ─────────────────────────────
  {
    id: 'unknown-provider-no-subscription',
    note: 'No such provider and no such row: 404 unknown_provider.',
    request: post(PATH('nope', 'missing'), json(ATTIO_BODY)),
  },
  {
    id: 'known-provider-no-subscription',
    note: 'A known provider with no live row: 404 subscription_not_found.',
    request: post(PATH('attio', 'missing'), json(ATTIO_BODY), { 'attio-signature': 'a'.repeat(64) }),
  },
  {
    id: 'provider-mismatch',
    note: 'The row belongs to ATTIO but the URL names AIRTABLE: 400 provider_mismatch.',
    arrange: attioArrange,
    request: post(PATH('airtable'), json(ATTIO_BODY)),
  },
  {
    id: 'non-json-body-with-valid-signature',
    note: 'A signed body that is not JSON passes the signature and fails the parse: 500 internal.',
    arrange: attioArrange,
    request: post(PATH('attio'), text('this is not json'), (body) => ({ 'attio-signature': hmacHex(SECRETS.attio, body) })),
  },
  {
    id: 'non-json-content-type',
    note: 'A body that is not application/json is never read raw; the route re-serialises an empty object, which cannot match the signature: 401.',
    arrange: attioArrange,
    request: post(PATH('attio'), text('plain text'), { 'content-type': 'text/plain', 'attio-signature': 'a'.repeat(64) }),
  },
  {
    id: 'body-over-100kb',
    note: "The raw parser's default 100 KB limit answers 413 before the route runs, in the door's JSON error shape. (Before the shared inbound core express answered its own HTML page.)",
    arrange: attioArrange,
    request: post(PATH('attio'), { kind: 'padded', value: ATTIO_BODY, paddedToBytes: 120_000 }, (body) => ({
      'attio-signature': hmacHex(SECRETS.attio, body),
    })),
  },

  // ── The pipeline's outcomes ─────────────────────────────────────────────
  {
    id: 'no-events-no-wakes',
    note: 'A delivery that carries nothing is acked 200 with zero events; nothing is queued but the drain is still poked.',
    arrange: () => {
      attioArrange();
      world.adapters.attio = { adapterType: 'attio', hasPreprocess: true, preprocess: () => ({ events: [] }), wakeKeys: () => [] };
    },
    request: post(PATH('attio'), json(ATTIO_BODY), (body) => ({ 'attio-signature': hmacHex(SECRETS.attio, body) })),
  },
  {
    id: 'no-trigger-listens',
    note: 'Events with no listening trigger are receipted nowhere but still acked.',
    arrange: () => {
      givenSubscription({ webhook_secret: SECRETS.attio });
    },
    request: post(PATH('attio'), json(ATTIO_BODY), (body) => ({ 'attio-signature': hmacHex(SECRETS.attio, body) })),
  },
  {
    id: 'wake-keys-queued',
    note: 'An adapter wake door names correlation keys: they are queued (after the events) before the ack.',
    arrange: () => {
      attioArrange();
      world.adapters.attio = {
        adapterType: 'attio',
        hasPreprocess: true,
        preprocess: () => ({ events: [] }),
        wakeKeys: () => ['thread:abc', 'thread:def'],
      };
    },
    request: post(PATH('attio'), json(ATTIO_BODY), (body) => ({ 'attio-signature': hmacHex(SECRETS.attio, body) })),
  },
  {
    id: 'wake-keys-failure',
    note: 'A wakeKeys that throws costs the delivery its ack, not its events: they are captured and queued, then 500 so the sender retries.',
    arrange: () => {
      attioArrange();
      world.adapters.attio = {
        adapterType: 'attio',
        hasPreprocess: true,
        preprocess: (raw) => ({ events: [{ eventType: 'inbound', externalId: 'rec-1', idempotencyKey: 'delivery-1', payload: raw }] }),
        wakeKeys: () => {
          throw new Error('wake door down');
        },
      };
    },
    request: post(PATH('attio'), json(ATTIO_BODY), (body) => ({ 'attio-signature': hmacHex(SECRETS.attio, body) })),
  },
  {
    id: 'receipt-enqueue-failure-is-isolated',
    note: 'A receipt whose work row cannot be queued is logged and the delivery answered 500, so the sender retries and the stored receipt is re-queued. The wakes are still queued. (Before the shared inbound core it was acked 200 and the receipt never ran.)',
    arrange: () => {
      attioArrange();
      world.enqueueFails = true;
    },
    request: post(PATH('attio'), json(ATTIO_BODY), (body) => ({ 'attio-signature': hmacHex(SECRETS.attio, body) })),
  },
  {
    id: 'wake-enqueue-failure',
    note: 'A wake that cannot be queued is a 500 so the sender retries; the events were already receipted.',
    arrange: () => {
      attioArrange();
      world.enqueueFails = true;
      world.adapters.attio = {
        adapterType: 'attio',
        hasPreprocess: true,
        preprocess: (raw) => ({ events: [{ eventType: 'inbound', externalId: 'rec-1', idempotencyKey: 'delivery-1', payload: raw }] }),
        wakeKeys: () => ['thread:abc'],
      };
    },
    request: post(PATH('attio'), json(ATTIO_BODY), (body) => ({ 'attio-signature': hmacHex(SECRETS.attio, body) })),
  },
  {
    id: 'capture-failure',
    note: 'An event whose receipt cannot be stored is dropped from the count; the delivery is still acked 200 with zero processed.',
    arrange: () => {
      attioArrange();
      world.captureFails = true;
    },
    request: post(PATH('attio'), json(ATTIO_BODY), (body) => ({ 'attio-signature': hmacHex(SECRETS.attio, body) })),
  },
  {
    id: 'pull-checkpoint-advances',
    note: 'An adapter that returns a checkpoint has it written to the subscription before the ack.',
    arrange: () => {
      attioArrange();
      world.adapters.attio = {
        adapterType: 'attio',
        hasPreprocess: true,
        preprocess: (raw) => ({
          events: [{ eventType: 'inbound', externalId: 'rec-1', idempotencyKey: 'delivery-1', payload: raw }],
          checkpoint: { cursor: 'c-2' },
        }),
      };
    },
    request: post(PATH('attio'), json(ATTIO_BODY), (body) => ({ 'attio-signature': hmacHex(SECRETS.attio, body) })),
  },
  {
    id: 'bridged-linked-object-refresh',
    note: 'An event naming a record a knowledge node is bridged to also queues a linked-object refresh.',
    arrange: () => {
      attioArrange();
      world.bridgedLinkedObjects = true;
    },
    request: post(PATH('attio'), json(ATTIO_BODY), (body) => ({ 'attio-signature': hmacHex(SECRETS.attio, body) })),
  },
  {
    id: 'adapter-cannot-preprocess',
    note: 'An adapter with no preprocessInbound is a wiring bug: 500 with its error text.',
    arrange: () => {
      attioArrange();
      world.adapters.attio = { adapterType: 'attio', hasPreprocess: false, preprocess: () => ({ events: [] }) };
    },
    request: post(PATH('attio'), json(ATTIO_BODY), (body) => ({ 'attio-signature': hmacHex(SECRETS.attio, body) })),
  },
  {
    id: 'harness-team-skips-signature-and-drains',
    note: 'The dev-loop team bypasses the signature, and its rows are drained before the ack so dispatch errors can be read from the response.',
    arrange: () => {
      givenSubscription({ team_id: 'team-harness', webhook_secret: SECRETS.attio });
      givenTrigger();
      world.harnessTeams = ['team-harness'];
    },
    request: post(PATH('attio'), json(ATTIO_BODY), { 'attio-signature': 'not-even-hex' }),
  },

  // ── Airtable ───────────────────────────────────────────────────────────
  {
    id: 'airtable-good-mac',
    note: 'X-Airtable-Content-MAC: hmac-sha256=<hex> keyed by the base64-decoded secret.',
    arrange: () => {
      givenSubscription({ provider: 'AIRTABLE', webhook_secret: SECRETS.airtable });
      givenTrigger({ kind: 'AIRTABLE' });
    },
    request: post(PATH('airtable'), json({ base: { id: 'app1' }, webhook: { id: 'wh1' } }), (body) => ({
      'x-airtable-content-mac': `hmac-sha256=${createHmac('sha256', Buffer.from(SECRETS.airtable, 'base64')).update(body).digest('hex')}`,
    })),
  },
  {
    id: 'airtable-bad-mac',
    note: 'A MAC from the wrong key is 401.',
    arrange: () => givenSubscription({ provider: 'AIRTABLE', webhook_secret: SECRETS.airtable }),
    request: post(PATH('airtable'), json({ base: { id: 'app1' } }), { 'x-airtable-content-mac': `hmac-sha256=${'d'.repeat(64)}` }),
  },

  // ── Affinity: its own chain; an unset key refuses (its module's signed inbound) ─
  {
    id: 'affinity-hex-signature',
    note: 'Hex HMAC in x-affinity-signature.',
    arrange: () => {
      givenSubscription({ provider: 'AFFINITY', webhook_secret: SECRETS.affinity });
      givenTrigger({ kind: 'AFFINITY' });
    },
    request: post(PATH('affinity'), json({ type: 'list_entry.created', body: { id: 7 } }), (body) => ({
      'x-affinity-signature': hmacHex(SECRETS.affinity, body),
    })),
  },
  {
    id: 'affinity-base64-signature-with-prefix',
    note: 'Base64 digest with a sha256= prefix, in the generic x-signature header, is accepted.',
    arrange: () => {
      givenSubscription({ provider: 'AFFINITY', webhook_secret: SECRETS.affinity });
      givenTrigger({ kind: 'AFFINITY' });
    },
    request: post(PATH('affinity'), json({ type: 'list_entry.created', body: { id: 7 } }), (body) => ({
      'x-signature': `sha256=${hmacBase64(SECRETS.affinity, body)}`,
    })),
  },
  {
    id: 'affinity-unset-key-refused',
    note: 'A new subscription with no signature key refuses every delivery: 401. (Only a grandfathered one, from before signed inbound, still lets it in.)',
    arrange: () => {
      givenSubscription({ provider: 'AFFINITY', webhook_secret: '' });
      givenTrigger({ kind: 'AFFINITY' });
    },
    request: post(PATH('affinity'), json({ type: 'list_entry.created', body: { id: 7 } })),
  },
  {
    id: 'affinity-key-set-unsigned-rejected',
    note: 'With a key configured, an unsigned delivery is 401.',
    arrange: () => givenSubscription({ provider: 'AFFINITY', webhook_secret: SECRETS.affinity }),
    request: post(PATH('affinity'), json({ type: 'list_entry.created', body: { id: 7 } })),
  },
  {
    id: 'affinity-ignores-attio-header',
    note: "Affinity's chain does not include attio-signature: a good one there is not seen.",
    arrange: () => givenSubscription({ provider: 'AFFINITY', webhook_secret: SECRETS.affinity }),
    request: post(PATH('affinity'), json({ type: 'list_entry.created' }), (body) => ({
      'attio-signature': hmacHex(SECRETS.affinity, body),
    })),
  },

  // ── Grandfathered subscriptions: rows that predate signed inbound keep their door's old leniency ─
  {
    id: 'attio-grandfathered-empty-secret-accepted',
    note: 'A grandfathered Attio subscription with no secret verifies against an empty key, as the door always did: 200.',
    arrange: () => {
      givenSubscription({ webhook_secret: '', grandfathered_unsigned: true });
      givenTrigger();
    },
    request: post(PATH('attio'), json(ATTIO_BODY), (body) => ({ 'attio-signature': hmacHex('', body) })),
  },
  {
    id: 'attio-new-empty-secret-refused',
    note: 'A new Attio subscription with no secret refuses even a delivery signed with the empty key: 401.',
    arrange: () => {
      givenSubscription({ webhook_secret: '' });
      givenTrigger();
    },
    request: post(PATH('attio'), json(ATTIO_BODY), (body) => ({ 'attio-signature': hmacHex('', body) })),
  },
  {
    id: 'airtable-grandfathered-empty-secret-accepted',
    note: 'A grandfathered Airtable subscription with no secret verifies against an empty key: 200.',
    arrange: () => {
      givenSubscription({ provider: 'AIRTABLE', webhook_secret: '', grandfathered_unsigned: true });
      givenTrigger({ kind: 'AIRTABLE' });
    },
    request: post(PATH('airtable'), json({ base: { id: 'app1' }, webhook: { id: 'wh1' } }), (body) => ({
      'x-airtable-content-mac': `hmac-sha256=${createHmac('sha256', Buffer.from('', 'base64')).update(body).digest('hex')}`,
    })),
  },
  {
    id: 'airtable-new-empty-secret-refused',
    note: 'A new Airtable subscription with no secret refuses even a delivery signed with the empty key: 401.',
    arrange: () => {
      givenSubscription({ provider: 'AIRTABLE', webhook_secret: '' });
      givenTrigger({ kind: 'AIRTABLE' });
    },
    request: post(PATH('airtable'), json({ base: { id: 'app1' }, webhook: { id: 'wh1' } }), (body) => ({
      'x-airtable-content-mac': `hmac-sha256=${createHmac('sha256', Buffer.from('', 'base64')).update(body).digest('hex')}`,
    })),
  },
  {
    id: 'affinity-grandfathered-unset-key-accepted',
    note: 'A grandfathered Affinity subscription with no key lets any delivery in, as the door always did: 200.',
    arrange: () => {
      givenSubscription({ provider: 'AFFINITY', webhook_secret: '', grandfathered_unsigned: true });
      givenTrigger({ kind: 'AFFINITY' });
    },
    request: post(PATH('affinity'), json({ type: 'list_entry.created', body: { id: 7 } })),
  },
  {
    id: 'affinity-grandfathered-key-set-unsigned-rejected',
    note: 'Setting the key ends the exemption: a grandfathered Affinity subscription with a key refuses an unsigned delivery, 401.',
    arrange: () => givenSubscription({ provider: 'AFFINITY', webhook_secret: SECRETS.affinity, grandfathered_unsigned: true }),
    request: post(PATH('affinity'), json({ type: 'list_entry.created', body: { id: 7 } })),
  },

  // ── Slack (bring-your-own app): challenge and two-header signature ───────
  {
    id: 'slack-url-verification',
    note: 'The setup handshake is answered with the bare challenge before any row is read or signature checked.',
    request: post(PATH('slack', 'anything'), json({ type: 'url_verification', challenge: 'ch-123' })),
  },
  {
    id: 'slack-url-verification-missing-challenge',
    note: 'An envelope typed url_verification with no string challenge is 400 missing_challenge.',
    request: post(PATH('slack', 'anything'), json({ type: 'url_verification' })),
  },
  {
    id: 'slack-url-verification-wrong-provider',
    note: 'The challenge short-circuit is Slack only: other providers go on to the subscription lookup.',
    request: post(PATH('attio', 'anything'), json({ type: 'url_verification', challenge: 'ch-123' })),
  },
  {
    id: 'slack-good-signature',
    note: 'X-Slack-Request-Timestamp + X-Slack-Signature v0 over the raw body.',
    arrange: () => {
      givenSubscription({ provider: 'SLACK', webhook_secret: SECRETS.slackBring });
      givenTrigger({ kind: 'SLACK' });
    },
    request: post(PATH('slack'), json(SLACK_EVENT), slackHeaders(SECRETS.slackBring)),
  },
  {
    id: 'slack-bad-signature',
    note: 'Signed with another secret: 401.',
    arrange: () => givenSubscription({ provider: 'SLACK', webhook_secret: SECRETS.slackBring }),
    request: post(PATH('slack'), json(SLACK_EVENT), slackHeaders(SECRETS.slackApp)),
  },
  {
    id: 'slack-missing-timestamp-header',
    note: 'Either Slack header missing collapses to an empty signature: 401.',
    arrange: () => givenSubscription({ provider: 'SLACK', webhook_secret: SECRETS.slackBring }),
    request: post(PATH('slack'), json(SLACK_EVENT), (body) => ({
      'x-slack-signature': slackSignature({ secret: SECRETS.slackBring, timestamp: SLACK_TIMESTAMP, body }),
    })),
  },
  {
    id: 'slack-uses-no-other-header',
    note: 'A good x-webhook-signature does not help Slack: its chain is only the two Slack headers.',
    arrange: () => givenSubscription({ provider: 'SLACK', webhook_secret: SECRETS.slackBring }),
    request: post(PATH('slack'), json(SLACK_EVENT), (body) => ({ 'x-webhook-signature': hmacHex(SECRETS.slackBring, body) })),
  },

  // ── Telegram (bring-your-own bot): secret token header, callback_query branch ───
  {
    id: 'telegram-message-with-secret-token',
    note: 'A team bot registered with a secret_token: Telegram echoes it in x-telegram-bot-api-secret-token, and the delivery is accepted.',
    arrange: () => {
      givenSubscription({ provider: 'TELEGRAM', webhook_secret: SECRETS.telegramBring });
      givenTrigger({ kind: 'TELEGRAM' });
    },
    request: post(PATH('telegram'), json({ update_id: 1, message: { message_id: 5, text: 'hi', chat: { id: 9 }, from: { id: 3 } } }), TG_BRING),
  },
  {
    id: 'telegram-callback-query-fires-callback',
    note: 'A button tap carrying a callback id fires it, answers the tap, retires the keyboard, and ends the delivery (no events).',
    arrange: () => givenSubscription({ provider: 'TELEGRAM', webhook_secret: SECRETS.telegramBring }),
    request: post(
      PATH('telegram'),
      json({ update_id: 2, callback_query: { id: 'cbq-1', data: 'cb_golden0001', message: { message_id: 11, chat: { id: 9 } } } }),
      TG_BRING,
    ),
  },
  {
    id: 'telegram-callback-query-not-served-keeps-keyboard',
    note: 'A tap on an already-closed callback answers the tap but leaves the keyboard.',
    arrange: () => {
      givenSubscription({ provider: 'TELEGRAM', webhook_secret: SECRETS.telegramBring });
      world.fireCallback = () => ({ kind: 'closed', callback: GOLDEN_CALLBACK });
    },
    request: post(
      PATH('telegram'),
      json({ update_id: 2, callback_query: { id: 'cbq-2', data: 'cb_golden0001', message: { message_id: 11, chat: { id: 9 } } } }),
      TG_BRING,
    ),
  },
  {
    id: 'telegram-callback-query-firing-throws',
    note: 'A firing that throws is acked to the tapper as a failure; the delivery still ends handled with 200.',
    arrange: () => {
      givenSubscription({ provider: 'TELEGRAM', webhook_secret: SECRETS.telegramBring });
      world.fireCallback = () => {
        throw new Error('ledger down');
      };
    },
    request: post(
      PATH('telegram'),
      json({ update_id: 2, callback_query: { id: 'cbq-3', data: 'cb_golden0001', message: { message_id: 11, chat: { id: 9 } } } }),
      TG_BRING,
    ),
  },
  {
    id: 'telegram-callback-query-foreign-data-falls-through',
    note: 'A callback_query whose data is not ours is not handled here; the delivery continues to the adapter like any update.',
    arrange: () => {
      givenSubscription({ provider: 'TELEGRAM', webhook_secret: SECRETS.telegramBring });
      givenTrigger({ kind: 'TELEGRAM' });
    },
    request: post(
      PATH('telegram'),
      json({ update_id: 2, callback_query: { id: 'cbq-4', data: 'something-else', message: { message_id: 11, chat: { id: 9 } } } }),
      TG_BRING,
    ),
  },
  {
    id: 'telegram-missing-secret-token-refused',
    note: 'A team bot delivery without the secret-token header is refused.',
    arrange: () => {
      givenSubscription({ provider: 'TELEGRAM', webhook_secret: SECRETS.telegramBring });
      givenTrigger({ kind: 'TELEGRAM' });
    },
    request: post(PATH('telegram'), json({ update_id: 1, message: { message_id: 5, text: 'hi', chat: { id: 9 }, from: { id: 3 } } })),
  },
  {
    id: 'telegram-wrong-secret-token-refused',
    note: 'A wrong secret-token header is refused.',
    arrange: () => {
      givenSubscription({ provider: 'TELEGRAM', webhook_secret: SECRETS.telegramBring });
      givenTrigger({ kind: 'TELEGRAM' });
    },
    request: post(PATH('telegram'), json({ update_id: 1, message: { message_id: 5, text: 'hi', chat: { id: 9 }, from: { id: 3 } } }), {
      'x-telegram-bot-api-secret-token': 'wrong',
    }),
  },

  // ── WhatsApp (bring-your-own number) ────────────────────────────────────
  // Meta signs with the platform's WhatsApp app secret in x-hub-signature-256,
  // exactly as at the default door; the subscription's own secret plays no part.
  {
    id: 'whatsapp-good-signature-via-x-hub-signature-256',
    note: "Meta's sha256=<hex> over the raw body with the platform app secret, in x-hub-signature-256, is delivered.",
    arrange: () => {
      givenSubscription({ provider: 'INBOUND_WHATSAPP', webhook_secret: SECRETS.whatsappSub });
      givenTrigger({ kind: 'INBOUND_WHATSAPP' });
    },
    request: post(PATH('inbound_whatsapp'), json(META_TEXT), (body) => ({
      'x-hub-signature-256': `sha256=${hmacHex(SECRETS.whatsappApp, body)}`,
    })),
  },
  {
    id: 'whatsapp-subscription-secret-refused',
    note: "A digest keyed with the subscription's own secret, in either header, is 401: the app secret is the only key.",
    arrange: () => givenSubscription({ provider: 'INBOUND_WHATSAPP', webhook_secret: SECRETS.whatsappSub }),
    request: post(PATH('inbound_whatsapp'), json(META_TEXT), (body) => ({
      'x-hub-signature-256': `sha256=${hmacHex(SECRETS.whatsappSub, body)}`,
      'x-webhook-signature': `sha256=${hmacHex(SECRETS.whatsappSub, body)}`,
    })),
  },
  {
    id: 'whatsapp-missing-signature',
    note: 'No x-hub-signature-256 is 401, even with a valid digest in x-webhook-signature.',
    arrange: () => givenSubscription({ provider: 'INBOUND_WHATSAPP', webhook_secret: SECRETS.whatsappSub }),
    request: post(PATH('inbound_whatsapp'), json(META_TEXT), (body) => ({
      'x-webhook-signature': `sha256=${hmacHex(SECRETS.whatsappApp, body)}`,
    })),
  },
  {
    id: 'whatsapp-no-app-secret-refuses',
    note: 'With no platform app secret configured nothing proves the sender; 401 even for a digest keyed with the empty string.',
    arrange: () => {
      givenSubscription({ provider: 'INBOUND_WHATSAPP', webhook_secret: SECRETS.whatsappSub });
      return withEnv({ WHATSAPP_WEBHOOK_SECRET: undefined });
    },
    request: post(PATH('inbound_whatsapp'), json(META_TEXT), (body) => ({
      'x-hub-signature-256': `sha256=${hmacHex('', body)}`,
    })),
  },
  {
    id: 'whatsapp-interactive-reply-fires-callback-and-continues',
    note: 'A tapped reply button carrying a callback id fires it and is acked on WhatsApp, and the delivery still goes on to the adapter.',
    arrange: () => {
      givenSubscription({ provider: 'INBOUND_WHATSAPP', webhook_secret: SECRETS.whatsappSub });
      givenTrigger({ kind: 'INBOUND_WHATSAPP' });
    },
    request: post(PATH('inbound_whatsapp'), json(META_INTERACTIVE), (body) => ({
      'x-hub-signature-256': `sha256=${hmacHex(SECRETS.whatsappApp, body)}`,
    })),
  },

  // ── Native providers and a remote install ───────────────────────────────
  {
    id: 'native-valuations-good-signature',
    note: 'The valuations outbox worker signs hex HMAC in x-webhook-signature.',
    arrange: () => {
      givenSubscription({ provider: 'NATIVE_VALUATIONS', webhook_secret: SECRETS.valuations });
      givenTrigger({ kind: 'NATIVE_VALUATIONS' });
    },
    request: post(PATH('native_valuations'), json({ event_type: 'valuations:legal_entity:create', id: 'le-1' }), hex2('x-webhook-signature', SECRETS.valuations)),
  },
  {
    id: 'native-valuations-bad-signature',
    note: 'A wrong digest is 401.',
    arrange: () => givenSubscription({ provider: 'NATIVE_VALUATIONS', webhook_secret: SECRETS.valuations }),
    request: post(PATH('native_valuations'), json({ event_type: 'valuations:legal_entity:create' }), { 'x-webhook-signature': 'e'.repeat(64) }),
  },
  {
    id: 'knowledge-mutation-good-signature',
    note: 'The knowledge provider uses the same hex HMAC scheme.',
    arrange: () => {
      givenSubscription({ provider: 'KG_MUTATION', webhook_secret: SECRETS.knowledge });
      givenTrigger({ kind: 'KG_MUTATION' });
    },
    request: post(PATH('kg_mutation'), json({ mutation: 'node.created', id: 'n-1' }), hex2('x-webhook-signature', SECRETS.knowledge)),
  },
  {
    id: 'remote-install-good-signature',
    note: "A remote install's subscription signs in x-listen-fire-signature; the provider key is the upper-cased slug.",
    arrange: () => {
      world.remoteInstalls.push({
        adapter_type: 'acme-crm',
        team_id: 'team-1',
        credentials_id: 'cred-remote',
        auth_strategy: { kind: 'bearer' },
        secret: SECRETS.adapterDoor,
      });
      givenSubscription({ provider: 'ACME-CRM', credentials_id: null, webhook_secret: SECRETS.remote });
      givenTrigger({ kind: 'acme-crm' });
    },
    request: post(PATH('acme-crm'), json({ records: [{ id: 'r1' }] }), hex2('x-listen-fire-signature', SECRETS.remote)),
  },
  {
    id: 'remote-install-unregistered-secret',
    note: 'A subscription still holding the placeholder secret refuses everything.',
    arrange: () => {
      world.remoteInstalls.push({
        adapter_type: 'acme-crm',
        team_id: 'team-1',
        credentials_id: 'cred-remote',
        auth_strategy: { kind: 'bearer' },
        secret: SECRETS.adapterDoor,
      });
      givenSubscription({ provider: 'ACME-CRM', credentials_id: null, webhook_secret: 'pending' });
    },
    request: post(PATH('acme-crm'), json({ records: [] }), hex2('x-listen-fire-signature', 'pending')),
  },
  {
    id: 'remote-subscription-without-install',
    note: 'A row for a remote provider key whose install is gone: 404 unknown_provider.',
    arrange: () => givenSubscription({ provider: 'ACME-CRM', credentials_id: null, webhook_secret: SECRETS.remote }),
    request: post(PATH('acme-crm'), json({ records: [] }), hex2('x-listen-fire-signature', SECRETS.remote)),
  },
  {
    id: 'remote-install-without-credential',
    note: 'An install with no credential verifies but cannot open an adapter: 500.',
    arrange: () => {
      world.remoteInstalls.push({
        adapter_type: 'acme-crm',
        team_id: 'team-1',
        credentials_id: null,
        auth_strategy: { kind: 'bearer' },
        secret: SECRETS.adapterDoor,
      });
      givenSubscription({ provider: 'ACME-CRM', credentials_id: null, webhook_secret: SECRETS.remote });
    },
    request: post(PATH('acme-crm'), json({ records: [] }), hex2('x-listen-fire-signature', SECRETS.remote)),
  },
]);

function hex2(header: string, secret: string) {
  return (body: Buffer) => ({ [header]: hmacHex(secret, body) });
}
