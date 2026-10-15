//! The checker's C ABI export, linked into whichever WASM artifact links this
//! crate (the engine's `movement.wasm`). Same conventions as the parser's
//! (`movement_parser::abi`): inputs are UTF-8 the caller placed with `alloc`,
//! the JSON answer's pointer and length go to the two out slots, and the
//! caller `dealloc`s it.

use movement_parser::abi::{install_panic_hook, utf8, write_out};

use crate::CheckOptions;

/// `check_program(source, catalog snapshot JSON, version, upgrading_from)`:
/// writes `{diagnostics}` and returns 0, or writes `{error}` and returns 1.
/// `upgrading_from` is 0 for none.
///
/// # Safety
/// Both input ranges must be readable; the out slots writable.
#[unsafe(no_mangle)]
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
    install_panic_hook();
    let inputs = unsafe { utf8(src_ptr, src_len, "source") }
        .and_then(|source| unsafe { utf8(catalog_ptr, catalog_len, "catalog") }.map(|catalog| (source, catalog)));
    let answer = match inputs {
        Ok((source, catalog)) => crate::check_json(
            source,
            catalog,
            CheckOptions { language_version: version, upgrading_from: (upgrading_from != 0).then_some(upgrading_from), parse_version: None },
        ),
        Err(error) => serde_json::json!({ "error": error }),
    };
    let status = u32::from(answer.get("error").is_some());
    let bytes = movement_parser::to_sorted_json(&answer);
    unsafe { write_out(bytes, out_ptr_ptr, out_len_ptr) };
    status
}
