//! The language versions the grammar reads (packages/movement-lang/
//! language_version.ts). A version past the current one reads as the
//! current one, because every conditional is a comparison against the
//! version a behaviour arrived in.

pub const CURRENT_LANGUAGE_VERSION: u32 = 3;

/// `version` has the behaviour version `n` introduced.
pub fn since(version: u32, n: u32) -> bool {
    version >= n
}

/// `version` predates the behaviour version `n` introduced.
pub fn before(version: u32, n: u32) -> bool {
    version < n
}
