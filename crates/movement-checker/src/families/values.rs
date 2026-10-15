//! The values family: not yet ported. Its codes (PORT.md has where the
//! TypeScript raises each):
//!
//! - MOV_ABSENT_REQUIRED
//! - MOV_ARITH_NON_NUMERIC
//! - MOV_COMPARE_TYPE_MISMATCH
//! - MOV_DICT_KEY_NOT_TEXT
//! - MOV_DICT_UNKNOWN_KEY
//! - MOV_ENUM_EMPTY_DOMAIN
//! - MOV_ENUM_UNKNOWN_VALUE
//! - MOV_FOLD_NEEDS_ORDER
//! - MOV_JSON_OPAQUE
//! - MOV_LIST_MIXED
//! - MOV_LIST_SPREAD_NOT_A_LIST
//! - MOV_MAP_KEY_OVERWRITTEN
//! - MOV_MAP_SPREAD_NOT_KEYED
//! - MOV_ORDER_KEY_IMPURE
//! - MOV_ORDER_KEY_MULTI
//! - MOV_PRESENCE_TEST_CONSTANT
//! - MOV_PRESENCE_TEST_ON_TEXT
//! - MOV_SORT_KEY_ON_SCALAR
//! - MOV_SORT_KEY_ON_WALK
//! - MOV_SORT_NEEDS_KEY
//! - MOV_SORT_NOT_COLLECTION
//! - MOV_VALUE_UNLISTED

use movement_parser::lowering::expression::Expression;

use crate::types::field::Ty;
use crate::types::infer::Typing;
use crate::types::position::Position;

/// Called by the type core after it types each expression node, children
/// first: `operands` are the direct operands' types in source order (an
/// arithmetic's two sides, a call's arguments, a concat's parts, a
/// conditional's condition, then and else). The values family's operand
/// rules (arithmetic, comparison, absence, json, enums) live here.
pub fn observe(_typing: &mut Typing, _expr: &Expression, _position: Option<&Position>, _operands: &[Option<Ty>], _ty: Option<&Ty>) {}

/// A literal key a dict written as a literal does not have (`reportUnknownDictKey`).
pub fn unknown_dict_key(_typing: &mut Typing, _key: &str, _keys: &[String]) {}
