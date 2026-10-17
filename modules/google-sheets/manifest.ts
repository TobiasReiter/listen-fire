// Google Sheets' manifest: what the host's catalog, editor, handbook and
// checker read about the adapter, construction-free. Data only, so a host can
// list Google Sheets without loading the adapter.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { GOOGLE_SHEETS_ADAPTER_TYPE, SPREADSHEET_META_TYPE } from './types';

/**
 * Static manifest. Append target only (no v3 input → no `supportedTriggers`);
 * `createRecord` is a real append. `updateRecord` overwrites a row resolved
 * through `unique by` (row identity is derived per write — see row.ts);
 * `deleteRecord` stays unlisted (rows are never deleted through movements).
 *
 */
export const GOOGLE_SHEETS_MANIFEST: AdapterManifest = {
  adapterType: GOOGLE_SHEETS_ADAPTER_TYPE,
  displayName: 'Google Sheets',
  website: 'https://www.google.com/sheets/about/',
  category: 'Spreadsheets',
  description: 'Google Sheets. Append rows to a spreadsheet from your movements.',
  authoringHints:
    'Each Google spreadsheet holds its own tables, tabs and named cells, so ' +
    'this connection publishes ONE `Spreadsheet` collection, not the leaves. ' +
    'Reach a spreadsheet by narrowing it — ' +
    '`-[s:Spreadsheet WHERE `Title` == "Pipeline Sheet"]->` — or describe it ' +
    'by name (`types: ["Pipeline Sheet"]`); its leaves come back as that ' +
    'spreadsheet\'s edges (`Companies (table)`, `Sheet1 (sheet)`, ' +
    '`FX_Rate (cell)`). To name a leaf as a top-level type, start the ' +
    'instance at its spreadsheet — ' +
    '`google_sheets(credentials: acme, spreadsheet: "Pipeline Sheet")`. ' +
    'Writing `Spreadsheet` creates a new spreadsheet (`unique by (`Title`)` ' +
    'reuses an existing one), and cell writes hang off the spreadsheet ' +
    'handle: `write ss-[:Cells]->` / `write ss-[:`Named Cells`]->`. One ' +
    'spreadsheet per instance: to reach a second one, narrow to it or ' +
    'construct a second instance.',
  supportedTriggers: [],
  methods: ['listEntryPoints', 'describe', 'edgesFrom', 'resolveEntity', 'createRecord', 'updateRecord', 'readRecord', 'getFieldValue', 'getRelated'],
  requiredCredentialType: 'GOOGLE',
  vocabulary: {
    icon: {
      d: 'M11.318 12.545H7.91v-1.909h3.41v1.91zM14.728 0v6h6l-6-6zm1.363 10.636h-3.41v1.91h3.41v-1.91zm0 3.273h-3.41v1.91h3.41v-1.91zM20.727 6.5v15.864c0 .904-.732 1.636-1.636 1.636H4.909a1.636 1.636 0 0 1-1.636-1.636V1.636C3.273.732 4.005 0 4.909 0h9.318v6.5h6.5zm-3.273 2.773H6.545v7.909h10.91v-7.91zm-6.136 4.636H7.91v1.91h3.41v-1.91z',
      fill: true,
    },
  },
  triggerKinds: ['GOOGLE_SHEETS'],
  introspectedSchema: true,
  // Optional entry position: `google_sheets(credentials: X, spreadsheet: "Y")`
  // starts the cursor at that granted spreadsheet, so its tabs/tables/cells are
  // the writable roots. Value enum + landed node come from the `Spreadsheet`
  // collection off the meta node.
  positionArgs: [{ name: 'spreadsheet', optionsFrom: SPREADSHEET_META_TYPE, label: 'Spreadsheet' }],
  // Under `drive.file` scope the Drive Picker is the only way to grant
  // per-file access (and the only discovery mechanism — there's no
  // list-all API). The `google-sheets-picker` handler runs the Drive Picker,
  // persists the picked spreadsheet against this credential, and the granted
  // set then feeds `listEntryPoints` so its tables surface.
  // Declared as an ACTION BLOCK in the construction surface — the connect
  // affordance is, in the limit, an interactive block (config-blocks Phase 3).
  construction: [
    {
      kind: 'action',
      actionKind: 'google-sheets-picker',
      label: 'Connect a Google Sheet',
      help: 'Pick spreadsheets to make their tables available here.',
    },
  ],
};
