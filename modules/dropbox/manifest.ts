// Dropbox's manifest: what the host's catalog, editor, handbook and checker
// read about the adapter, construction-free. Data only, so a host can list
// Dropbox without loading the adapter.

import type { WireOAuth2Declaration } from 'engine-contracts';
import type { AdapterManifest } from 'movement-engine/public/adapter';
import type { z } from 'zod';

import { DROPBOX_ADAPTER_TYPE } from './types';

/** How a Dropbox credential is connected and refreshed. `token_access_type=offline`
 *  is what makes Dropbox issue a refresh token at all. */
export const DROPBOX_OAUTH2: z.infer<typeof WireOAuth2Declaration> = {
  authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
  tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
  clientAuth: 'body',
  authorizeParams: { token_access_type: 'offline' },
};

/**
 * Static manifest. Create-only target (no inbound triggers); `createRecord`
 * is a real write. `updateRecord` / `deleteRecord` are NOT listed — Dropbox
 * is create-only and they throw.
 */
export const DROPBOX_MANIFEST: AdapterManifest = {
  adapterType: DROPBOX_ADAPTER_TYPE,
  displayName: 'Dropbox',
  website: 'https://www.dropbox.com',
  category: 'Files',
  description:
    'Dropbox. Save files into Dropbox folders from your movements, and read ' +
    'the Dropbox tree — folders, files, and file content.',
  supportedTriggers: [],
  methods: [
    'listEntryPoints', 'describe', 'resolveEntity', 'createRecord',
    'getFieldValue', 'getRelated', 'resolveFileRef',
  ],
  requiredCredentialType: 'DROPBOX',
  triggerKinds: ['DROPBOX'],
  vocabulary: {
    icon: {
      d: 'M6 1.807L0 5.629l6 3.822 6.001-3.822L6 1.807zM18 1.807l-6 3.822 6 3.822 6-3.822-6-3.822zM0 13.274l6 3.822 6.001-3.822L6 9.452l-6 3.822zM18 9.452l-6 3.822 6 3.822 6-3.822-6-3.822zM6 18.371l6.001 3.822 6-3.822-6-3.822L6 18.371z',
      fill: true,
    },
  },
};
