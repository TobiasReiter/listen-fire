// The platform's own inbound routes, each mounted at its own path: the remote
// adapter push doors, the shared Telegram bot, the Listen-Fire Slack app's
// Events and Interactivity doors, and the WhatsApp number door.

import type { GoldenCase } from '../harness';

import { withEnv } from '../env';
import { SECRETS, hmacHex, slackSignature } from '../secrets';
import { GOLDEN_CALLBACK, record, world } from '../world';
import { define, json, post, text } from './support';

const SLACK_TIMESTAMP = '1760702400';
const slackHeaders = (secret: string, contentType = 'application/json') => (body: Buffer) => ({
  'content-type': contentType,
  'x-slack-request-timestamp': SLACK_TIMESTAMP,
  'x-slack-signature': slackSignature({ secret, timestamp: SLACK_TIMESTAMP, body }),
});

// ── Remote adapter push doors ─────────────────────────────────────────────

// The push doors parse the install's team as a uuid, as the column holds one.
const TEAM_1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const TEAM_2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const ADAPTER_HEADER = 'x-listen-fire-adapter-secret';
const installOf = (teamId: string, overrides: Record<string, unknown> = {}) => ({
  adapter_type: 'acme-crm',
  team_id: teamId,
  credentials_id: `cred-${teamId}`,
  auth_strategy: { kind: 'shared_secret' },
  secret: SECRETS.adapterDoor,
  ...overrides,
});
const EMIT = { events: [{ eventType: 'record.created', externalId: 'r-1', payload: { id: 'r-1' } }] };

