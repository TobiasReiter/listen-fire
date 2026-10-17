// The adapter over a test's client: no files to read, a silent log.

import type { GmailApiClient } from '../api_client';

import { GmailAdapter } from '../adapter';

export const silentLog = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

export function adapterOver(client: GmailApiClient): GmailAdapter {
  return new GmailAdapter({
    client: async () => client,
    readFile: async () => {
      throw new Error('this test hands the adapter no files to read');
    },
    log: silentLog,
  });
}
