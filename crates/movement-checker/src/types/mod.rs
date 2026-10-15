//! The type core (PORT.md, "Type core"): value types and their fit, record
//! positions, closures, narrowing, the standard library's signatures, and
//! the typing of one expression. Every family except names, imports and
//! versions builds on it.
//!
//! - `field`: value types (`Ty`) — absence, unions, tuples, equality, fit, spelling.
//! - `position`: where a record stands (`Position`), closures, edge landings, property reads.
//! - `narrowing`: what a condition proves present.
//! - `stdlib`: built-in signatures.
//! - `infer`: `Typing`, which types an expression against a `TypeEnv`.
//! - `declared`: node declarations as schemas, and the structural comparator.
//! - `scope_env`: the `TypeEnv` the checker's scope chain answers.

pub mod declared;
pub mod event_address;
pub mod field;
pub mod infer;
pub mod narrowing;
pub mod position;
pub mod scope_env;
pub mod stdlib;

pub use field::Ty;
pub use infer::{TypeEnv, Typing};
pub use position::{Position, PlaneType, ReturnShape, ClosureParam, ClosureType, Instance, InstanceRef};
