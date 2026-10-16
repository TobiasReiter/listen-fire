//! The extraction call (`extract(content, Shape, { … })`, `extractOne(…)`,
//! `call`), as extraction_call.ts runs it: a declaration's spec resolved per
//! firing (`spec`), the reply read as zod reads it (`validate`), content files
//! read and resources stamped (`resources`), and what the call shares with the
//! `AI()` expression and plain plugin calls — tier settings, priced calls,
//! plugin invocation (`run`). `emission` is the record an ask's correction
//! answers (and a parked TypeScript state's extracted record, resumed).
//!
//! The extraction keyword (`x = extract from […] { … }`) is not run here on
//! any version: admission refuses it (crate::admit::LEGACY_EXTRACTION).

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

pub(crate) mod call;
pub(crate) mod emission;
pub(crate) mod resources;
pub use resources::bound_text;
pub(crate) mod run;
pub(crate) mod spec;
pub(crate) mod validate;
