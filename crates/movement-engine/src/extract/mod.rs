//! The extraction keyword (`x = extract from […] { tree }`), as extraction.ts
//! materialises it: the spec resolved per firing and the calls planned over
//! it (`spec`), what each call says to the model (`prompt`), how its reply is
//! read (`validate`), the content read and fetched as resources
//! (`resources`), what the walk yields (`emission`), and the walk itself —
//! the model loop, the `through` stages, the fences (`run`). `spec`,
//! `prompt` and `validate` are held to the TypeScript's own answers by
//! tests/extraction_pin.rs (tests/oracle/extraction.json); the walk, by the
//! corpora and the recorded runs.

/// What a deployment buys for one extraction tier (ai_tiers.ts
/// `ExtractionTierAssignment`): each member over the built-in row's.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct TierAssignment {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

pub(crate) use resources::{file_handle, is_file_ref};

pub mod emission;
pub mod prompt;
pub(crate) mod resources;
pub use resources::bound_text;
pub(crate) mod run;
pub mod spec;
pub mod validate;
