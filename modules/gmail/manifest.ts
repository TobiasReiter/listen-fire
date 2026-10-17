// Gmail's manifest: what the host's catalog, editor, handbook and checker
// read about the adapter, construction-free. Data only, so a host can list
// Gmail without loading the adapter.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { GMAIL_SEARCH_CEILING, GMAIL_WRITE_RULE } from './schema';
import { GMAIL_ADAPTER_TYPE, GMAIL_MESSAGE_RECEIVED_EVENT, GMAIL_SUBSCRIBABLE_EVENTS } from './types';

const GMAIL_HANDBOOK_CONTENT = `Gmail is ONE connected mailbox — a real Google Workspace address the connection is signed in as. It is not the forwarding address: that one only ever sees mail somebody sent to it, while this reads the inbox itself.

### running when mail arrives

\`\`\`
listen to gmail { query: "from:@acme.com" } fire triage
\`\`\`

A listener fires once per message that has arrived since the last look, a minute or so behind. \`query\` is a Gmail search written exactly as you would type it into Gmail's own search box, and it narrows what is delivered; \`pollIntervalSeconds\` overrides the one-minute default. \`labels\` says which arrivals count — mail landing in the inbox unless you say otherwise. Write \`labels: ["INBOX", "SPAM"]\` when mail you must not miss can land in Spam, such as cold inbound. The FIRST look sets the mark and delivers nothing, so going live never replays the back catalogue — walk \`Messages\` when you want history.

### reading the message

\`\`\`
function triage(msg: <gmail-[:Message]->>) {
  who  = msg.From
  what = msg.Body
}
\`\`\`

\`Body\` is the one to reach for: it is the plain text, derived from the HTML when the message carried only HTML. \`Plain Body\` and \`HTML Body\` are there when you need the alternative that actually arrived. \`From\` is the whole header, display name included; \`To\` and \`Cc\` are lists of addresses. \`Labels\` are Gmail's label ids — \`INBOX\`, \`UNREAD\` and the rest in capitals, a user label by its own name.

### searching the mailbox

\`\`\`
recent = gmail-[m:Messages WHERE m.From CONTAINS "acme.com" AND m.Date WITHIN 7d]->
\`\`\`

\`Subject\`, \`From\`, \`To\`, \`Cc\`, \`Labels\`, \`Date\` and \`Body\` reach Gmail's own search; everything else is applied after the fetch, so the result is the same either way and only the amount fetched changes. A walk stops at ${GMAIL_SEARCH_CEILING} messages, because every message costs its own request — narrow it or give it a \`LIMIT\` rather than expecting the whole mailbox. Gmail answers newest first, so \`ORDER BY Date DESC LIMIT n\` costs n requests; any other \`ORDER BY\` fetches up to ${GMAIL_SEARCH_CEILING} and sorts them here.

### attachments

\`\`\`
msg-[a:Attachments]-> { … a.File … }
\`\`\`

Listing them is free — the names, types and sizes ride the message. Only reading \`File\` fetches bytes, so a message whose files nobody opens costs nothing. \`Has Attachments\` answers "are there any" without a walk.

### sending and replying

\`\`\`
write mail-[:Messages]-> {
  To: ["rita@acme.com"]
  Subject: "Your Q3 figures"
  Body: "Attached, as promised."
  Files: [doc]
}
\`\`\`

\`\`\`
write msg-[:Replies]-> { Body: "Got it — looking now." }
\`\`\`

${GMAIL_WRITE_RULE} So a reply names only what it says: it answers whoever sent the message it hangs off, it carries that subject with \`Re:\` in front, and Gmail files it in the same conversation. Override \`To\`, \`Cc\` or \`Subject\` on a reply when you mean something other than the obvious, and reach for \`HTML Body\` beside \`Body\` when the message needs formatting — both go out, and a reader that cannot show HTML still sees the text. \`Files\` takes a list of file values the run already holds; the files on a message you RECEIVED are on its \`Attachments\` edge instead.

Mail always leaves as the connected mailbox — \`From\` is not writable, because that address is the only one this deployment is allowed to be.

### what this connection cannot do

It reads mail and sends mail. It can NEVER label, archive, delete, mark as read, or touch a draft — the two scopes it holds are read and send, so those are not features waiting to be built but things the mailbox has not granted. Say so rather than working around it. A message that is edited or re-labelled afterwards does not fire again: arrival is the only event here, and nothing fires on mail this mailbox sends. Reading always works; SENDING works only where the installation enabled it, and a mailbox without it refuses a send saying so, with reads unaffected — so a send failing never means the mailbox is disconnected. An installation may also limit which addresses can be connected at all.`;

