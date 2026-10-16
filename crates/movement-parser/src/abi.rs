//! The C ABI the TypeScript loader (`packages/movement-lang/wasm/loader.ts`)
//! calls. Inputs are UTF-8 bytes the caller placed in linear memory with
//! `alloc`; every parse writes a UTF-8 JSON buffer's pointer and length to
//! the two out slots and returns 0 (the tree) or 1 (`{"error": …}`). The
//! caller owns that buffer and must `dealloc` it.
//!
//! Out pointers are `usize` rather than `u32` so the native test build can
//! exercise the same functions; on wasm32 the two are the same width.

use std::alloc::Layout;
use std::fmt::Write;
use std::panic::PanicHookInfo;
use std::ptr::NonNull;
use std::sync::{Mutex, Once};

use serde_json::json;

use crate::lowering::{self, Mode};
use crate::util::form;
use crate::{NestedCall, Parsed, to_sorted_json};

const OK: u32 = 0;
const ERROR: u32 = 1;

fn byte_layout(len: u32) -> Layout {
    Layout::array::<u8>(len as usize).expect("a u32 length always fits a byte layout")
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: u32) -> *mut u8 {
    // A zero-size allocation is undefined behaviour; an empty input still
    // needs a non-null pointer to build an empty slice from.
    if len == 0 {
        return NonNull::<u8>::dangling().as_ptr();
    }
    let ptr = unsafe { std::alloc::alloc(byte_layout(len)) };
    if ptr.is_null() {
        std::alloc::handle_alloc_error(byte_layout(len));
    }
    ptr
}

/// # Safety
/// `ptr` and `len` must come from one `alloc` call (or one parse output) not
/// yet freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: u32) {
    if len == 0 {
        return;
    }
    unsafe { std::alloc::dealloc(ptr, byte_layout(len)) };
}

/// # Safety
/// `src_ptr..src_ptr+src_len` must be readable; the out slots writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parse_program(
    src_ptr: *const u8,
    src_len: u32,
    version: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    install_panic_hook();
    let parsed = unsafe { utf8(src_ptr, src_len, "source") }.and_then(|src| crate::parse_program(&form::form_of_text(src), version));
    unsafe { emit(parsed, out_ptr_ptr, out_len_ptr) }
}

/// `parse_program` with every slot's expression parsed up front.
///
/// # Safety
/// As `parse_program`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parse_program_eager(
    src_ptr: *const u8,
    src_len: u32,
    version: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    install_panic_hook();
    let parsed = unsafe { utf8(src_ptr, src_len, "source") }.and_then(|src| crate::parse_program_eager(&form::form_of_text(src), version));
    unsafe { emit(parsed, out_ptr_ptr, out_len_ptr) }
}

/// # Safety
/// As `parse_program`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parse_expression(
    src_ptr: *const u8,
    src_len: u32,
    version: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    install_panic_hook();
    let parsed = unsafe { utf8(src_ptr, src_len, "source") }.and_then(|src| crate::parse_expression(&form::form_of_text(src), version));
    unsafe { emit(parsed, out_ptr_ptr, out_len_ptr) }
}

/// A diagnostic's message with every built-in it quotes in the spelling of
/// `version` (crate::surface::table::spell_message), as a JSON string.
///
/// # Safety
/// As `parse_program`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn spell_message(
    src_ptr: *const u8,
    src_len: u32,
    version: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    install_panic_hook();
    let spelled = unsafe { utf8(src_ptr, src_len, "message") }
        .map(|m| serde_json::Value::String(crate::surface::table::spell_message(m, version)));
    unsafe { emit(spelled, out_ptr_ptr, out_len_ptr) }
}

/// A plugin's name from version 5 (crate::surface::table::plugin_name): the
/// registry name or catalog key in camelCase, as a JSON string.
///
/// # Safety
/// As `parse_program`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn plugin_name(
    src_ptr: *const u8,
    src_len: u32,
    _version: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    install_panic_hook();
    let spelled =
        unsafe { utf8(src_ptr, src_len, "plugin") }.map(|key| serde_json::Value::String(crate::surface::table::plugin_name(key)));
    unsafe { emit(spelled, out_ptr_ptr, out_len_ptr) }
}

