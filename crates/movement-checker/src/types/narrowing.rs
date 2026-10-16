//! Presence proofs (checker/typing.ts): what a condition proves present when
//! it holds (`presenceProofs`) or when it fails (`negativePresenceProofs`).
//! The typing applies them to the arm they guard (`Typing::with_presence`).

use movement_parser::lowering::expression::{Expression, FilterOperator, LogicalOp, StaticValue};

use super::field::{Ty, is_maybe_absent};

/// `POSITION_SENTINEL`: the property a walk ending on its landing reads.
pub const POSITION_SENTINEL: &str = "__movement_position__";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PresenceProof {
    /// `r.field` is present.
    Field { root: String, property: String },
    /// The name itself is present.
    Binding { root: String },
    /// The text (or list) is not blank; proves no presence of its own.
    NonBlank { root: String, property: Option<String> },
}

impl PresenceProof {
    pub fn root(&self) -> &str {
        match self {
            PresenceProof::Field { root, .. } | PresenceProof::Binding { root } | PresenceProof::NonBlank { root, .. } => root,
        }
    }
}

/// `isPositionTerminal`.
pub fn is_position_terminal(expr: &Expression) -> bool {
    matches!(expr, Expression::Property { property_type_id } if property_type_id == POSITION_SENTINEL)
}

/// `isWalkProjection`: a walk that reads a field off where it lands.
pub fn is_walk_projection(expr: &Expression) -> bool {
    let Expression::Traverse { steps, expression, .. } = expr else { return false };
    !steps.is_empty()
        && match &**expression {
            Expression::Property { property_type_id } => property_type_id != POSITION_SENTINEL,
            Expression::EdgeProperty { .. } => true,
            _ => false,
        }
}

pub fn is_null_literal(expr: &Expression) -> bool {
    matches!(expr, Expression::Static { value: StaticValue::Null })
}

/// `directFieldRead`: `r.field`.
pub fn direct_field_read(expr: &Expression) -> Option<(String, String)> {
    let Expression::Traverse { alias_root: Some(root), steps, expression } = expr else { return None };
    if !steps.is_empty() {
        return None;
    }
    match &**expression {
        Expression::Property { property_type_id } => Some((root.clone(), property_type_id.clone())),
        _ => None,
    }
}

/// `bareName`.
pub fn bare_name(expr: &Expression) -> Option<&str> {
    match expr {
        Expression::Property { property_type_id } => Some(property_type_id),
        Expression::AliasRef { name } => Some(name),
        _ => None,
    }
}

fn where_field_read(expr: &Expression) -> Option<(String, String)> {
    let Expression::Traverse { alias_root: Some(root), steps, expression } = expr else { return None };
    if !steps.is_empty() {
        return None;
    }
    match &**expression {
        Expression::EdgeProperty { property_type_id } => Some((root.clone(), property_type_id.clone())),
        _ => None,
    }
}

fn presence_subject(expr: &Expression) -> Option<PresenceProof> {
    if let Some((root, property)) = direct_field_read(expr).or_else(|| where_field_read(expr)) {
        return Some(PresenceProof::Field { root, property });
    }
    let name = match expr {
        Expression::EdgeProperty { property_type_id } => Some(property_type_id.as_str()),
        other => bare_name(other),
    };
    name.map(|root| PresenceProof::Binding { root: root.to_string() })
}

