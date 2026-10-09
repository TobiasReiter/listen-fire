//! The extraction keyword (`x = extract from […] { tree }`), as extraction.ts
//! materialises it: the spec resolved per firing and the calls planned over
//! it (`spec`), what each call says to the model (`prompt`), and how its
//! reply is read (`validate`). Each is held to the TypeScript's own answers
//! by tests/extraction_pin.rs (tests/oracle/extraction.json).
//!
//! Nothing here asks the host anything: the model loop that sends a region's
//! prompt (`llm.client.call`), reads the reply, retries once and runs the
//! `through` stages between is the run's.

pub mod prompt;
pub mod spec;
pub mod validate;
