# listen-fire

Movements: a small language for automations that listen to a system and
write to others. This crate is the front door:

- `cargo install listen-fire` installs `lf`, which checks and runs a
  project's movements on your machine (docs/getting-started-lf.md in the
  repository).
- As a library (`default-features = false`), it re-exports the parser
  (`listen-fire-parser`), the checker (`listen-fire-checker`) and the engine
  (`listen-fire-engine`). Embed the engine with `engine::embed`: implement
  the host traits, check a movement, run it on an event.

Source and examples: https://github.com/listen-fire/listen-fire