export const adapterDoorCases: GoldenCase[] = define('adapter_doors', [
  {
    id: 'emit-good-credential',
    note: 'The presented credential names the install and so the team; events are receipted against its triggers and queued; 202 with the count.',
    arrange: () => {
      world.remoteInstalls.push(installOf(TEAM_1));
      world.triggers.push({ id: 'trigger-1', movementId: 'movement-1', kind: 'acme-crm', credentialsId: null, config: {} });
    },
    request: post('/api/public/adapter/acme-crm/emit', json(EMIT), { [ADAPTER_HEADER]: SECRETS.adapterDoor }),
  },
  {
    id: 'emit-bearer-strategy',
    note: 'An install whose strategy is bearer sends the credential as Authorization.',
    arrange: () => {
      world.remoteInstalls.push(installOf(TEAM_1, { auth_strategy: { kind: 'bearer' } }));
    },
    request: post('/api/public/adapter/acme-crm/emit', json(EMIT), { authorization: `Bearer ${SECRETS.adapterDoor}` }),
  },
  {
    id: 'emit-wrong-credential',
    note: 'A credential that matches no install is 401 with no detail.',
    arrange: () => {
      world.remoteInstalls.push(installOf(TEAM_1));
    },
    request: post('/api/public/adapter/acme-crm/emit', json(EMIT), { [ADAPTER_HEADER]: 'not-the-secret' }),
  },
  {
    id: 'emit-no-credential',
    note: 'No credential header at all is the same 401.',
    arrange: () => {
      world.remoteInstalls.push(installOf(TEAM_1));
    },
    request: post('/api/public/adapter/acme-crm/emit', json(EMIT)),
  },
  {
    id: 'emit-unknown-type',
    note: 'A type nobody installed is 401, exactly as a wrong credential.',
    request: post('/api/public/adapter/never-installed/emit', json(EMIT), { [ADAPTER_HEADER]: SECRETS.adapterDoor }),
  },
  {
    id: 'emit-builtin-slug-never-remote',
    note: 'A slug a built-in answers to is always 401, whatever rows exist.',
    arrange: () => {
      world.remoteInstalls.push(installOf(TEAM_1, { adapter_type: 'slack' }));
    },
    request: post('/api/public/adapter/slack/emit', json(EMIT), { [ADAPTER_HEADER]: SECRETS.adapterDoor }),
  },
  {
    id: 'emit-credential-shared-by-two-teams',
    note: 'One credential on installs in two teams is 409 until the caller names its team.',
    arrange: () => {
      world.remoteInstalls.push(installOf(TEAM_1), installOf(TEAM_2));
    },
    request: post('/api/public/adapter/acme-crm/emit', json(EMIT), { [ADAPTER_HEADER]: SECRETS.adapterDoor }),
  },
  {
    id: 'emit-shared-credential-team-named',
    note: 'x-listen-fire-team narrows the shared credential to one install.',
    arrange: () => {
      world.remoteInstalls.push(installOf(TEAM_1), installOf(TEAM_2));
    },
    request: post('/api/public/adapter/acme-crm/emit', json(EMIT), { [ADAPTER_HEADER]: SECRETS.adapterDoor, 'x-listen-fire-team': TEAM_2 }),
  },
  {
    id: 'emit-malformed-body-after-auth',
    note: 'The body is judged only after authentication: 400 with the issues.',
    arrange: () => {
      world.remoteInstalls.push(installOf(TEAM_1));
    },
    request: post('/api/public/adapter/acme-crm/emit', json({ events: [] }), { [ADAPTER_HEADER]: SECRETS.adapterDoor }),
  },
  {
    id: 'emit-malformed-body-unauthenticated',
    note: 'An unauthenticated caller learns nothing about the body shape: 401, not 400.',
    request: post('/api/public/adapter/acme-crm/emit', json({ events: [] })),
  },
  {
    id: 'emit-over-1mb',
    note: 'A body past 1 MB is refused 413 before anything is authenticated.',
    arrange: () => {
      world.remoteInstalls.push(installOf(TEAM_1));
    },
    request: post(
      '/api/public/adapter/acme-crm/emit',
      { kind: 'padded', value: EMIT, paddedToBytes: 1_100_000 },
      { [ADAPTER_HEADER]: SECRETS.adapterDoor },
    ),
  },
  {
    id: 'emit-capture-failure',
    note: 'An event whose receipt cannot be stored fails the call 500 with the counts, after the others were queued.',
    arrange: () => {
      world.remoteInstalls.push(installOf(TEAM_1));
      world.triggers.push({ id: 'trigger-1', movementId: 'movement-1', kind: 'acme-crm', credentialsId: null, config: {} });
      world.captureFails = true;
    },
    request: post('/api/public/adapter/acme-crm/emit', json(EMIT), { [ADAPTER_HEADER]: SECRETS.adapterDoor }),
  },
  {
    id: 'wake-good-credential',
    note: 'Wake keys are queued as await wakes for the caller team; 202 with the count.',
    arrange: () => {
      world.remoteInstalls.push(installOf(TEAM_1));
    },
    request: post('/api/public/adapter/acme-crm/wake', json({ keys: ['thread:abc', 'thread:def'] }), { [ADAPTER_HEADER]: SECRETS.adapterDoor }),
  },
  {
    id: 'wake-empty-keys',
    note: 'An empty key list is a 400.',
    arrange: () => {
      world.remoteInstalls.push(installOf(TEAM_1));
    },
    request: post('/api/public/adapter/acme-crm/wake', json({ keys: [] }), { [ADAPTER_HEADER]: SECRETS.adapterDoor }),
  },
  {
    id: 'wake-wrong-credential',
    note: 'Wake authenticates the same way: 401.',
    arrange: () => {
      world.remoteInstalls.push(installOf(TEAM_1));
    },
    request: post('/api/public/adapter/acme-crm/wake', json({ keys: ['k'] }), { [ADAPTER_HEADER]: 'nope' }),
  },
]);

// ── The shared Telegram bot ───────────────────────────────────────────────

const TG_HEADER = 'x-telegram-bot-api-secret-token';
const TG_UPDATE = { update_id: 10, message: { message_id: 5, text: 'hello', chat: { id: 9 }, from: { id: 3 } } };
const delivery = (result: unknown, extra: Record<string, unknown> = {}) => ({ result, ...extra });

