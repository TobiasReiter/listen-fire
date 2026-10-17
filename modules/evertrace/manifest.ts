// Evertrace's manifest: what the host's catalog, editor, handbook and checker
// read about the adapter, construction-free. Data only, so a host can list
// Evertrace without loading the adapter.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import {
  EVERTRACE_ADAPTER_TYPE,
  EVERTRACE_LIST_ENTRY_EVENT,
  EVERTRACE_SIGNAL_EVENT,
  EVERTRACE_SUBSCRIBABLE_EVENTS,
} from './types';

const EVERTRACE_HANDBOOK_CONTENT = `Evertrace watches public profiles and raises a **signal** when someone has just changed in a way worth knowing about — a new company, a stealth position, a departure, a new patent, grant or paper. Three surfaces: pull signals it has already found, react to new ones, and keep the saved searches and curated lists the workspace works from.

### signals — pulling what Evertrace already found

\`\`\`
since = Date.addDays(@current_date, -30)
evertrace-[s:Signals WHERE s.Score >= 8 AND s.\`Discovered At\` >= since]->
\`\`\`

There is no default time window: an unbounded walk covers the whole corpus, so give the WHERE a \`Discovered At\` lower bound and a \`Score\` floor.

Evertrace takes part of the WHERE itself and the rest is applied to what comes back, so the result is the same either way — only the amount fetched changes. What reaches Evertrace: \`Name\` (a partial match), \`Score\` (a floor), \`Country\`, \`City\`, \`Region\`, \`Gender\`, \`Age\`, \`Tags\`, and \`Source\`. \`Discovered At\` narrows what comes back. \`Age\` is a bucket over there — "Below 25", "25 to 29", through "Above 49". \`Tags\` carries two vocabularies: what the person is ("YC Alumni", "Big Tech experience", "Banking experience") and which event raised the signal ("New Company", "Stealth Position", "Left Position", "New Patent", "New Grant", "New Paper"). A WHERE naming values from one of them reaches Evertrace; one mixing both is applied to what comes back.

Below a signal, \`Experiences\` and \`Educations\` are the rows of the person's profile, each resolving one hop further to the \`Company\` or \`School\` Evertrace matched it to, when it matched one.

### listening — being told about new ones

\`\`\`
listen to evertrace { search: "Stealth in Europe", pollIntervalSeconds: 600 } fire triage
\`\`\`

A listener fires once per signal created since the last look. The FIRST look sets the mark and delivers nothing, so going live never replays the back catalogue — walk \`Signals\` when you want history. \`search\` names a saved search by its title or its id and narrows delivery to what that search matches; a date bound inside that search does not apply — the mark is what bounds delivery. \`pollIntervalSeconds\` overrides the five-minute default. A change to a signal that already exists does not fire — only a new one does. This is what a listener with no \`events\` delivers.

### listening — a signal added to a list

\`\`\`
listen to evertrace { events: ["list_entry"], list: "Pipeline" } fire file_it
\`\`\`

What arrives is the entry rather than the signal: \`Signal\` is the person, \`List\` is the list they went onto, and \`Added At\` is when. \`list\` names one list by its name or its id; leave it out and every list in the workspace delivers. The first look sets the mark and delivers nothing here too. Removing an entry and putting it back delivers again — that is a new entry.

### lists — filing a signal

A list owns its entries, so an entry lives under its list, and a signal's \`List Entries\` is that same membership seen from the other end. Both ends are required, so filing names them together:

\`\`\`
write (list-[:Entries]->, signal-[:\`List Entries\`]->) { }
\`\`\`

Adding is idempotent on the pair, so a repeat run never doubles a member. \`delete\` removes an entry. \`Lists\` and \`Searches\` are creatable, renameable and removable at the root; writing a search's \`Filters\` replaces the whole set rather than merging into it.

### lists — reading what is on one

\`\`\`
since = Date.addDays(@current_date, -7)
list-[e:Entries WHERE e.\`Added At\` >= since ORDER BY e.\`Added At\` DESC LIMIT 5]-> {
  …
}
\`\`\`

\`Added At\` is when the signal went onto the list, and it is the one thing Evertrace sorts entries by. Every other \`WHERE\` and \`ORDER BY\` runs over the list's entries once they arrive — the list is what bounds them, so a \`filter\` that calls \`ai\` over them is allowed here. A signal's \`List Entries\` reads the same memberships from the other end, and takes the same bracket.

Entries come back oldest first, so \`first\`, \`List.last\` and a bare \`LIMIT\` read them with no \`ORDER BY\`:

\`\`\`
oldest = first(list-[e:Entries]->)
Message: "Longest on the list: \${oldest-[s:Signal]->.Name}"
\`\`\`

A saved search's \`Signals\` takes the same bracket, and its own filters are what bound it — there is no order to lean on, so an \`ORDER BY\` says which one you mean.

### screening and viewing — facts about a signal

Marking a signal screened or viewed is a change to the signal itself, not a separate record:

\`\`\`
write signal { Screened: true }
\`\`\`

Evertrace has no un-view, so \`Viewed: false\` is refused; \`Screened: false\` does un-screen.

### what is deliberately not here

CSV exports, duplicating a saved search, screening and view counts, every signal sharing one LinkedIn profile, and the city lookup are each one endpoint away and not surfaced — say so rather than working around them.`;

