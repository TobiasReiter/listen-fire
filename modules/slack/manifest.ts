// Slack's manifest: what the host's catalog, editor, handbook and checker
// read about the adapter, construction-free. Data only, so a host can list
// Slack without loading the adapter.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { SLACK_HANDBOOK_SECTION } from './handbook_section';
import { SLACK_ADAPTER_TYPE } from './types';

/**
 * Static manifest — the construction-free declaration the registry exposes via
 * `getAdapterManifest`. Slack is BOTH source (inbound text + attachments) and
 * target (its `createRecord` posts a message / thread reply — a real write, so
 * Slack is a usable destination).
 *
 */
export const SLACK_MANIFEST: AdapterManifest = {
  adapterType: SLACK_ADAPTER_TYPE,
  displayName: 'Slack',
  website: 'https://slack.com',
  category: 'Messaging',
  description:
    'Slack. Post messages into channels from your movements, run movements ' +
    'on inbound Slack activity, and read the workspace graph — channels, ' +
    'members, message history and threads.',
  triggerExpectation:
    'Slack only delivers the events its app is subscribed to in the Slack ' +
    'admin — it does NOT see every message by default. The common setup is ' +
    '@-mentions of the bot (and replies in threads it is part of); seeing ' +
    'all channel messages requires the workspace to enable the message.channels ' +
    'scope, which many teams do not. So do not promise "every message in a ' +
    'channel" — describe it as firing when the bot is mentioned, and if the ' +
    'user actually wants all-message capture, tell them it depends on their ' +
    'Slack app scopes and ask. Narrow further in the listen with ' +
    'events: ["app_mention"] / ["message"] / ["reaction_added"], and to specific ' +
    'channels with channels: ["dealflow", ...] (by channel name). ' +
    'Also: a listener only fires when the message\'s SENDER (or the person who ' +
    'reacted) resolves to a registered member of this team (matched by Slack ' +
    'profile email). Activity from unregistered people — guests, external ' +
    'members of shared channels, other bots, and Listen-Fire\'s own posts — is dropped ' +
    'before any automation runs, so do not promise runs on activity from people ' +
    'outside the team.',
  inboundRequiresRegisteredActor: true,
  handbookSection: SLACK_HANDBOOK_SECTION,
  supportedTriggers: ['webhook'],
  // The listen `events` vocabulary — the Slack inner-event types a movement can
  // subscribe to. `message` covers every message.* subscription (channels / im /
  // groups / mpim); `reaction_added` fires the Slack Reaction event type.
  subscribableEvents: ['app_mention', 'message', 'reaction_added'],
  // `listen to <slack> { channels: ["dealflow", ...] }` narrows a listener to
  // specific channels by NAME. Optional; values are channel names (unvalidated
  // here — the live workspace roster isn't in the static manifest). Enforced at
  // the dispatch gate (resolve the event's channel → name, drop non-matches).
  listenConfig: [{ key: 'channels' }],
  // `createRecord` posts a message — a real write (so Slack is writable).
  // `updateRecord` / `deleteRecord` are deliberately NOT listed: Slack's
  // overrides throw (the v3 output only ever posts), so they aren't genuine
  // implementations.
  methods: [
    'listEntryPoints', 'describe', 'getFieldValue', 'getRelated', 'preprocessInbound',
    'getActorCandidates', 'extractActor', 'resolveFileRef',
    'createRecord', 'invokeFieldFunction', 'listEventTypes',
  ],
  requiredCredentialType: 'SLACK',
  triggerKinds: ['SLACK'],
  vocabulary: {
    icon: {
      d: 'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z',
      fill: true,
    },
    eventPhrase: {
      // No per-event phrasing today (app_mention / message / reaction_added
      // all shared one generic sentence in the former switch) — `default`
      // mirrors that, channel→routing-key→bare.
      default: [
        { template: 'When a Slack message arrives in {channel}' },
        { template: 'When a Slack message arrives in `{key}`' },
        { template: 'When a Slack message arrives' },
      ],
    },
  },
};
