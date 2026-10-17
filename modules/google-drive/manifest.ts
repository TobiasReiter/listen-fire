// Google Drive's manifest: what the host's catalog, editor, handbook and
// checker read about the adapter, construction-free. Data only, so a host can
// list Google Drive without loading the adapter.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { GOOGLE_DRIVE_ADAPTER_TYPE } from './types';

/**
 * Static manifest. Create-only target (no inbound triggers); `createRecord`
 * is a real write. `updateRecord` / `deleteRecord` are NOT listed — Drive is
 * create-only and they throw.
 */
export const GOOGLE_DRIVE_MANIFEST: AdapterManifest = {
  adapterType: GOOGLE_DRIVE_ADAPTER_TYPE,
  displayName: 'Google Drive',
  website: 'https://www.google.com/drive/',
  category: 'Files',
  description:
    'Google Drive. Save files into Drive folders from your movements, and ' +
    'read the Drive tree — folders, files, and file content.',
  supportedTriggers: [],
  methods: [
    'listEntryPoints', 'describe', 'resolveEntity', 'createRecord',
    'getFieldValue', 'getRelated', 'resolveFileRef',
  ],
  requiredCredentialType: 'GOOGLE',
  triggerKinds: ['GOOGLE_DRIVE'],
  vocabulary: {
    icon: {
      d: 'M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z',
      fill: true,
    },
  },
  construction: [
    {
      kind: 'action',
      actionKind: 'google-drive-picker',
      label: 'Connect Drive files or folders',
      help: 'Pick files and folders to make them available to your movements.',
    },
  ],
};
