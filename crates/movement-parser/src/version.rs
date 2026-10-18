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

/// The run host's units (Henry 2026-10-16): from version 5 every file has
/// these names in scope, each already connected — `listen to manual fire
/// hello`, `listen to cron { schedule: "0 9 * * 1" } fire digest` — with no
/// import and no `connect`. A file's own binding of the name replaces it.
/// (`RUN_HOST_UNITS` in language_version.ts.)
pub const RUN_HOST_UNITS: &[&str] = &["cron", "manual"];

/// The units a file pinned to `version` has in scope.
pub fn run_host_units(version: u32) -> &'static [&'static str] {
    if since(version, 5) { RUN_HOST_UNITS } else { &[] }
}