/// Program text a diagnostic suggests, in the spelling of `version`
/// (crate::surface::phrase::spell_code), as a JSON string.
///
/// # Safety
/// As `parse_program`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn spell_code(
    src_ptr: *const u8,
    src_len: u32,
    version: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    install_panic_hook();
    let spelled =
        unsafe { utf8(src_ptr, src_len, "code") }.map(|c| serde_json::Value::String(crate::surface::phrase::spell_code(c, version)));
    unsafe { emit(spelled, out_ptr_ptr, out_len_ptr) }
}

/// The spelling table (crate::surface::table::TABLE) as JSON; the input is
/// ignored.
///
/// # Safety
/// As `parse_program`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn surface_table(
    _src_ptr: *const u8,
    _src_len: u32,
    _version: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    install_panic_hook();
    let table = serde_json::to_value(crate::surface::table::TABLE).map_err(|e| json!({ "message": e.to_string() }));
    unsafe { emit(table, out_ptr_ptr, out_len_ptr) }
}

/// # Safety
/// As `parse_program`.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn parse_nested_call(
    raw_ptr: *const u8,
    raw_len: u32,
    at_start: u32,
    at_end: u32,
    origin_line: u32,
    origin_col: u32,
    version: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    install_panic_hook();
    let call = NestedCall { at_start, at_end, origin_line, origin_col, version };
    let parsed = unsafe { utf8(raw_ptr, raw_len, "source") }.and_then(|raw| crate::parse_nested_call(&form::form_of_text(raw), &call));
    unsafe { emit(parsed, out_ptr_ptr, out_len_ptr) }
}

/// `lowerExpression(tree, source)`: the tree's JSON and the text it was
/// parsed from in, the `Expression` (status 0) or `{"error": {message,
/// code?, class?}}` (status 1) out. Unlike the parses, the output keeps the
/// TypeScript lowering's key order instead of sorting (`crate::lowering`).
///
/// # Safety
/// Both input ranges must be readable; the out slots writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn lower_expression(
    tree_ptr: *const u8,
    tree_len: u32,
    src_ptr: *const u8,
    src_len: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    unsafe { lower(Mode::Expression, (tree_ptr, tree_len), (src_ptr, src_len), out_ptr_ptr, out_len_ptr) }
}

/// `lowerCondition(tree, source)`, as `lower_expression`.
///
/// # Safety
/// As `lower_expression`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn lower_condition(
    tree_ptr: *const u8,
    tree_len: u32,
    src_ptr: *const u8,
    src_len: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    unsafe { lower(Mode::Condition, (tree_ptr, tree_len), (src_ptr, src_len), out_ptr_ptr, out_len_ptr) }
}

unsafe fn lower(
    mode: Mode,
    tree: (*const u8, u32),
    src: (*const u8, u32),
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    install_panic_hook();
    let inputs = unsafe { utf8(tree.0, tree.1, "the tree") }.and_then(|tree| Ok((tree, unsafe { utf8(src.0, src.1, "source") }?)));
    let (status, bytes) = match inputs {
        Ok((tree, source)) => match lowering::lower_json_bytes(&form::read_json_text(tree), &form::form_of_text(source), mode) {
            Ok(bytes) => (OK, bytes),
            Err(bytes) => (ERROR, bytes),
        },
        // Bytes that are not text are the caller's fault, as a tree that
        // does not read is.
        Err(mut error) => {
            error["class"] = json!("MalformedTree");
            (ERROR, to_sorted_json(&json!({ "error": error })))
        }
    };
    // Out as `JSON.stringify` writes: the engine's text form undone.
    unsafe { write_out(form::external_bytes(bytes), out_ptr_ptr, out_len_ptr) };
    status
}

