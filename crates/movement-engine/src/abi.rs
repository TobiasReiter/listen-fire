//! The engine's exports, beside the parser's (crates/movement-parser/src/
//! abi.rs, whose `alloc`, `dealloc` and `last_panic` this artifact shares and
//! whose conventions these follow: UTF-8 JSON in through `alloc`ed buffers,
//! UTF-8 JSON out through two out slots, status 0 or 1, the caller frees the
//! output).
//!
//! One instance runs one segment. `engine_start` begins it, `engine_answer`
//! hands it one answer, each returns the next `Step` (status 0) or
//! `{"error": {message}}` for a misuse of the protocol (status 1).
//! `engine_finish` drops the segment and everything it held; the loader then
//! discards the instance.

use std::cell::RefCell;

use movement_parser::abi::{install_panic_hook, utf8, write_out};
use movement_parser::to_sorted_json;
use serde_json::json;

use crate::executor::{ProtocolError, Segment, Step};

const OK: u32 = 0;
const ERROR: u32 = 1;

thread_local! {
    static SEGMENT: RefCell<Option<Segment>> = const { RefCell::new(None) };
}

/// # Safety
/// `input_ptr..input_ptr+input_len` must be readable; the out slots writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_start(
    input_ptr: *const u8,
    input_len: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    install_panic_hook();
    let result = unsafe { utf8(input_ptr, input_len, "the input") }
        .map_err(|e| ProtocolError(e["message"].as_str().unwrap_or_default().to_string()))
        .and_then(start);
    unsafe { emit(result, out_ptr_ptr, out_len_ptr) }
}

/// `answer` is `{"value": …}`, `{}` (`undefined`) or `{"error": {message, …}}`.
///
/// # Safety
/// As `engine_start`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_answer(
    id: u32,
    answer_ptr: *const u8,
    answer_len: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    install_panic_hook();
    let result = unsafe { utf8(answer_ptr, answer_len, "the answer") }
        .map_err(|e| ProtocolError(e["message"].as_str().unwrap_or_default().to_string()))
        .and_then(|answer| answer_json(id, answer));
    unsafe { emit(result, out_ptr_ptr, out_len_ptr) }
}

#[unsafe(no_mangle)]
pub extern "C" fn engine_finish() {
    finish();
}

pub fn start(input: &str) -> Result<Step, ProtocolError> {
    if SEGMENT.with_borrow(Option::is_some) {
        return Err(ProtocolError("a segment is already running in this instance".into()));
    }
    let mut segment = crate::begin(input)?;
    let step = segment.start();
    SEGMENT.set(Some(segment));
    step
}

pub fn answer_json(id: u32, answer: &str) -> Result<Step, ProtocolError> {
    let answer = crate::read_answer(answer)?;
    SEGMENT.with_borrow_mut(|segment| match segment {
        Some(segment) => segment.answer(id, answer),
        None => Err(ProtocolError(format!("request {id} was answered with no segment running"))),
    })
}

pub fn finish() {
    // Taken out before it drops, so a future's drop that panics does not
    // leave the slot borrowed.
    drop(SEGMENT.take());
}

unsafe fn emit(result: Result<Step, ProtocolError>, out_ptr_ptr: *mut usize, out_len_ptr: *mut usize) -> u32 {
    let (status, bytes) = match result {
        Ok(step) => (OK, to_sorted_json(&step)),
        Err(ProtocolError(message)) => (ERROR, to_sorted_json(&json!({ "error": { "message": message } }))),
    };
    unsafe { write_out(bytes, out_ptr_ptr, out_len_ptr) };
    status
}


/// The checker's export (`movement_checker::abi::check_program_with`), its
/// zone database this engine's environment services.
///
/// # Safety
/// Both input ranges must be readable; the out slots writable.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)] // the C ABI's arguments
pub unsafe extern "C" fn check_program(
    src_ptr: *const u8,
    src_len: u32,
    catalog_ptr: *const u8,
    catalog_len: u32,
    version: u32,
    upgrading_from: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    unsafe {
        movement_checker::abi::check_program_with(
            &crate::env_services::EnvZones,
            src_ptr,
            src_len,
            catalog_ptr,
            catalog_len,
            version,
            upgrading_from,
            out_ptr_ptr,
            out_len_ptr,
        )
    }
}

#[cfg(test)]
mod tests {
    use movement_parser::abi::{alloc, dealloc, last_panic};
    use serde_json::{Value as Json, json};

    use super::*;