export const telegramSharedCases: GoldenCase[] = define('telegram_shared', [
  {
    id: 'message-from-linked-sender',
    note: 'Right secret: the update is handed over, its work rows queued before the 200, the drain poked after.',
    arrange: () => {
      world.telegramBuiltin = () =>
        delivery(
          { ok: true, classification: 'message', routedTeamIds: ['team-1'] },
          { enqueueDeferred: async () => { record({ kind: 'enqueue_shared_bot_rows' }); return { teamIds: ['team-1'], readOutcome: async () => ({ ok: true }) }; } },
        );
    },
    request: post('/api/public/telegram/builtin', json(TG_UPDATE), { [TG_HEADER]: SECRETS.telegramShared }),
  },
  {
    id: 'wrong-secret',
    note: 'A wrong secret is answered 200 with classification unauthorized, and the handler is never called.',
    request: post('/api/public/telegram/builtin', json(TG_UPDATE), { [TG_HEADER]: 'wrong' }),
  },
  {
    id: 'missing-secret-header',
    note: 'No header: the same 200 unauthorized.',
    request: post('/api/public/telegram/builtin', json(TG_UPDATE)),
  },
  {
    id: 'secret-unset-refuses',
    note: 'With no secret configured the door fails closed (200 unauthorized).',
    arrange: () => withEnv({ TELEGRAM_WEBHOOK_SECRET: undefined }),
    request: post('/api/public/telegram/builtin', json(TG_UPDATE)),
  },
  {
    id: 'secret-unset-unsigned-allowed',
    note: 'With no secret and ALLOW_UNSIGNED_WEBHOOKS=true outside production, the dev loop can inject unsigned updates.',
    arrange: () => withEnv({ TELEGRAM_WEBHOOK_SECRET: undefined, ALLOW_UNSIGNED_WEBHOOKS: 'true' }),
    request: post('/api/public/telegram/builtin', json(TG_UPDATE)),
  },
  {
    id: 'invalid-json',
    note: 'A body that is not JSON is 400 invalid_json, before the secret is read.',
    request: post('/api/public/telegram/builtin', text('{not json'), { [TG_HEADER]: SECRETS.telegramShared }),
  },
  {
    id: 'non-json-content-type',
    note: 'A non-JSON content type is not read raw; the handler gets the empty object express leaves.',
    request: post('/api/public/telegram/builtin', text('x'), { 'content-type': 'text/plain', [TG_HEADER]: SECRETS.telegramShared }),
  },
  {
    id: 'callback-query-answered-inline',
    note: 'A button tap is settled wholly before the ack; the body carries the callback outcome.',
    arrange: () => {
      world.telegramBuiltin = () => delivery({ ok: true, classification: 'callback_query', callback: { handled: true, outcome: 'recorded' } });
    },
    request: post(
      '/api/public/telegram/builtin',
      json({ update_id: 11, callback_query: { id: 'cbq-9', data: 'cb_golden0001', message: { message_id: 11, chat: { id: 9 } } } }),
      { [TG_HEADER]: SECRETS.telegramShared },
    ),
  },
  {
    id: 'unlinked-sender-ignored',
    note: 'An unlinked sender is acked 200 and ignored (the spam gate).',
    arrange: () => {
      world.telegramBuiltin = () => delivery({ ok: true, classification: 'unlinked_ignore' });
    },
    request: post('/api/public/telegram/builtin', json(TG_UPDATE), { [TG_HEADER]: SECRETS.telegramShared }),
  },
  {
    id: 'enqueue-failure',
    note: 'Work rows that cannot be queued are the one non-2xx, so Telegram redelivers.',
    arrange: () => {
      world.telegramBuiltin = () =>
        delivery({ ok: true, classification: 'message', routedTeamIds: ['team-1'] }, { enqueueDeferred: async () => { throw new Error('queue unavailable'); } });
    },
    request: post('/api/public/telegram/builtin', json(TG_UPDATE), { [TG_HEADER]: SECRETS.telegramShared }),
  },
  {
    id: 'harness-team-drains-before-ack',
    note: 'A dev-loop delivery drains its rows and answers with the dispatch outcome.',
    arrange: () => {
      world.telegramBuiltin = () =>
        delivery(
          { ok: true, classification: 'message', routedTeamIds: ['team-harness'] },
          {
            enqueueDeferred: async () => ({ teamIds: ['team-harness'], readOutcome: async () => ({ ok: true, classification: 'message', perTeam: [{ teamId: 'team-harness', dispatched: true }] }) }),
            awaitDeferred: true,
          },
        );
    },
    request: post('/api/public/telegram/builtin', json(TG_UPDATE), { [TG_HEADER]: SECRETS.telegramShared }),
  },
  {
    id: 'handler-throws',
    note: 'A handler bug still answers 200 (no retry storm) with the error in the body.',
    arrange: () => {
      world.telegramBuiltin = () => {
        throw new Error('classifier exploded');
      };
    },
    request: post('/api/public/telegram/builtin', json(TG_UPDATE), { [TG_HEADER]: SECRETS.telegramShared }),
  },
]);