/**
 * Static manifest. Polled source plus a real create/update/delete surface over
 * searches, lists and list memberships — so Evertrace is both a source and a
 * target. Nothing here is SUBSCRIBED to (there is no webhook): the event
 * vocabulary is the choice between the two things the poll can fetch, and the
 * `listen` options narrow each of them.
 */
export const EVERTRACE_MANIFEST: AdapterManifest = {
  adapterType: EVERTRACE_ADAPTER_TYPE,
  displayName: 'Evertrace',
  website: 'https://www.evertrace.ai',
  category: 'CRM',
  description:
    'Evertrace spots founders before they show up in startup databases — a ' +
    'signal is a person whose profile just triggered a trackable event. Pull ' +
    'signals, run on new ones, and file them into your saved searches and lists.',
  authoringHints:
    'Bound a Signals walk: there is no default lookback, so an unfiltered walk ' +
    'covers the whole corpus. A Score floor and a Discovered At lower bound are ' +
    'pushed to Evertrace; other filters are applied after the fetch. A list entry ' +
    'needs both its list and its signal, so write it along both edges at once. ' +
    'Screened and Viewed are fields on a signal, not separate records, and there ' +
    'is no un-view. A list’s Entries come back oldest first and take a WHERE, an ' +
    'ORDER BY and a LIMIT. A listener delivers new signals unless it says ' +
    'events: ["list_entry"], which delivers each signal added to a list.',
  handbookSection: {
    title: 'Evertrace — signals, saved searches and lists',
    content: EVERTRACE_HANDBOOK_CONTENT,
  },
  triggerExpectation:
    'Two kinds, selected with `events`. `signal` (the default) fires once per ' +
    'signal Evertrace created since the last poll, narrowed by the `search` ' +
    'listen option (a saved search, by title or id). `list_entry` fires once ' +
    'per signal added to a list since the last poll, narrowed by the `list` ' +
    'listen option (by name or id; absent means every list in the workspace). ' +
    'Each kind keeps its own checkpoint, and the first poll of a kind sets it ' +
    'and emits nothing, so going live never replays the back catalogue. ' +
    'Updates to an existing signal do NOT fire — Evertrace offers no ' +
    'changed-since mark other than creation.',
  supportedTriggers: ['poll'],
  methods: [
    'listEntryPoints', 'describe', 'edgesFrom', 'getFieldValue', 'getRelated',
    'readRecord', 'createRecord', 'updateRecord', 'deleteRecord',
  ],
  requiredCredentialType: 'EVERTRACE',
  // `events` is projected from `subscribableEvents` — Evertrace has no webhook
  // to subscribe to, but the selection is what tells the one poll source which
  // of its two event edges a listen is on, and what types the listened
  // parameter. No selection is the signal alone.
  subscribableEvents: [...EVERTRACE_SUBSCRIBABLE_EVENTS],
  defaultSubscribedEvents: [EVERTRACE_SIGNAL_EVENT],
  listenConfig: [
    { key: 'search', required: false },
    { key: 'list', required: false },
    { key: 'pollIntervalSeconds', required: false },
  ],
  triggerKinds: ['EVERTRACE'],
  vocabulary: {
    // A stroke "E" — the mark opens with a moveto, as path data must.
    icon: {
      d: 'M8 5 H17 M8 5 V19 M8 12 H15 M8 19 H17',
      fill: false,
      viewBox: '0 0 24 24',
    },
    eventPhrase: {
      [EVERTRACE_LIST_ENTRY_EVENT]: [
        { template: 'When a signal is added to the list `{list}`' },
        { template: 'When a signal is added to a list' },
      ],
      default: [{ template: 'When Evertrace finds a new signal' }],
    },
  },
};
