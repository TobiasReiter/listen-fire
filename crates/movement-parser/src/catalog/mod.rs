//! The catalog the checker consults: the schema types, a snapshot's lookups
//! (`fromCatalogSnapshot`), and the pure catalog helpers — ported from
//! packages/movement-lang/checker/catalog.ts and service/snapshot.ts, proven
//! against them by checker/__test__/catalog_differential.unit.test.ts.

pub mod helpers;
pub mod packages;
pub mod plugin_args;
pub mod query;
pub mod snapshot;
pub mod types;

#[cfg(test)]
mod tests;
