//! One module per diagnostic family (PORT.md, "Diagnostic families"). Each
//! adds the rules of its family to the walk (`crate::checker`) as methods on
//! the `Checker`; a family not yet ported reports nothing, and the parity
//! harness counts what it misses.

pub mod arg_fit;
pub mod calls;
pub mod closures;
pub mod extraction;
pub mod flow;
pub mod imports;
pub mod listens;
pub mod names;
pub mod nodes;
pub mod plugin_calls;
pub mod records;
pub mod systems;
pub mod values;
pub mod versions;
pub mod walks;
pub mod writes;