/// `catalog_query(snapshot, query)`: one catalog lookup or helper call
/// (`crate::catalog::query`), the snapshot's JSON and the query's in, `{"value":
/// …}` or `{}` (status 0) or `{"error": {message}}` (status 1) out. No state
/// is kept between calls.
///
/// # Safety
/// Both input ranges must be readable; the out slots writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn catalog_query(
    snapshot_ptr: *const u8,
    snapshot_len: u32,
    query_ptr: *const u8,
    query_len: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    install_panic_hook();
    let inputs = unsafe { utf8(snapshot_ptr, snapshot_len, "the snapshot") }
        .and_then(|snapshot| Ok((snapshot, unsafe { utf8(query_ptr, query_len, "the query") }?)));
    let (status, bytes) = match inputs {
        Ok((snapshot, query)) => match crate::catalog::query::query_json(&form::read_json_text(snapshot), &form::read_json_text(query)) {
            Ok(bytes) => (OK, bytes),
            Err(bytes) => (ERROR, bytes),
        },
        Err(error) => (ERROR, to_sorted_json(&json!({ "error": error }))),
    };
    // Out as `JSON.stringify` writes: the engine's text form undone.
    unsafe { write_out(form::external_bytes(bytes), out_ptr_ptr, out_len_ptr) };
    status
}

/// Room for one panic message. Fixed so that recording a panic allocates
/// nothing: the panic may have struck inside the allocator.
const PANIC_CAPACITY: usize = 1024;

struct PanicMessage {
    bytes: [u8; PANIC_CAPACITY],
    len: usize,
}

impl Write for PanicMessage {
    /// Keeps what fits, cut at a character boundary so the text stays UTF-8.
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        let room = PANIC_CAPACITY - self.len;
        let mut take = s.len().min(room);
        while !s.is_char_boundary(take) {
            take -= 1;
        }
        self.bytes[self.len..self.len + take].copy_from_slice(&s.as_bytes()[..take]);
        self.len += take;
        Ok(())
    }
}

static LAST_PANIC: Mutex<PanicMessage> = Mutex::new(PanicMessage { bytes: [0; PANIC_CAPACITY], len: 0 });
static PANIC_HOOK: Once = Once::new();

/// A panic aborts, which traps the instance and loses the message; the hook
/// keeps it where `last_panic` can hand it to the loader, which reads it
/// from the trapped instance before discarding it. Public, as `utf8` and
/// `write_out` are, because crates/movement-engine links this ABI into its
/// own exports rather than defining a second `alloc`.
pub fn install_panic_hook() {
    PANIC_HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            record_panic(info);
            previous(info);
        }));
    });
}

fn record_panic(info: &PanicHookInfo<'_>) {
    let mut message = LAST_PANIC.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    message.len = 0;
    // A message quoting a text the engine holds leaves without its form.
    let _ = write!(message, "{}", crate::util::form::external_text(&info.to_string()));
}

/// Points the out slots at the last panic's message (empty if none). The
/// buffer is static: the caller reads it and does not `dealloc` it.
///
/// # Safety
/// The out slots must be writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn last_panic(out_ptr_ptr: *mut usize, out_len_ptr: *mut usize) {
    let message = LAST_PANIC.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    unsafe {
        out_ptr_ptr.write_unaligned(message.bytes.as_ptr() as usize);
        out_len_ptr.write_unaligned(message.len);
    }
}

/// `what` names the input in the refusal, where an export takes more than one.
///
/// # Safety
/// `ptr..ptr+len` must be readable for the returned lifetime.
pub unsafe fn utf8<'a>(ptr: *const u8, len: u32, what: &str) -> Result<&'a str, serde_json::Value> {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
    std::str::from_utf8(bytes).map_err(|e| {
        json!({ "message": format!("{what} is not valid UTF-8"), "pos": e.valid_up_to() })
    })
}

unsafe fn emit(parsed: Parsed, out_ptr_ptr: *mut usize, out_len_ptr: *mut usize) -> u32 {
    let (status, bytes) = match parsed {
        Ok(tree) => (OK, to_sorted_json(&tree)),
        Err(error) => (ERROR, to_sorted_json(&json!({ "error": error }))),
    };
    // Out as `JSON.stringify` writes: the engine's text form undone.
    unsafe { write_out(form::external_bytes(bytes), out_ptr_ptr, out_len_ptr) };
    status
}

