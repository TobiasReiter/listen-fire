//! The walks family: not yet ported. Its codes (PORT.md has where the
//! TypeScript raises each):
//!
//! - MOV_AMBIGUOUS_PROPERTY
//! - MOV_ARTIFICIAL_EDGE_UNKNOWN
//! - MOV_AWAIT_IMPURE_WHERE
//! - MOV_AWAIT_REQUIRED
//! - MOV_HEAD_NOT_A_POSITION
//! - MOV_HOP_CONFIG_UNREAD
//! - MOV_HOP_FILTER_ENGINE
//! - MOV_HOP_FILTER_RESIDUAL
//! - MOV_HOP_FILTER_UNSUPPORTED
//! - MOV_HOP_LIMIT_UNSUPPORTED
//! - MOV_HOP_ORDER_ENGINE
//! - MOV_HOP_ORDER_UNSUPPORTED
//! - MOV_LIMIT_NEEDS_ORDER
//! - MOV_META_HOP_RETIRED
//! - MOV_META_UNKNOWN_KEY
//! - MOV_NARROWING
//! - MOV_OLD_EDGE_NOT_A_WRITE
//! - MOV_PARENT_READ_RETIRED
//! - MOV_SHAPE_HOP_RETIRED
//! - MOV_TRANSFORM_HOP_RETIRED
//! - MOV_TRAVERSE_UNKNOWN_EDGE
//! - MOV_UNDESCRIBED_POSITION
//! - MOV_UNKNOWN_POSITION
//! - MOV_UNKNOWN_PROPERTY
//! - MOV_UNREACHABLE_BRANCH

use movement_parser::lowering::expression::EdgeStep;

use crate::types::field::Ty;
use crate::types::infer::Typing;
use crate::types::position::{EdgeLanding, Position};

/// Called by the type core after each edge step it types (`stepEdge`):
/// `landing` is `None` when the walk had already lost its position. The
/// walks family reports an unknown edge, a narrowing, an await rule here.
pub fn observe_step(_typing: &mut Typing, _from: Option<&Position>, _step: &EdgeStep, _landing: Option<&EdgeLanding>) {}

/// Called by the type core after each dot read off a record (`readProperty`):
/// `ty` is `None` for a property the position does not declare (or cannot type).
pub fn observe_read(_typing: &mut Typing, _position: Option<&Position>, _property: &str, _ty: Option<&Ty>) {}
