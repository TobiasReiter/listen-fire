//! The C ABI the TypeScript loader (`packages/movement-lang/wasm/loader.ts`)
//! calls. Inputs are UTF-8 bytes the caller placed in linear memory with
//! `alloc`; every parse writes a UTF-8 JSON buffer's pointer and length to
//! the two out slots and returns 0 (the tree) or 1 (`{"error": …}`). The
//! caller owns that buffer and must `dealloc` it.
//!
//! Out pointers are `usize` rather than `u32` so the native test build can
//! exercise the same functions; on wasm32 the two are the same width.

use std::alloc::Layout;
use std::ptr::NonNull;

use serde_json::json;

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
    let parsed = unsafe { utf8(src_ptr, src_len) }.and_then(|src| crate::parse_program(src, version));
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
    let parsed = unsafe { utf8(src_ptr, src_len) }.and_then(|src| crate::parse_expression(src, version));
    unsafe { emit(parsed, out_ptr_ptr, out_len_ptr) }
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
    let call = NestedCall { at_start, at_end, origin_line, origin_col, version };
    let parsed = unsafe { utf8(raw_ptr, raw_len) }.and_then(|raw| crate::parse_nested_call(raw, &call));
    unsafe { emit(parsed, out_ptr_ptr, out_len_ptr) }
}

unsafe fn utf8<'a>(ptr: *const u8, len: u32) -> Result<&'a str, serde_json::Value> {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
    std::str::from_utf8(bytes).map_err(|e| {
        json!({ "message": "source is not valid UTF-8", "pos": e.valid_up_to() })
    })
}

unsafe fn emit(parsed: Parsed, out_ptr_ptr: *mut usize, out_len_ptr: *mut usize) -> u32 {
    let (status, bytes) = match parsed {
        Ok(tree) => (OK, to_sorted_json(&tree)),
        Err(error) => (ERROR, to_sorted_json(&json!({ "error": error }))),
    };
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
    status
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
        let (status, json) = call_expression("a.b + 'héllo 🌍'");
        assert_eq!(status, ERROR);
        assert_eq!(json, r#"{"error":{"message":"not implemented","pos":0}}"#);
    }

    #[test]
    fn empty_source_round_trips() {
        let (status, json) = call_expression("");
        assert_eq!(status, ERROR);
        assert_eq!(json, r#"{"error":{"message":"not implemented","pos":0}}"#);
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