/// Hands `bytes` to the caller through the out slots.
///
/// # Safety
/// The out slots must be writable.
pub unsafe fn write_out(bytes: Vec<u8>, out_ptr_ptr: *mut usize, out_len_ptr: *mut usize) {
    // A boxed slice's allocation is exactly `byte_layout(len)`, which is what
    // `dealloc` frees with.
    let bytes = bytes.into_boxed_slice();
    let len = bytes.len();
    let ptr = Box::into_raw(bytes).cast::<u8>();
    // The loader's out slots come from a byte allocation with no alignment
    // guarantee.
    unsafe {
        out_ptr_ptr.write_unaligned(ptr as usize);
        out_len_ptr.write_unaligned(len);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call_expression(source: &str) -> (u32, String) {
        let len = u32::try_from(source.len()).unwrap();
        let src = alloc(len);
        unsafe { std::ptr::copy_nonoverlapping(source.as_ptr(), src, source.len()) };
        let (mut out_ptr, mut out_len) = (0usize, 0usize);
        let status = unsafe { parse_expression(src, len, 3, &mut out_ptr, &mut out_len) };
        unsafe { dealloc(src, len) };
        let out = unsafe { std::slice::from_raw_parts(out_ptr as *const u8, out_len) }.to_vec();
        unsafe { dealloc(out_ptr as *mut u8, u32::try_from(out_len).unwrap()) };
        (status, String::from_utf8(out).unwrap())
    }

    #[test]
    fn round_trips_through_alloc_parse_and_dealloc() {
        let (status, json) = call_expression("'héllo 🌍'");
        assert_eq!(status, OK);
        assert_eq!(json, r#"{"at":{"end":10,"start":0},"kind":"string","parts":["héllo 🌍"],"quote":"'"}"#);
    }

    fn call_lowering(mode: Mode, tree: &str, source: &str) -> (u32, String) {
        let input = |text: &str| {
            let len = u32::try_from(text.len()).unwrap();
            let ptr = alloc(len);
            unsafe { std::ptr::copy_nonoverlapping(text.as_ptr(), ptr, text.len()) };
            (ptr, len)
        };
        let ((tree_ptr, tree_len), (src_ptr, src_len)) = (input(tree), input(source));
        let (mut out_ptr, mut out_len) = (0usize, 0usize);
        let status = unsafe {
            match mode {
                Mode::Expression => lower_expression(tree_ptr, tree_len, src_ptr, src_len, &mut out_ptr, &mut out_len),
                Mode::Condition => lower_condition(tree_ptr, tree_len, src_ptr, src_len, &mut out_ptr, &mut out_len),
            }
        };
        let out = unsafe { std::slice::from_raw_parts(out_ptr as *const u8, out_len) }.to_vec();
        unsafe {
            dealloc(tree_ptr, tree_len);
            dealloc(src_ptr, src_len);
            dealloc(out_ptr as *mut u8, u32::try_from(out_len).unwrap());
        }
        (status, String::from_utf8(out).unwrap())
    }

    #[test]
    fn lowering_round_trips_in_the_typescript_key_order() {
        let (_, tree) = call_expression("a == 1");
        let (status, json) = call_lowering(Mode::Expression, &tree, "a == 1");
        assert_eq!(status, OK);
        assert_eq!(
            json,
            r#"{"type":"compare","op":"eq","left":{"type":"property","propertyTypeId":"a"},"right":{"type":"static","value":1}}"#
        );
        let (status, json) = call_lowering(Mode::Condition, &tree, "a == 1");
        assert_eq!(status, OK);
        assert!(json.starts_with(r#"{"kind":"expr","expr":{"type":"compare""#), "{json}");
    }

    #[test]
    fn a_refusal_comes_back_as_an_error_envelope() {
        let (_, tree) = call_expression("x[0]");
        assert_eq!(
            call_lowering(Mode::Expression, &tree, "x[0]"),
            (ERROR, r#"{"error":{"message":"an index read `x[i]` is written AT(x, i)"}}"#.to_string())
        );
        let (_, tree) = call_expression("FILE(x)");
        assert_eq!(
            call_lowering(Mode::Expression, &tree, "FILE(x)"),
            (
                ERROR,
                r#"{"error":{"message":"FILE(content, \"pdf\" | \"text\") takes exactly 2 arguments, got 1 — e.g. FILE(report_text, \"pdf\")","class":"BridgeError"}}"#
                    .to_string()
            )
        );
    }

    #[test]
    fn a_tree_that_is_not_one_is_the_caller_s_fault() {
        let (status, json) = call_lowering(Mode::Expression, r#"{"kind":"nope"}"#, "");
        assert_eq!(status, ERROR);
        assert!(json.contains(r#""class":"MalformedTree""#), "{json}");
    }

    #[test]
    fn empty_source_round_trips() {
        let (status, json) = call_expression("");
        assert_eq!(status, ERROR);
        assert_eq!(json, r#"{"error":{"message":"Unexpected end of input","pos":0}}"#);
    }

    #[test]
    fn a_panic_leaves_its_message_for_last_panic() {
        install_panic_hook();
        let caught = std::panic::catch_unwind(|| panic!("boom {}", 42));
        assert!(caught.is_err());
        let (mut ptr, mut len) = (0usize, 0usize);
        unsafe { last_panic(&mut ptr, &mut len) };
        let text = std::str::from_utf8(unsafe { std::slice::from_raw_parts(ptr as *const u8, len) }).unwrap();
        assert!(text.starts_with("panicked at crates/movement-parser/src/abi.rs:"), "{text}");
        assert!(text.ends_with("boom 42"), "{text}");
    }

    #[test]
    fn a_long_panic_message_is_cut_at_a_character_boundary() {
        let mut message = PanicMessage { bytes: [0; PANIC_CAPACITY], len: PANIC_CAPACITY - 3 };
        write!(message, "é🌍").unwrap();
        assert_eq!(message.len, PANIC_CAPACITY - 1);
        assert_eq!(&message.bytes[PANIC_CAPACITY - 3..PANIC_CAPACITY - 1], "é".as_bytes());
    }

    #[test]
    fn a_lowering_handed_invalid_utf8_says_it_was_not_a_tree() {
        let bytes = [b'"', 0xff, b'"'];
        let tree = alloc(3);
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), tree, 3) };
        let src = alloc(0);
        let (mut out_ptr, mut out_len) = (0usize, 0usize);
        let status = unsafe { lower_expression(tree, 3, src, 0, &mut out_ptr, &mut out_len) };
        let out = unsafe { std::slice::from_raw_parts(out_ptr as *const u8, out_len) }.to_vec();
        unsafe {
            dealloc(tree, 3);
            dealloc(src, 0);
            dealloc(out_ptr as *mut u8, u32::try_from(out_len).unwrap());
        }
        assert_eq!(status, ERROR);
        assert_eq!(
            String::from_utf8(out).unwrap(),
            r#"{"error":{"class":"MalformedTree","message":"the tree is not valid UTF-8","pos":1}}"#
        );
    }

    #[test]
    fn invalid_utf8_is_an_error_not_a_crash() {
        let bytes = [b'a', 0xff, b'b'];
        let src = alloc(3);
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), src, 3) };
        let (mut out_ptr, mut out_len) = (0usize, 0usize);
        let status = unsafe { parse_program(src, 3, 3, &mut out_ptr, &mut out_len) };
        let out = unsafe { std::slice::from_raw_parts(out_ptr as *const u8, out_len) }.to_vec();
        unsafe {
            dealloc(src, 3);
            dealloc(out_ptr as *mut u8, u32::try_from(out_len).unwrap());
        }
        assert_eq!(status, ERROR);
        assert_eq!(String::from_utf8(out).unwrap(), r#"{"error":{"message":"source is not valid UTF-8","pos":1}}"#);
    }
}
