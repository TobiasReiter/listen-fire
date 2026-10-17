// Airtable's manifest: what the host's catalog, editor, handbook and checker
// read about the adapter, construction-free. Data only, so a host can list
// Airtable without loading the adapter.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { AIRTABLE_ADAPTER_TYPE, BASE_META_TYPE, TABLE_META_TYPE } from './types';
import { AIRTABLE_SUBSCRIBABLE_EVENTS } from './webhook';

/**
 * Static manifest. A full create/update/delete write surface makes it writable;
 * `webhook` triggers light up the source side — a movement fires when records
 * change in a watched (base, table).
 *
 */
export const AIRTABLE_MANIFEST: AdapterManifest = {
  adapterType: AIRTABLE_ADAPTER_TYPE,
  displayName: 'Airtable',
  website: 'https://airtable.com',
  category: 'Spreadsheets',
  description:
    'Airtable. Read your bases, create, update, or delete rows from your ' +
    'movements, and run movements when records change in a table.',
  authoringHints:
    'Each Airtable base holds its own tables, so this connection publishes ' +
    'ONE `Base` collection, not the tables. Reach a base by narrowing it — ' +
    '`-[b:Base WHERE `Name` == "Sales CRM"]->` — or describe it by name ' +
    '(`types: ["Sales CRM"]`); its tables come back as that base\'s edges. To ' +
    'write to a table, start the instance at its base — ' +
    '`airtable(credentials: acme, base: "Sales CRM")` — and the base\'s tables ' +
    'become the types you name, by their own names (`Companies`) — the base is ' +
    'already the instance, so it is not repeated in the name. Without `base:` ' +
    'the instance sits at the whole workspace, where no table is nameable. ' +
    'One base per instance: to reach a second base, construct a second ' +
    'instance.',
  supportedTriggers: ['webhook'],
  methods: [
    'listEntryPoints', 'describe', 'edgesFrom', 'resolveEntity', 'getFieldValue',
    'getRelated', 'createRecord', 'updateRecord', 'deleteRecord', 'readRecord',
    'preprocessInbound', 'listEventTypes', 'ensureEventSubscription', 'removeEventSubscription',
  ],
  requiredCredentialType: 'AIRTABLE',
  triggerKinds: ['AIRTABLE'],
  introspectedSchema: true,
  vocabulary: {
    icon: {
      d: 'M11.992 1.966c-.434 0-.87.086-1.28.257L1.779 5.917c-.503.208-.49.908.012 1.116l8.982 3.558a3.266 3.266 0 0 0 2.454 0l8.982-3.558c.503-.196.503-.908.012-1.116l-8.957-3.694a3.255 3.255 0 0 0-1.272-.257zM23.4 8.056a.589.589 0 0 0-.222.045l-10.012 3.877a.612.612 0 0 0-.38.564v8.896a.6.6 0 0 0 .821.552L23.62 18.1a.583.583 0 0 0 .38-.551V8.653a.6.6 0 0 0-.6-.596zM.676 8.095a.644.644 0 0 0-.48.19C.086 8.396 0 8.53 0 8.69v8.355c0 .442.515.737.908.54l6.27-3.006.307-.147 2.969-1.436c.466-.22.43-.908-.061-1.092L.883 8.138a.57.57 0 0 0-.207-.044z',
      fill: true,
    },
  },
  // The change kinds a `listen to <airtable> { events: [...] }` can subscribe
  // to — projected as the `events` listen-config value vocabulary and folded
  // into the external webhook registration's `changeTypes`.
  subscribableEvents: [...AIRTABLE_SUBSCRIBABLE_EVENTS],
  // Airtable webhooks are per-(base, table): two listens on different tables
  // need distinct registrations, so (base, table) joins (adapter, credential)
  // as the subscription-channel identity.
  subscriptionScopeKeys: ['base', 'table'],
  // Entry position: `airtable(credentials: X, base: "MASTER")` starts the
  // instance AT that base, so its tables are the types a movement names. This
  // is the auto-traversal that makes a table nameable — omitted, the instance
  // sits at the workspace root, where the types are the BASES and no table is
  // nameable (naming a table needs a base: by walking to it, or by this).
  // Value enum = the base names, drawn from the `Base` collection off the meta
  // node.
  positionArgs: [{ name: 'base', optionsFrom: BASE_META_TYPE, label: 'Base' }],
  // `base` + `table` are required routing config — a listen must name the
  // watched table; `events` (optional) defaults to all change kinds.
  //
  // They are also the ADDRESS of the table the event's `Record` edge lands on:
  // a listen is shorthand for a WHERE, so naming the table here is what narrows
  // the edge, and the author never restates it in the movement. A two-hop path
  // (base first, then only THAT base's tables) — never a fanout across bases.
  // Both match on `Id` because a listen names by id while type-space addresses
  // by name; `rootHop`/`baseHop` publish `Id` on the members for exactly this.
  listenConfig: [
    { key: 'base', required: true, narrows: { collection: BASE_META_TYPE, matchField: 'Id' } },
    { key: 'table', required: true, narrows: { collection: TABLE_META_TYPE, matchField: 'Id' } },
  ],
  triggerExpectation:
    'A listener watches ONE Airtable table — the base + table named on the ' +
    'listen — with the webhook managed automatically. Airtable notifies that ' +
    'something changed and Listen-Fire pulls the actual changes, so events arrive ' +
    'as record created/updated/deleted for that table, usually within ' +
    'seconds but coalesced by Airtable (rapid edits can land as one batch). ' +
    'Do not promise cross-table or whole-base capture from one listener — ' +
    'each watched table is its own listen.',
};