// ── The Listen-Fire Slack app: Events ─────────────────────────────────────

const SLACK_EVENT = { type: 'event_callback', event_id: 'Ev9', team_id: 'T9', event: { type: 'message', channel: 'C9', user: 'U9', ts: '1760702400.000900', text: 'hi' } };

export const slackEventsCases: GoldenCase[] = define('slack_events', [
  {
    id: 'good-signature',
    note: 'A signed event_callback is acked {ok:true} at once and handed to the router off-request.',
    request: post('/api/public/slack/events', json(SLACK_EVENT), slackHeaders(SECRETS.slackApp)),
  },
  {
    id: 'url-verification-needs-no-signature',
    note: 'The setup handshake is answered before any signature is read.',
    request: post('/api/public/slack/events', json({ type: 'url_verification', challenge: 'ch-slack-app' })),
  },
  {
    id: 'url-verification-missing-challenge',
    note: 'No string challenge: 400 missing_challenge.',
    request: post('/api/public/slack/events', json({ type: 'url_verification', challenge: 42 })),
  },
  {
    id: 'bad-signature',
    note: 'Another secret: 401 {ok:false}, nothing handed over.',
    request: post('/api/public/slack/events', json(SLACK_EVENT), slackHeaders(SECRETS.slackBring)),
  },
  {
    id: 'missing-signature-headers',
    note: 'No Slack headers: 401.',
    request: post('/api/public/slack/events', json(SLACK_EVENT)),
  },
  {
    id: 'secret-unset-refuses',
    note: 'No signing secret configured fails closed with 500 {ok:false}.',
    arrange: () => withEnv({ SLACK_MOVEMENTS_SIGNING_SECRET: undefined }),
    request: post('/api/public/slack/events', json(SLACK_EVENT)),
  },
  {
    id: 'secret-unset-unsigned-allowed',
    note: 'Unsigned deliveries are accepted only with ALLOW_UNSIGNED_WEBHOOKS=true outside production.',
    arrange: () => withEnv({ SLACK_MOVEMENTS_SIGNING_SECRET: undefined, ALLOW_UNSIGNED_WEBHOOKS: 'true' }),
    request: post('/api/public/slack/events', json(SLACK_EVENT)),
  },
  {
    id: 'signed-but-not-json',
    note: 'A signed body that is not JSON is 400 invalid_json.',
    request: post('/api/public/slack/events', text('not json at all'), slackHeaders(SECRETS.slackApp)),
  },
  {
    id: 'processing-fails-after-ack',
    note: 'A router failure after the ack is logged only; Slack already has its 200.',
    arrange: () => {
      world.slackEvents = () => {
        throw new Error('router failed');
      };
    },
    request: post('/api/public/slack/events', json(SLACK_EVENT), slackHeaders(SECRETS.slackApp)),
  },
]);

// ── The Listen-Fire Slack app: Interactivity ──────────────────────────────

