// Dealroom's manifest: what the host's catalog, editor, handbook and checker
// read about the adapter, construction-free. Data only, so a host can list
// Dealroom without loading the adapter.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import {
  DEALROOM_ADAPTER_TYPE,
  DEALROOM_FUNDING_ROUND_EVENT,
  DEALROOM_SUBSCRIBABLE_EVENTS,
} from './types';

const DEALROOM_HANDBOOK_CONTENT = `Dealroom is a database of \`Companies\`, \`Investors\`, \`People\` and \`Funding Rounds\`, with the links between them. It is read-only: look something up by name or domain, walk out to what it is connected to, and react to new rounds.

### looking something up

\`\`\`
company = first(dealroom-[c:Companies WHERE c.Website == "acme.com"]->)
\`\`\`

A domain is the surest way to land on one company; a \`Name\` equality is an exact-name search and \`CONTAINS\` is a fuzzy one. Filter on \`Website\`, the domain on its own — \`Website URL\` holds the full URL and is applied after the fetch. Dealroom takes part of the WHERE itself and the rest is applied to what comes back, so the result is the same either way — only the amount fetched changes. What reaches Dealroom on \`Companies\`: \`Name\`, \`Website\`, \`Industries\`, \`Tags\`, \`Growth Stage\`, \`Company Status\`, \`HQ City\`, \`HQ Country\`, \`Total Funding\` and \`Launch Year\` bounds, and lower bounds on \`Last Updated\` and \`Created At\`. \`Investors\` takes \`Name\`, \`Website\`, \`Investor Type\`, \`Investment Stages\`, \`Industry Experience\` and the HQ location; \`People\` takes \`Name\`, \`Website\`, \`Gender\`, \`Backgrounds\`, the HQ location and flags like \`Is Strong Founder\`; \`Funding Rounds\` takes \`Round\`, \`Date\` bounds, \`Amount\` bounds and \`Is Verified\`.

An \`ORDER BY\` on \`Name\`, \`Total Funding\`, \`Last Updated\` or \`Created At\` reaches Dealroom's own sort, so \`LIMIT 5\` is one page rather than a scan. An unbounded walk stops at Dealroom's 10,000-result ceiling with an error rather than a short answer — narrow it or bound it.

### walking out from a company

\`\`\`
company-[r:\`Funding Rounds\`]-> { … }
company-[i:Investors]-> { … }
company-[t:Team WHERE t.\`Is Founder\` == TRUE]-> { … }
\`\`\`

Each of these is the FULL list from its own endpoint, not the five that ride the company record. \`Similar Companies\` is Dealroom's own "companies like this one".

Give every fold over a Dealroom walk — \`Text.join\`, \`first\`, \`List.last\`, \`LIMIT\` — an explicit \`ORDER BY\`, since Dealroom hands a walk back in no inherent order:

\`\`\`
rounds = Text.join(company-[r:\`Funding Rounds\` ORDER BY r.Date DESC]->.Round, ", ")
\`\`\`

\`Team\` lands on a membership rather than the person: \`Titles\`, \`Is Founder\`, \`Is Executive\`, \`Is Partner\`, \`Past\`, \`Start Year\` and \`End Year\` are facts about the pair. \`Person\` from there is the full profile, and costs a fetch.

An \`Investor\` walks to \`Investments\`, \`Funding Rounds\`, \`Co-Investors\`, \`Funds\` and \`Team\` the same way. A person walks to \`Companies\` — that one rides the person's own record, so it costs nothing and carries the summary fields rather than the full company.

### rounds

A round's \`Company\` is who raised. Its \`Investors\` are participations, not backers themselves: \`Lead\` is a fact about the pair, and \`Investor\` from one is the full record. \`Unknown Investors\` are names Dealroom has no record for, so they are NOT on \`Investors\`.

\`Date\` is the round's year and month as a date — Dealroom records no day, so every round in a month reads as the first of it.

### listening — a new round

\`\`\`
listen to dealroom { rounds: ["SERIES A"], hq_locations: ["Europe"] } fire triage
\`\`\`

A listener fires once per round Dealroom RECORDED since the last look. The FIRST look sets the mark and delivers nothing, so going live never replays the back catalogue — walk \`Funding Rounds\` when you want history. \`rounds\`, \`industries\` and \`hq_locations\` narrow delivery; \`pollIntervalSeconds\` overrides the ten-minute default. A round that is corrected afterwards does not fire again: recording is the only "new since" Dealroom offers.

### what is deliberately not here

Universities and alumni, news feeds, traffic and social analytics, the bulk and dump exports, the filter catalogues, the location lookup, the removed-entity and GDPR logs, and the "tell Dealroom about a company it is missing" endpoint are each one endpoint away and not surfaced — say so rather than working around them. Nothing is writable: Dealroom is a database you read.`;

