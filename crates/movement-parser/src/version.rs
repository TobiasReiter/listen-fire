//! The language versions the grammar reads (packages/movement-lang/
//! language_version.ts). A version past the current one reads as the
//! current one, because every conditional is a comparison against the
//! version a behaviour arrived in.

pub const CURRENT_LANGUAGE_VERSION: u32 = 5;

/// The versions this release parses, checks and runs
/// (`SUPPORTED_LANGUAGE_VERSIONS` in language_version.ts).
pub const SUPPORTED_LANGUAGE_VERSIONS: &[u32] = &[1, 2, 3, 4, 5];

/// `version` has the behaviour version `n` introduced.
pub fn since(version: u32, n: u32) -> bool {
    version >= n
}

/// `version` predates the behaviour version `n` introduced.
pub fn before(version: u32, n: u32) -> bool {
    version < n
}
