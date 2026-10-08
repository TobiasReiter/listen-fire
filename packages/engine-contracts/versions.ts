// The five contracts' versions, as one table. Each is an integer the contract's
// doc under docs/contracts/ states, and a test holds each constant here equal
// to its doc and the table equal to docs/contracts/README.md.
//
// The rule mirrors the language's: an additive change a reader can ignore
// keeps the version; a change in meaning bumps it, and the reader branches on
// the version at the point of difference, never by a forked reader. A version
// this release does not support is refused at the boundary, loudly.

import {
  CATALOG_SNAPSHOT_VERSION,
  CURRENT_LANGUAGE_VERSION,
  DEPRECATED_CATALOG_SNAPSHOT_VERSIONS,
  DEPRECATED_LANGUAGE_VERSIONS,
  SUPPORTED_CATALOG_SNAPSHOT_VERSIONS,
  SUPPORTED_LANGUAGE_VERSIONS,
} from 'movement-lang';

import { MANIFEST_PROTOCOL_VERSION } from './protocol';

// The snapshot is the language's type, so its version lives beside it.
export { CATALOG_SNAPSHOT_VERSION, DEPRECATED_CATALOG_SNAPSHOT_VERSIONS, SUPPORTED_CATALOG_SNAPSHOT_VERSIONS };

/** A parked flow's state (docs/contracts/park-state.md). Engine to engine: a
 *  host stores it and hands it back. */
export const PARK_STATE_VERSION = 1;

/** The host families and the entry points (docs/contracts/host-families.md),
 *  carried on every `segment.open`. */
export const HOST_FAMILIES_VERSION = 1;

/** The host families versions this release serves. */
export const SUPPORTED_HOST_FAMILIES_VERSIONS: ReadonlySet<number> = new Set([1]);

export interface ContractStanding {
  current: number;
  supported: readonly number[];
  deprecated: readonly number[];
}

/** What this release speaks, contract by contract: the index
 *  docs/contracts/README.md tabulates. */
export const CONTRACTS = {
  'catalog-snapshot': {
    current: CATALOG_SNAPSHOT_VERSION,
    supported: [...SUPPORTED_CATALOG_SNAPSHOT_VERSIONS],
    deprecated: [...DEPRECATED_CATALOG_SNAPSHOT_VERSIONS],
  },
  'park-state': { current: PARK_STATE_VERSION, supported: [1], deprecated: [] },
  'host-families': {
    current: HOST_FAMILIES_VERSION,
    supported: [...SUPPORTED_HOST_FAMILIES_VERSIONS],
    deprecated: [],
  },
  'adapter-protocol': { current: MANIFEST_PROTOCOL_VERSION, supported: [MANIFEST_PROTOCOL_VERSION], deprecated: [] },
  'language-versions': {
    current: CURRENT_LANGUAGE_VERSION,
    supported: [...SUPPORTED_LANGUAGE_VERSIONS],
    deprecated: [...DEPRECATED_LANGUAGE_VERSIONS],
  },
} as const satisfies Record<string, ContractStanding>;

/** Refuse a `segment.open` whose host families version this host does not
 *  serve: it names the contract, the version it was handed and the ones it
 *  serves. An opening that names no version is refused the same way. */
export function refuseUnsupportedHostFamiliesVersion(opening: { hostFamiliesVersion?: unknown }): void {
  const seen = opening.hostFamiliesVersion;
  if (typeof seen === 'number' && SUPPORTED_HOST_FAMILIES_VERSIONS.has(seen)) return;
  throw new Error(
    `segment.open carries host families version ${JSON.stringify(seen) ?? 'none'}, which this host does not serve ` +
      `(supported: ${[...SUPPORTED_HOST_FAMILIES_VERSIONS].join(', ')})`,
  );
}
