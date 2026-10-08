# The contracts

The movement core speaks five contracts. Each is written down here with an integer version of its own, independent of the release tag and of the others, so an embedder, an adapter vendor or a second engine can say exactly what it speaks.

| contract | document | current | supported | deprecated | on the wire |
|---|---|---|---|---|---|
| catalog-snapshot | [catalog-snapshot.md](catalog-snapshot.md) | 1 | 1 | none | `contractVersion` on the snapshot |
| park-state | [park-state.md](park-state.md) | 1 | 1 | none | `version` on the state |
| host-families | [host-families.md](host-families.md) | 1 | 1 | none | `hostFamiliesVersion` on `segment.open` |
| adapter-protocol | [adapter-protocol.md](adapter-protocol.md) | 2 | 2 | none | `protocolVersion` on every request and the manifest |
| language-versions | [language-versions.md](language-versions.md) | 3 | 1, 2, 3 | none | `languageVersion` beside every program |

- **This table is this release's.** A release states, contract by contract, the version it writes, the versions it reads, and the ones it will stop reading.
- **The table is held equal to the code.** `CONTRACTS` (`packages/engine-contracts/versions.ts`) is test-held equal to this table, and each document's version line to its constant (`CATALOG_SNAPSHOT_VERSION`, `PARK_STATE_VERSION`, `HOST_FAMILIES_VERSION`, `MANIFEST_PROTOCOL_VERSION`, `CURRENT_LANGUAGE_VERSION`).

## How a version moves

The rule mirrors the language's ([language-versions.md](language-versions.md)):

- **An addition a reader can ignore keeps the version.** A new optional field, or a new optional method or family, whose absence means what it meant before.
- **A change in meaning bumps it.** A field removed or renamed, a field whose meaning changed, a required field added, an answer reshaped.
- **A break lands as a conditional, never a fork.** The writer sends the new version; a reader that reads both branches on the version at the point of difference. Never a second reader, a second host interface or a second engine.
- **An unsupported version is refused at the boundary, loudly.** The refusal names the contract, the version it was handed and the versions it reads. It is never read as though it were the current version.
- **Deprecation comes first.** A version leaves the supported set only after a release that lists it as deprecated, and the CHANGELOG entry for the break names the contract, the version and why.

## Each document

Every contract document carries the same three things: its version on a line of its own at the top (`Version: N`), the JSON shapes as TypeScript-ish type blocks, and a "Changes" list, newest first.
