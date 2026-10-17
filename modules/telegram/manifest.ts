// Telegram's manifest: what the host's catalog, editor, handbook and checker
// read about the adapter, construction-free. Data only, so a host can list
// Telegram without loading the adapter.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { TELEGRAM_HANDBOOK_SECTION } from './handbook_section';
import { TELEGRAM_ADAPTER_TYPE } from './types';

/**
 * Static manifest — the construction-free declaration the registry exposes via
 * `getAdapterManifest`. Telegram is BOTH source (inbound text + media) and
 * target (`createRecord` sends a message — a real write).
 *
 */
export const TELEGRAM_MANIFEST: AdapterManifest = {
  adapterType: TELEGRAM_ADAPTER_TYPE,
  displayName: 'Telegram',
  website: 'https://telegram.org',
  category: 'Messaging',
  description:
    'Telegram. Run movements on messages your bot receives, reply in-thread, ' +
    'and DM people who have linked Telegram — every send anchors on a message ' +
    'or a linked user.',
  triggerExpectation:
    'Telegram delivers a message to the bot only when the bot is in the chat ' +
    'AND the message reaches it: in a private one-to-one chat the bot sees ' +
    'every message sent to it; in a group it sees only direct replies to it ' +
    'and @-mentions. The bot has NO access to the user\'s other chats — their ' +
    'Telegram at large is never read. The natural framing is the bot chat as ' +
    'a deliberate capture channel: the user messages (or forwards to) the bot ' +
    'and that is the trigger surface. Do not promise "every message in a ' +
    'group": that requires the bot-OWNER disabling privacy mode in BotFather, ' +
    'which for Listen-Fire\'s built-in shared bot is not available (it stays on) — ' +
    'only a team running its own bot can change it, so if a user wants ' +
    'all-group capture, say it needs their own bot and ask. ' +
    'On the built-in shared bot, only linked senders reach a team at all: a ' +
    'person must complete the /start handshake before their messages route ' +
    'anywhere. A team running its own bot has no such gate — every update ' +
    'their bot sees routes to them, linked or not.',
  supportedTriggers: ['webhook'],
  // `createRecord` sends the unified message along an edge — a DM (Linked
  // User's `Messages`) or a threaded reply (a message's `Replies`) — a real
  // write (so Telegram is writable). `updateRecord` / `deleteRecord` are NOT
  // listed: the overrides throw (v1 only sends), so they aren't genuine
  // implementations. `listEventTypes` tags the inbound message so the engine
  // seeds a STABLE position (what lets a reply write anchor off the inbound).
  methods: [
    'listEntryPoints', 'describe', 'getFieldValue', 'getRelated',
    'preprocessInbound', 'getActorCandidates', 'extractActor', 'resolveFileRef',
    'createRecord', 'listEventTypes',
  ],
  requiredCredentialType: 'TELEGRAM',
  triggerKinds: ['TELEGRAM'],
  handbookSection: TELEGRAM_HANDBOOK_SECTION,
  vocabulary: {
    icon: {
      d: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z',
      fill: true,
    },
  },
};
