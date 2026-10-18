//! A run's own writes, remembered so their echo does not fire it again.
//!
//! A movement that writes to the source it listens to hears its own write
//! come back: Attio sends `record.updated` for the update a run just made, a
//! poll returns the row a run just changed. Each record write to a source
//! that can echo (one that sends webhooks or is polled) is remembered in the
//! store slot, so every `lf serve` and `lf drain` sharing the store knows it:
//! the record's identity, the movement that wrote it, and the record as it
//! stood right after the write (read back, fingerprinted), for an hour.
//!
//! An inbound event naming a remembered record is read again. If the record
//! is still exactly as the movement's write left it, the event is only the
//! echo of that write and fires none of that movement's listens. Anything
//! else fires as usual: a change by someone else leaves the record different
//! (the platform's authorship rule: this change's author, never the record's
//! identity forever), and another movement's listens hear the write, since
//! reacting to what a movement wrote is a legitimate chain.
//!
//! A source without `readRecord` can not be compared, so its echoes fire.

use sha2::{Digest, Sha256};

use crate::json::Js;

/// How long a write is remembered: an echo arrives within it (a webhook in
/// seconds, a poll within its interval).
pub const REMEMBERED_MS: i64 = 60 * 60 * 1000;

/// One record write a segment made, as it read back.
#[derive(Debug, Clone, PartialEq)]
pub struct Wrote {
    /// The external written to (its manifest name).
    pub adapter: String,
    /// The record type the write named, which reading it back takes.
    pub record_type: String,
    pub external_id: String,
    /// The record as it stood after the write (`fingerprint`).
    pub fingerprint: String,
}

/// A remembered write to one record: which movement's listens it is the
/// echo for (`listen:<file>:<movement>`), and how the record stood.
#[derive(Debug, Clone, PartialEq)]
pub struct Remembered {
    pub writer: String,
    pub record_type: String,
    pub fingerprint: String,
}

/// A record's fingerprint: the hash of its JSON as the source answered it,
/// `null` for a record that is gone.
pub fn fingerprint(record: &Js) -> String {
    Sha256::digest(record.to_json().as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// The record an inbound event names: its `externalId`, if it carries one.
pub fn event_record(event: &Js) -> Option<&str> {
    event.get("externalId").and_then(Js::as_str).filter(|id| !id.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::obj;

    #[test]
    fn a_record_changed_by_anyone_has_another_fingerprint() {
        let written = Js::Obj(obj! { "description" => Js::str("Seen by lf") });
        let changed = Js::Obj(obj! { "description" => Js::str("Edited by Bob") });
        assert_eq!(fingerprint(&written), fingerprint(&written.clone()));
        assert_ne!(fingerprint(&written), fingerprint(&changed));
        assert_ne!(fingerprint(&written), fingerprint(&Js::Null));
    }
}