    fn input(text: &str) -> (*mut u8, u32) {
        let len = u32::try_from(text.len()).unwrap();
        let ptr = alloc(len);
        unsafe { std::ptr::copy_nonoverlapping(text.as_ptr(), ptr, text.len()) };
        (ptr, len)
    }

    fn output(out_ptr: usize, out_len: usize) -> Json {
        let bytes = unsafe { std::slice::from_raw_parts(out_ptr as *const u8, out_len) }.to_vec();
        unsafe { dealloc(out_ptr as *mut u8, u32::try_from(out_len).unwrap()) };
        serde_json::from_slice(&bytes).unwrap()
    }

    fn call_start(text: &str) -> (u32, Json) {
        let (ptr, len) = input(text);
        let (mut out_ptr, mut out_len) = (0usize, 0usize);
        let status = unsafe { engine_start(ptr, len, &mut out_ptr, &mut out_len) };
        unsafe { dealloc(ptr, len) };
        (status, output(out_ptr, out_len))
    }

    fn call_answer(id: u32, text: &str) -> (u32, Json) {
        let (ptr, len) = input(text);
        let (mut out_ptr, mut out_len) = (0usize, 0usize);
        let status = unsafe { engine_answer(id, ptr, len, &mut out_ptr, &mut out_len) };
        unsafe { dealloc(ptr, len) };
        (status, output(out_ptr, out_len))
    }

    #[test]
    fn echo_round_trips_start_pending_answer_done() {
        let requests = json!({ "entry": "echo", "requests": [
            { "family": "adapters", "method": "credentialId", "args": { "credentialName": "crm" } },
            { "family": "echo", "method": "ping", "args": [1] },
        ] });
        let (status, step) = call_start(&requests.to_string());
        assert_eq!(status, OK);
        assert_eq!(
            step,
            json!({ "pending": [
                { "id": 1, "family": "adapters", "method": "credentialId", "args": { "credentialName": "crm" } },
                { "id": 2, "family": "echo", "method": "ping", "args": [1] },
            ] })
        );
        assert_eq!(call_answer(2, r#"{"error":{"message":"no ping"}}"#), (OK, json!({ "pending": [] })));
        assert_eq!(
            call_answer(1, r#"{"value":"cred-1"}"#),
            (OK, json!({ "done": { "answers": [{ "value": "cred-1" }, { "error": { "message": "no ping" } }] } }))
        );
        finish();
    }

    #[test]
    fn one_segment_per_instance_until_finish() {
        let echo = r#"{"entry":"echo","requests":[{"family":"echo","method":"m"}]}"#;
        assert_eq!(call_start(echo).0, OK);
        assert_eq!(
            call_start(echo),
            (ERROR, json!({ "error": { "message": "a segment is already running in this instance" } }))
        );
        finish();
        assert_eq!(call_start(echo).0, OK);
        finish();
        assert_eq!(
            call_answer(1, "{}"),
            (ERROR, json!({ "error": { "message": "request 1 was answered with no segment running" } }))
        );
    }

    #[test]
    fn bad_input_is_a_protocol_error() {
        assert_eq!(call_start("nope").0, ERROR);
        assert_eq!(call_start(r#"{"entry":"run"}"#), (ERROR, json!({ "error": { "message": "no entry `run`" } })));
        assert_eq!(call_start(r#"{"entry":"echo","requests":[{"family":"x","method":"m"}]}"#).0, ERROR);
        let (_, step) = call_start(r#"{"entry":"echo","requests":[{"family":"echo","method":"m"}]}"#);
        assert_eq!(step["pending"][0]["id"], 1);
        assert_eq!(call_answer(1, r#"{"value":1,"extra":2}"#).0, ERROR);
        assert_eq!(call_answer(1, r#"{"error":{}}"#).0, ERROR);
        finish();
    }

    #[test]
    fn a_panic_surfaces_through_last_panic() {
        install_panic_hook();
        // Natively a panic unwinds (the release build aborts, trapping the
        // instance); either way the hook has recorded it first.
        let caught = std::panic::catch_unwind(|| start(r#"{"entry":"panic","message":"boom 7"}"#));
        assert!(caught.is_err());
        let (mut ptr, mut len) = (0usize, 0usize);
        unsafe { last_panic(&mut ptr, &mut len) };
        let text = std::str::from_utf8(unsafe { std::slice::from_raw_parts(ptr as *const u8, len) }).unwrap();
        assert!(text.starts_with("panicked at crates/movement-engine/src/lib.rs:"), "{text}");
        assert!(text.ends_with("boom 7"), "{text}");
        finish();
    }
}
