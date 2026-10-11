// The adapter instances a run holds, as a file's owner is found among them
// (`streamFileRef`). Ambient inside the host — the run host sets it around each
// adapter call and file read of a segment — and its own module, so the host
// kit can set it without reaching the byte reader or the database.

import { AsyncLocalStorage } from 'node:async_hooks';

import type { Adapter } from '../../adapter';

/** The instances a run holds, by what a descriptor names of its owner: the
 *  one the run resolved for that adapter type, or none. */
export type FileOwners = (owner: {
  adapterType: string;
  credentialsId?: string;
  constructionArgs?: Record<string, string>;
}) => Adapter | undefined;

export const fileOwnersScope = new AsyncLocalStorage<FileOwners>();

/** Run `call` with `owners` as the instances a file's owner is found among
 *  (the run host sets it around each adapter call and file read of a
 *  segment). */
export function withFileOwners<T>(owners: FileOwners, call: () => Promise<T>): Promise<T> {
  return fileOwnersScope.run(owners, call);
}