/// `existsSubject`: `EXISTS(x)` on a bare name.
pub fn exists_subject(expr: &Expression) -> Option<&str> {
    let Expression::Traverse { alias_root: Some(root), steps, expression } = expr else { return None };
    if !steps.is_empty() {
        return None;
    }
    match &**expression {
        Expression::Exists { steps, where_: None } if steps.is_empty() => Some(root),
        _ => None,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Blank {
    Blank,
    NonBlank,
}

fn flipped(op: FilterOperator) -> Option<FilterOperator> {
    use FilterOperator as F;
    Some(match op {
        F::Lt => F::Gt,
        F::Lte => F::Gte,
        F::Gt => F::Lt,
        F::Gte => F::Lte,
        F::Eq => F::Eq,
        F::Neq => F::Neq,
        _ => return None,
    })
}

fn blank_test<'e>(op: FilterOperator, left: &'e Expression, right: &'e Expression) -> Option<(&'e Expression, Blank)> {
    for (subject, other) in [(left, right), (right, left)] {
        let Expression::Static { value: StaticValue::String(text) } = other else { continue };
        if presence_subject(subject).is_none() {
            continue;
        }
        if text.is_empty() {
            match op {
                FilterOperator::Eq => return Some((subject, Blank::Blank)),
                FilterOperator::Neq => return Some((subject, Blank::NonBlank)),
                _ => continue,
            }
        }
        if op == FilterOperator::Eq && !text.trim().is_empty() {
            return Some((subject, Blank::NonBlank));
        }
    }
    for (length, bound, op) in [(left, right, Some(op)), (right, left, flipped(op))] {
        let Expression::Function { fn_, args } = length else { continue };
        if fn_ != "length" || args.len() != 1 {
            continue;
        }
        let Expression::Static { value: StaticValue::Number(n) } = bound else { continue };
        let subject = &args[0];
        if presence_subject(subject).is_none() {
            continue;
        }
        let n = n.0;
        use FilterOperator as F;
        match op {
            Some(F::Gt) if n >= 0.0 => return Some((subject, Blank::NonBlank)),
            Some(F::Gte) if n >= 1.0 => return Some((subject, Blank::NonBlank)),
            Some(F::Neq) if n == 0.0 => return Some((subject, Blank::NonBlank)),
            Some(F::Eq) if n >= 1.0 => return Some((subject, Blank::NonBlank)),
            Some(F::Eq) if n == 0.0 => return Some((subject, Blank::Blank)),
            Some(F::Lt) if n == 1.0 => return Some((subject, Blank::Blank)),
            Some(F::Lte) if n == 0.0 => return Some((subject, Blank::Blank)),
            _ => {}
        }
    }
    None
}

fn non_blank_proof(subject: &Expression) -> Vec<PresenceProof> {
    match presence_subject(subject) {
        Some(PresenceProof::Field { root, property }) => vec![PresenceProof::NonBlank { root, property: Some(property) }],
        Some(proof) => vec![PresenceProof::NonBlank { root: proof.root().to_string(), property: None }],
        None => Vec::new(),
    }
}

/// `presenceProofs`: what `expr` proves present when it holds. `type_of`
/// types the other side of an `==`.
pub fn presence_proofs(expr: &Expression, type_of: &mut dyn FnMut(&Expression) -> Option<Ty>) -> Vec<PresenceProof> {
    match expr {
        Expression::Logical { op: LogicalOp::And, operands } => operands.iter().flat_map(|o| presence_proofs(o, type_of)).collect(),
        Expression::Not { expression } => negative_presence_proofs(expression, type_of),
        _ => {
            if let Some(root) = exists_subject(expr) {
                return vec![PresenceProof::Binding { root: root.to_string() }];
            }
            let Expression::Compare { op, left, right } = expr else { return Vec::new() };
            let mut proofs = match blank_test(*op, left, right) {
                Some((subject, Blank::NonBlank)) => non_blank_proof(subject),
                _ => Vec::new(),
            };
            if *op != FilterOperator::Eq && *op != FilterOperator::Neq {
                return proofs;
            }
            for (subject, other) in [(&**left, &**right), (&**right, &**left)] {
                if is_null_literal(other) {
                    if *op == FilterOperator::Neq
                        && let Some(proof) = presence_subject(subject)
                    {
                        proofs.push(proof);
                    }
                    continue;
                }
                if *op != FilterOperator::Eq {
                    continue;
                }
                let Some(proof) = presence_subject(subject) else { continue };
                match type_of(other) {
                    Some(other_ty) if !is_maybe_absent(Some(&other_ty)) => proofs.push(proof),
                    _ => {}
                }
            }
            proofs
        }
    }
}

/// `negativePresenceProofs`: what `expr` proves present when it fails.
pub fn negative_presence_proofs(expr: &Expression, type_of: &mut dyn FnMut(&Expression) -> Option<Ty>) -> Vec<PresenceProof> {
    match expr {
        Expression::Logical { op: LogicalOp::Or, operands } => operands.iter().flat_map(|o| negative_presence_proofs(o, type_of)).collect(),
        Expression::Not { expression } => presence_proofs(expression, type_of),
        Expression::Function { fn_, args } if fn_ == "isnull" && args.len() == 1 => presence_subject(&args[0]).into_iter().collect(),
        Expression::Compare { op, left, right } => {
            let mut proofs = match blank_test(*op, left, right) {
                Some((subject, Blank::Blank)) => non_blank_proof(subject),
                _ => Vec::new(),
            };
            if *op != FilterOperator::Eq {
                return proofs;
            }
            for (subject, other) in [(&**left, &**right), (&**right, &**left)] {
                if is_null_literal(other)
                    && let Some(proof) = presence_subject(subject)
                {
                    proofs.push(proof);
                }
            }
            proofs
        }
        _ => Vec::new(),
    }
}

/// `fail("…")` written as a value (language version 5): its canonical call.
pub fn is_fail(expr: &Expression) -> bool {
    matches!(expr, Expression::Function { fn_, .. } if fn_ == "error")
}

/// `proofsAfter`: what an expression proves present once its value has
/// arrived (language version 5) — an arm that only fails never arrives, so
/// the code after `x != null ? x : fail("…")` knows `x` present, as the code
/// after `if (x == null) { fail("…") }` does; and `coalesce(x, fail("…"))`
/// arrives only with `x` present.
pub fn proofs_after(expr: &Expression, type_of: &mut dyn FnMut(&Expression) -> Option<Ty>) -> Vec<PresenceProof> {
    match expr {
        Expression::Conditional { condition, then, else_ } if is_fail(then) => {
            let mut proofs = negative_presence_proofs(condition, type_of);
            proofs.extend(proofs_after(else_, type_of));
            proofs
        }
        Expression::Conditional { condition, then, else_ } if is_fail(else_) => {
            let mut proofs = presence_proofs(condition, type_of);
            proofs.extend(proofs_after(then, type_of));
            proofs
        }
        Expression::Function { fn_, args } if fn_ == "coalesce" => match args.as_slice() {
            [subject, last] if is_fail(last) => presence_subject(subject).into_iter().collect(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}
