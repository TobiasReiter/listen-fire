//! JSON read with its nesting bounded rather than unbounded: serde_json's
//! own bound (128) cannot be raised, only lifted, and every reader of the
//! value it builds recurses once per level.

use serde::Deserialize;
use serde_json::Value;

use crate::tree::MAX_CHAIN;

/// How deep a JSON input may nest. A tree the parser builds is at most
/// `MAX_CHAIN` levels, each one to three JSON levels deep and the deeper ones
/// only at the grammar's nesting (`MAX_DEPTH`), so twice the chain limit
/// admits every one; catalog data is far shallower.
pub const MAX_DEPTH: usize = 2 * MAX_CHAIN;

/// `json` as a value, refused when it nests past `MAX_DEPTH`. A `Value`'s
/// objects are sorted (serde_json's `preserve_order` is off, which is what
/// `to_sorted_json` relies on), so data whose key order matters is read with
/// `from_json` into its own type instead.
pub fn read_bounded(json: &str) -> Result<Value, String> {
    from_json(json)
}

/// `json` as a `T`, refused when it nests past `MAX_DEPTH`.
pub fn from_json<'a, T: Deserialize<'a>>(json: &'a str) -> Result<T, String> {
    from_json_within(json, MAX_DEPTH)
}

/// `json` as a `T`, refused when it nests past `limit`: a type whose read
/// costs more stack per level than a `Value`'s needs a lower bound.
pub fn from_json_within<'a, T: Deserialize<'a>>(json: &'a str, limit: usize) -> Result<T, String> {
    if depth_exceeds(json.as_bytes(), limit) {
        return Err(format!("it nests deeper than {limit} levels"));
    }
    let mut de = serde_json::Deserializer::from_str(json);
    de.disable_recursion_limit();
    let value = T::deserialize(&mut de).map_err(|e| e.to_string())?;
    de.end().map_err(|e| e.to_string())?;
    Ok(value)
}

/// Whether `json`'s brackets nest past `limit`, outside its strings. Malformed
/// JSON is left for the parse to refuse.
fn depth_exceeds(json: &[u8], limit: usize) -> bool {
    let (mut depth, mut in_string, mut escaped) = (0usize, false, false);
    for &b in json {
        if in_string {
            match b {
                _ if escaped => escaped = false,
                b'\\' => escaped = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'[' | b'{' => {
                depth += 1;
                if depth > limit {
                    return true;
                }
            }
            b']' | b'}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    false
}