const RESPONSE_URL = 'https://hooks.slack.test/actions/T9/1/abc';
const formOf = (payload: unknown) => ({ kind: 'form' as const, fields: { payload: JSON.stringify(payload) } });
const FORM = 'application/x-www-form-urlencoded';
const blockActions = (action: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'block_actions',
  response_url: RESPONSE_URL,
  actions: [action],
  ...extra,
});

export const slackActionsCases: GoldenCase[] = define('slack_actions', [
  {
    id: 'button-tap-fires-callback',
    note: 'A signed block action carrying a callback id fires it and replaces the original message via response_url.',
    request: post('/api/public/slack-actions', formOf(blockActions({ action_id: 'btn', value: 'cb_golden0001' })), slackHeaders(SECRETS.slackApp, FORM)),
  },
  {
    id: 'button-tap-closed-callback',
    note: 'A tap on a closed callback is an ephemeral notice and leaves the message.',
    arrange: () => {
      world.fireCallback = () => ({ kind: 'closed', callback: GOLDEN_CALLBACK });
    },
    request: post('/api/public/slack-actions', formOf(blockActions({ action_id: 'btn', value: 'cb_golden0001' })), slackHeaders(SECRETS.slackApp, FORM)),
  },
  {
    id: 'callback-firing-throws',
    note: 'A firing failure still tells the tapper.',
    arrange: () => {
      world.fireCallback = () => {
        throw new Error('ledger down');
      };
    },
    request: post('/api/public/slack-actions', formOf(blockActions({ action_id: 'btn', value: 'cb_golden0001' })), slackHeaders(SECRETS.slackApp, FORM)),
  },
  {
    id: 'date-picker-supplies-value',
    note: 'A control with no value rides the callback id in action_id and the tap-time capture as the supplied value.',
    request: post('/api/public/slack-actions', formOf(blockActions({ action_id: 'cb_golden0001', selected_date: '2026-11-02' })), slackHeaders(SECRETS.slackApp, FORM)),
  },
  {
    id: 'legacy-ask-answer-link',
    note: 'A legacy ask answer link in value is answered through the ask door.',
    arrange: () => {
      world.askAnswer = () => ({ kind: 'answered', ask: { answer: 'yes' } });
    },
    request: post('/api/public/slack-actions', formOf(blockActions({ action_id: 'btn', value: 'https://golden.example.test/api/asks/ask_tok1?answer=yes' })), slackHeaders(SECRETS.slackApp, FORM)),
  },
  {
    id: 'non-block-actions-payload',
    note: 'Anything else (a shortcut) is acked 200 and not acted on.',
    request: post('/api/public/slack-actions', formOf({ type: 'shortcut' }), slackHeaders(SECRETS.slackApp, FORM)),
  },
  {
    id: 'no-payload-field',
    note: 'A signed form with no payload is acked 200 and ignored.',
    request: post('/api/public/slack-actions', { kind: 'form', fields: { other: 'x' } }, slackHeaders(SECRETS.slackApp, FORM)),
  },
  {
    id: 'unrelated-action-ignored',
    note: 'A block action that is neither a callback nor an ask is ignored after the ack.',
    request: post('/api/public/slack-actions', formOf(blockActions({ action_id: 'overflow', value: 'something' })), slackHeaders(SECRETS.slackApp, FORM)),
  },
  {
    id: 'bad-signature',
    note: 'Another secret: 401.',
    request: post('/api/public/slack-actions', formOf(blockActions({ action_id: 'btn', value: 'cb_golden0001' })), slackHeaders(SECRETS.slackBring, FORM)),
  },
  {
    id: 'secret-unset-refuses',
    note: 'No signing secret configured: 500.',
    arrange: () => withEnv({ SLACK_MOVEMENTS_SIGNING_SECRET: undefined }),
    request: post('/api/public/slack-actions', formOf(blockActions({ action_id: 'btn', value: 'cb_golden0001' })), { 'content-type': FORM }),
  },
]);

