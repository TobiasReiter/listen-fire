// Which slugs a remote install may take. A remote adapter is found by its slug
// at resolution, by its upper-cased slug as a webhook provider key, and by its
// slug at the push doors — and built-ins resolve first everywhere. A remote
// install that answered to a built-in's name would be shadowed in some places
// and not others, or would let a third party's server stand in for a built-in
// at a door that authenticates by install. So no name a built-in answers to,
// in any casing, and none of the engine's reserved await identities.

import { CALLBACK_AWAIT_TYPE } from 'engine-contracts';
import { ASK_ADAPTER_TYPE } from '../ask/type';
import { listAdapterManifests } from '../registry';

/** Await identities the engine keys parks by that are not ordinary adapters. */
const RESERVED = [CALLBACK_AWAIT_TYPE, ASK_ADAPTER_TYPE];

/** Every name a built-in answers to — slug, trigger kinds, author aliases —
 *  folded to lower case, plus the reserved identities. */
function takenNames(): ReadonlySet<string> {
  const names = new Set(RESERVED.map((name) => name.toLowerCase()));
  for (const manifest of listAdapterManifests()) {
    // A test that stubs an adapter module can leave its manifest undefined.
    if (!manifest) continue;
    for (const name of [manifest.adapterType, ...(manifest.triggerKinds ?? []), ...(manifest.aliases ?? [])]) {
      names.add(name.toLowerCase());
    }
  }
  return names;
}

/** Why `slug` cannot be a remote install, or null when it can. Compared
 *  without case, so the install's upper-cased provider key can never be a
 *  built-in's trigger kind either. */
export function remoteSlugRefusal(slug: string): string | null {
  const taken = takenNames();
  // The provider key is the UPPER-cased slug, and some non-ASCII letters fold
  // onto ASCII only that way ('ſlack' -> 'SLACK'), so compare that casing too.
  const collides = taken.has(slug.toLowerCase()) || [...taken].some((name) => name.toUpperCase() === slug.toUpperCase());
  if (!collides) return null;
  return `"${slug}" is a name a built-in adapter or the engine already answers to; a remote adapter needs a slug of its own`;
}

export function mayBeRemoteSlug(slug: string): boolean {
  return remoteSlugRefusal(slug) === null;
}
