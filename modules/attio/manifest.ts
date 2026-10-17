// Attio's manifest: what the host's catalog, editor, handbook and checker read
// about the adapter, construction-free. Data only, so a host can list Attio
// without loading the adapter.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { ATTIO_ADAPTER_TYPE } from './types';

/**
 * Static manifest — the construction-free declaration the registry exposes via
 * `getAdapterManifest`. `supportedTriggers` is the single source for the class
 * field below. (Whole-adapter capability is the class's `runtimeCapabilities()`:
 * outgoing-only traversal, no edge properties, no resources — the retired
 * input-side `#resources` bundle is gone.)
 *
 */
export const ATTIO_MANIFEST: AdapterManifest = {
  adapterType: ATTIO_ADAPTER_TYPE,
  displayName: 'Attio',
  website: 'https://attio.com',
  category: 'CRM',
  description: 'The Attio CRM. Read companies, people, deals, and lists; create and update records; and run movements when records change in Attio.',
  authoringHints:
    'For any owner field, `@user_email` is the best value to set it from — it identifies the ' +
    'connected user as the record owner.',
  supportedTriggers: ['snapshot', 'webhook'],
  methods: [
    'listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue',
    'getRelated', 'listEventTypes', 'preprocessInbound', 'createRecord', 'updateRecord', 'deleteRecord',
    'linkRecords', 'unlinkRecords', 'readRecord', 'describeOpaqueId', 'translateFilter',
    'getActorCandidates', 'extractActor', 'ensureEventSubscription', 'removeEventSubscription',
    'resolveFileRef',
  ],
  requiredCredentialType: 'ATTIO',
  triggerKinds: ['ATTIO'],
  introspectedSchema: true,
  // The webhook event-type vocabulary movements can subscribe to
  // (`listen to crm { events: ["record.created"] } fire …`) — the same
  // names the webhook_sync provider registers by default.
  subscribableEvents: ['record.created', 'record.updated', 'record.deleted'],
  triggerExpectation:
    'Listen-Fire registers the Attio webhook automatically when a listener goes ' +
    'live, subscribed to record.created / record.updated / record.deleted — ' +
    'it fires when a RECORD in the workspace is created, updated or deleted, ' +
    'shortly after the change. It does not fire on notes, tasks, comments or ' +
    'emails. An update event identifies which record changed, not reliably ' +
    'which field — so do not promise field-level triggers ("when the stage ' +
    'changes") without gating on the event content, and narrow with listen ' +
    'events / record types rather than claiming everything is watched.',
  vocabulary: {
    icon: {
      d: "M29.755 22.362l.002-.001c.412.661.412 1.503 0 2.164l-2.515 4.025c-.002.004-.01.012-.01.012l-.2.32c-.37.591-1.031.959-1.73.959h-5.67c-.712 0-1.358-.359-1.732-.961l-2.027-3.235.267-.428 4.835-7.736.282-.453 4.046.014c.702 0 1.356.363 1.726.96l.198.316c.006.007.015.024.015.024zm-.767 1.683h.003c.23-.366.23-.837 0-1.203l-2.511-4.02c-.09-.146-.234-.164-.292-.164h-.028c-.018.003-.041.005-.067.013-.065.013-.14.054-.2.144l-.006.01-2.512 4.02c-.169.271-.215.601-.127.908.029.102.073.2.13.29l2.515 4.027c.062.101.172.163.291.163.096 0 .189-.041.253-.113.011-.016.025-.03.035-.05zm-6.666-11.408l-.004.001-1.917 3.07-5.999 9.6-2.024 3.237-.003.007v.004l-.208.33c-.374.6-1.02.96-1.732.96h-5.67c-.703.003-1.36-.361-1.73-.959l-2.723-4.359c-.414-.66-.414-1.503.002-2.162l10.153-16.251c.377-.6 1.024-.96 1.731-.96h5.67c.704-.002 1.361.361 1.732.959l.21.338 2.512 4.02c.41.662.41 1.503 0 2.165zm-.593-1.083c0-.208-.058-.417-.175-.602l-2.512-4.02c-.091-.147-.235-.164-.293-.164-.119-.001-.23.061-.292.163l-9.945 15.913c-.228.368-.228.834 0 1.202l2.513 4.027c.063.1.174.161.292.16.118.001.228-.06.291-.16l9.946-15.918c.117-.185.175-.394.175-.601z",
      fill: true,
      viewBox: "2 3 30 28",
    },
    eventPhrase: {
      // No per-event phrasing today (create/update/delete all shared one
      // generic sentence in the former switch) — `default` mirrors that.
      default: [{ template: 'When a record changes in Attio' }],
    },
  },
};