/**
 * Static manifest. A polled source with no write surface at all — Dealroom's
 * only mutating endpoint asks their team to research a company it is missing,
 * which is a support request rather than a record write.
 */
export const DEALROOM_MANIFEST: AdapterManifest = {
  adapterType: DEALROOM_ADAPTER_TYPE,
  displayName: 'Dealroom',
  website: 'https://dealroom.co',
  category: 'CRM',
  description:
    'Dealroom is a database of startups, investors, founders and funding ' +
    'rounds. Look a company or investor up by name or domain, walk to its ' +
    'rounds, backers and team, and run when a new round is recorded.',
  authoringHints:
    'Dealroom is read-only — there is no write surface. Land on one company by ' +
    'Website (the domain on its own) rather than Name; Website URL holds the ' +
    'full URL and filters after the fetch. A root walk with no WHERE covers the ' +
    'corpus and fails at the 10,000-result ceiling, so narrow it or give it a ' +
    'LIMIT. Every fold over a Dealroom walk — Text.join, first, List.last, LIMIT — ' +
    'needs an explicit ORDER BY on the hop, as in -[r:Rounds ORDER BY r.Date DESC]->. ' +
    'Team memberships and a round’s investors are nodes in their own right ' +
    'because the titles and the lead flag belong to the pair; walk Person or ' +
    'Investor from one for the full record, at the cost of a fetch. A listener ' +
    'fires on rounds Dealroom recorded since the last poll, and the first poll ' +
    'delivers nothing.',
  handbookSection: {
    title: 'Dealroom: companies, investors, rounds',
    content: DEALROOM_HANDBOOK_CONTENT,
  },
  triggerExpectation:
    'One kind: `funding_round`. It fires once per round Dealroom RECORDED ' +
    'since the last poll (`created_utc`), narrowed by the `rounds`, ' +
    '`industries` and `hq_locations` listen options, each a Dealroom terms ' +
    'filter. The first poll sets the checkpoint and emits nothing, so going ' +
    'live never replays the back catalogue. A round that is edited afterwards ' +
    'does NOT fire — Dealroom offers no changed-since mark other than ' +
    'recording. Companies, investors and people do not fire at all; the same ' +
    'question is a root walk with a `Created At` lower bound.',
  supportedTriggers: ['poll'],
  methods: ['listEntryPoints', 'describe', 'edgesFrom', 'getFieldValue', 'getRelated', 'readRecord'],
  requiredCredentialType: 'DEALROOM',
  // `events` is projected from `subscribableEvents` — Dealroom has no webhook
  // to subscribe to, but the value is what types the listened parameter and
  // what the poll source reads to decide what to fetch.
  subscribableEvents: [...DEALROOM_SUBSCRIBABLE_EVENTS],
  defaultSubscribedEvents: [DEALROOM_FUNDING_ROUND_EVENT],
  listenConfig: [
    { key: 'rounds', required: false },
    { key: 'industries', required: false },
    { key: 'hq_locations', required: false },
    { key: 'pollIntervalSeconds', required: false },
  ],
  triggerKinds: ['DEALROOM'],
  vocabulary: {
    // A stroke "D" — the mark opens with a moveto, as path data must.
    icon: {
      d: 'M8 5 H13 A7 7 0 0 1 13 19 H8 Z',
      fill: false,
      viewBox: '0 0 24 24',
    },
    eventPhrase: {
      default: [{ template: 'When Dealroom records a new funding round' }],
    },
  },
};