// ── The WhatsApp number door ──────────────────────────────────────────────

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
            messages: [{ from: '15550002222', id: 'wamid.10', timestamp: '1760702400', type: 'text', text: { body: 'see https://example.com/a/b' } }],
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
            metadata: { phone_number_id: 'pn-1' },
            messages: [
              { from: '15550002222', id: 'wamid.11', timestamp: '1760702400', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'cb_golden0001', title: 'Approve' } } },
            ],
          },
        },
      ],
    },
  ],
};
const metaSig = (secret: string) => (body: Buffer) => ({ 'x-hub-signature-256': `sha256=${hmacHex(secret, body)}` });

export const whatsappCases: GoldenCase[] = define('whatsapp', [
  {
    id: 'verify-handshake',
    note: 'Meta GET handshake with the right token echoes the challenge.',
    request: { method: 'GET', path: '/api/public/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=golden-whatsapp-verify-token&hub.challenge=1158201444', headers: {}, body: { kind: 'none' } },
  },
  {
    id: 'verify-wrong-token',
    note: 'A wrong verify token is 403.',
    request: { method: 'GET', path: '/api/public/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1', headers: {}, body: { kind: 'none' } },
  },
  {
    id: 'verify-missing-params',
    note: 'No mode or token is 400.',
    request: { method: 'GET', path: '/api/public/whatsapp/webhook', headers: {}, body: { kind: 'none' } },
  },
  {
    id: 'message-good-signature',
    note: 'A signed text message: acked EVENT_RECEIVED; the sender is announced to ops and the message dispatched to its team (off-request).',
    request: post('/api/public/whatsapp/webhook', json(META_TEXT), metaSig(SECRETS.whatsappApp)),
  },
  {
    id: 'message-unknown-sender',
    note: 'An unknown sender is announced with the raw number; dispatch still runs.',
    arrange: () => {
      world.whatsappSender = { teamId: null, displayName: null };
    },
    request: post('/api/public/whatsapp/webhook', json(META_TEXT), metaSig(SECRETS.whatsappApp)),
  },
  {
    id: 'message-bad-signature',
    note: 'A digest from another secret is 401.',
    request: post('/api/public/whatsapp/webhook', json(META_TEXT), metaSig(SECRETS.whatsappSub)),
  },
  {
    id: 'message-missing-signature',
    note: 'No X-Hub-Signature-256 is 401.',
    request: post('/api/public/whatsapp/webhook', json(META_TEXT)),
  },
  {
    id: 'interactive-reply-fires-callback',
    note: 'A tapped reply button with a callback id fires it and replies from the receiving number.',
    request: post('/api/public/whatsapp/webhook', json(META_INTERACTIVE), metaSig(SECRETS.whatsappApp)),
  },
  {
    id: 'statuses-only-delivery',
    note: 'Delivery receipts are acked and not processed.',
    request: post(
      '/api/public/whatsapp/webhook',
      json({ object: 'whatsapp_business_account', entry: [{ id: 'waba-1', changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.1', status: 'delivered', timestamp: '1', recipient_id: '1' }] } }] }] }),
      metaSig(SECRETS.whatsappApp),
    ),
  },
  {
    id: 'other-object-never-answers',
    note: 'A signed body whose object is not whatsapp_business_account is never answered at all (the request hangs until the sender gives up).',
    request: { ...post('/api/public/whatsapp/webhook', json({ object: 'page', entry: [] }), metaSig(SECRETS.whatsappApp)), abortAfterMs: 400 },
  },
  {
    id: 'unsigned-door-refuses-without-secret',
    note: 'The door built with no app secret fails closed (401) unless unsigned deliveries are allowed.',
    request: post('/api/public/whatsapp-unsigned/webhook', json(META_TEXT)),
  },
  {
    id: 'unsigned-door-allowed-in-dev',
    note: 'With ALLOW_UNSIGNED_WEBHOOKS=true outside production, the no-secret door accepts the delivery.',
    arrange: () => withEnv({ ALLOW_UNSIGNED_WEBHOOKS: 'true' }),
    request: post('/api/public/whatsapp-unsigned/webhook', json(META_TEXT)),
  },
]);
