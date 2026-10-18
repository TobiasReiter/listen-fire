//! listen-fire: the movement language in Rust.
//!
//! This crate is the front door. It re-exports the three library crates, and
//! `cargo install listen-fire` installs the `lf` command, which runs a
//! project's movements locally.
//!
//! - [`parser`]: source text to the syntax tree ([`listen-fire-parser`](https://crates.io/crates/listen-fire-parser)).
//! - [`checker`]: the checker's diagnostics for a movement ([`listen-fire-checker`](https://crates.io/crates/listen-fire-checker)).
//! - [`engine`]: runs a movement against a host you supply ([`listen-fire-engine`](https://crates.io/crates/listen-fire-engine)).
//!
//! To embed the engine in your own program, depend on this crate without its
//! `cli` feature (`listen-fire = { version = "…", default-features = false }`)
//! and fill [`engine::embed::Hosts`] with your implementations. Every host
//! call returns a future, so a host may answer over the network; one that
//! answers from memory returns `ready(…)`, and the run is a plain future any
//! executor drives:
//!
//! ```
//! use listen_fire::engine::embed::{self, *};
//!
//! // Your system, as the movement's one adapter.
//! struct Inbox;
//! impl Adapters for Inbox {
//!     fn resolve(&mut self, _: AdapterRequest) -> HostFuture<AdapterInstance> {
//!         ready(Ok(AdapterInstance { id: "inbox".into(), methods: vec![] }))
//!     }
//!     fn call(&mut self, call: AdapterCall) -> HostFuture<AdapterReply> {
//!         // The event's record answers the fields the movement reads.
//!         ready(Ok(match call.method.as_str() {
//!             "getFieldValue" => AdapterReply::ok(Data::text("Hello")),
//!             _ => AdapterReply::nothing(),
//!         }))
//!     }
//! }
//!
//! let catalog = Catalog::from_json(r#"{"adapters":{"email":{"constructionArgs":[],"canFire":true,
//!   "schemas":{"":{"positions":{"message":{"properties":{"subject":"text"},"edges":{}}},
//!   "collections":{},"eventPosition":"message"}}}},"credentials":{},"plugins":{}}"#).unwrap();
//! let source = "import { email } from adapters\n\
//!               inbox = connect email\n\
//!               function seen(msg: <inbox-[:message]->>) {\n  s = msg.`subject`\n}\n\
//!               listen to inbox fire seen\n";
//! assert!(embed::check(source, &catalog, embed::LANGUAGE_VERSION).iter().all(|p| p.severity != Severity::Error));
//!
//! let event = Event::new("email", Data::map([("subject", Data::text("Hello"))]));
//! let input = RunInput::new(source, event, "2026-10-17T12:00:00.000Z").function("seen").catalog(catalog);
//! let mut inbox = Inbox;
//! let mut hosts = Hosts::new().adapters(&mut inbox);
//! let run = std::pin::pin!(embed::run(&mut hosts, &input));
//! // Every answer is ready, so the run finishes on its first poll.
//! let std::task::Poll::Ready(outcome) = run.poll(&mut std::task::Context::from_waker(std::task::Waker::noop())) else { unreachable!() };
//! assert!(matches!(outcome.unwrap(), Outcome::Finished(_)));
//! ```

pub use movement_checker as checker;
pub use movement_engine as engine;
pub use movement_parser as parser;