/**
 * Static manifest. A polled source AND a target: `createRecord` sends as the
 * mailbox, along the root's `Messages` edge for new mail and along a message's
 * `Replies` edge for a reply.
 */
export const GMAIL_MANIFEST: AdapterManifest = {
  adapterType: GMAIL_ADAPTER_TYPE,
  displayName: 'Gmail',
  website: 'https://mail.google.com',
  category: 'Email',
  description:
    'One Google Workspace mailbox, read and written by automations. Run when ' +
    'mail arrives, search the inbox, read a message with its attachments, and ' +
    'send or reply as the mailbox. Connected by signing in as that mailbox, so ' +
    'the connection reaches it and no other address; sending is available only ' +
    'where the installation enabled it.',
  authoringHints:
    'Gmail reads and sends, and does nothing else: no labelling, archiving, ' +
    'deleting or drafts at all — those scopes were never granted. Reading ' +
    'always works; a mailbox whose installation did not enable sending refuses ' +
    'a send outright and says so, and that never means reads are broken too. ' +
    'Read `Body` ' +
    'for what a message says; `Plain Body` and `HTML Body` are the alternatives ' +
    `as they arrived. ${GMAIL_WRITE_RULE} A send sets \`To\`, \`Subject\` and ` +
    '`Body`; a reply needs only a body. Subject, From, To, Cc, Labels, Date and ' +
    'Body reach Gmail’s own search; a walk with no WHERE stops at ' +
    `${GMAIL_SEARCH_CEILING} messages, since each one costs a request. A ` +
    'listener’s `query` option is a Gmail search string written exactly as ' +
    'in Gmail’s search box; its `labels` option (Gmail label ids, default ' +
    '`["INBOX"]`) says which arrivals count, so add `"SPAM"` when mail that ' +
    'must not be missed can land in Spam. The first poll delivers nothing.',
  handbookSection: {
    title: 'Gmail: one connected mailbox',
    content: GMAIL_HANDBOOK_CONTENT,
  },
  triggerExpectation:
    'One kind: `message_received`. It fires once per message that has ARRIVED ' +
    'in the mailbox since the last poll, about a minute behind, narrowed by the ' +
    '`query` listen option (a Gmail search string). The first poll sets the ' +
    'mark and emits nothing, so going live never replays the back catalogue. It ' +
    'reads mail arriving in the INBOX by default — widen with the `labels` ' +
    'listen option (e.g. `labels: ["INBOX", "SPAM"]` to include Spam), and ' +
    'narrow with `query`. A message that is later edited, ' +
    're-labelled or replied to does NOT fire again: arrival is the only event ' +
    'Gmail offers here. Nothing fires on mail this mailbox SENDS.',
  supportedTriggers: ['poll'],
  methods: [
    'listEntryPoints', 'describe', 'edgesFrom', 'getFieldValue', 'getRelated',
    'readRecord', 'resolveFileRef', 'createRecord',
  ],
  requiredCredentialType: 'GOOGLE_GMAIL',
  // `events` is projected from `subscribableEvents` — Gmail has no webhook to
  // subscribe to, but the value is what types the listened parameter.
  subscribableEvents: [...GMAIL_SUBSCRIBABLE_EVENTS],
  defaultSubscribedEvents: [GMAIL_MESSAGE_RECEIVED_EVENT],
  listenConfig: [
    { key: 'query', required: false },
    { key: 'labels', required: false, format: 'strings' },
    { key: 'pollIntervalSeconds', required: false },
  ],
  // No `triggerKinds`: the slug self-aliases, and the uppercase `GMAIL` kind is
  // already claimed by the inbound-email adapter for forwarded mail. Trigger
  // rows for this adapter carry the slug, as every polled source's do.
  vocabulary: {
    // The envelope's flap — an M laid over a rectangle, which is the mark
    // everybody reads as mail.
    icon: {
      d: 'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 3.2V17h16V8.2l-8 5.3-8-5.3z',
      fill: true,
      viewBox: '0 0 24 24',
    },
    eventPhrase: {
      default: [
        { template: 'When a message arrives matching `{query}`' },
        { template: 'When a message arrives in the mailbox' },
      ],
    },
  },
};
