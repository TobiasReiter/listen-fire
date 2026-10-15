//! Reading an expression slot (expression/bridge.ts): the slot's text parsed
//! by the expression grammar and lowered to the shared `Expression`, and the
//! names an expression reads (`collectExpressionNames` in check.ts).

use std::collections::HashSet;

use movement_parser::ast::ExprSlot;
use movement_parser::expr::parse_expression;
use movement_parser::lowering::expression::{Expression, ListElement, MetaSetting, ObjectMember, TraversalStep};
use movement_parser::lowering::lower_expression;
use movement_parser::scan::scan_name;

/// Why a slot has no expression: the grammar's or the lowering's refusal.
#[derive(Debug, Clone)]
pub struct SlotError {
    pub message: String,
    pub code: Option<String>,
}

/// `expressionOfSlot`.
pub fn expression_of_slot(slot: &ExprSlot) -> Result<Expression, SlotError> {
    expression_of_text(&slot.raw)
}

/// `conditionOfSlot`: the slot as an `if` condition.
pub fn condition_of_slot(slot: &ExprSlot) -> Result<movement_parser::lowering::condition::MovementCondition, SlotError> {
    let tree = parse_expression(&slot.raw).map_err(|e| SlotError { message: e.message.clone(), code: None })?;
    movement_parser::lowering::lower_condition(&tree, &slot.raw).map_err(|e| SlotError { message: e.message.clone(), code: e.code.clone() })
}

/// `parseMovementExpression`: a text that is not a slot.
pub fn expression_of_text(raw: &str) -> Result<Expression, SlotError> {
    let tree = parse_expression(raw).map_err(|e| SlotError { message: e.message.clone(), code: None })?;
    lower_expression(&tree, raw).map_err(|e| SlotError { message: e.message.clone(), code: e.code.clone() })
}

/// `BARE_IDENT`.
pub fn is_bare_ident(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `EXPR_LITERALS`: the bare words a slot reads as a literal.
pub fn is_literal_word(text: &str) -> bool {
    matches!(text.to_uppercase().as_str(), "TRUE" | "FALSE" | "NULL")
}

#[derive(Default, Debug)]
pub struct CollectedNames {
    /// Names that resolve against the statement's scope, in reading order.
    pub refs: Vec<String>,
    /// Aliases bound by the expression's own hops.
    pub aliases: HashSet<String>,
    /// Every rooted read: its root and the members it reaches for.
    pub rooted: Vec<(String, Vec<String>)>,
}

impl CollectedNames {
    /// The refs once each, first occurrence first (`new Set(names.refs)`).
    pub fn distinct_refs(&self) -> Vec<&str> {
        let mut seen = HashSet::new();
        self.refs.iter().filter(|r| seen.insert(r.as_str())).map(String::as_str).collect()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Position {
    Value,
    Field,
    Member,
}

pub fn collect_expression_names(expr: &Expression) -> CollectedNames {
    let mut out = CollectedNames::default();
    collect(expr, &mut out, Position::Value);
    out
}

fn collect_from_steps(steps: &[TraversalStep], out: &mut CollectedNames) {
    for step in steps {
        match step {
            TraversalStep::Edge(edge) => {
                if let Some(alias) = &edge.alias {
                    out.aliases.insert(alias.clone());
                }
                if let Some(filter) = &edge.expression_filter {
                    collect(filter, out, Position::Field);
                }
            }
            TraversalStep::MetaEdge(meta) => {
                if let Some(alias) = &meta.alias {
                    out.aliases.insert(alias.clone());
                }
                if let Some(filter) = &meta.expression_filter {
                    collect(filter, out, Position::Field);
                }
                // `description`, `data`, `plugin`, `enrichWith`, `extra`, in that order.
                if let Some(config) = &meta.config {
                    for key in ["description", "data", "plugin", "enrichWith", "extra"] {
                        match config.get(key) {
                            Some(MetaSetting::Expression(e)) => collect(e, out, Position::Field),
                            Some(MetaSetting::Expressions(es)) => es.iter().for_each(|e| collect(e, out, Position::Field)),
                            Some(MetaSetting::EnrichWith(entries)) => {
                                for entry in entries {
                                    collect(&entry.transform, out, Position::Field);
                                    collect(&entry.argument, out, Position::Field);
                                }
                            }
                            Some(MetaSetting::Extra(extra)) => extra.values().for_each(|e| collect(e, out, Position::Field)),
                            None => {}
                        }
                    }
                }
            }
            TraversalStep::LinkBack {} | TraversalStep::Resource(_) => {}
        }
    }
}

fn member_names(steps: &[TraversalStep], expression: &Expression) -> Vec<String> {
    let mut members: Vec<String> = steps
        .iter()
        .filter_map(|s| match s {
            TraversalStep::Edge(edge) => Some(edge.edge_type_id.clone()),
            _ => None,
        })
        .collect();
    if let Expression::Property { property_type_id } = expression {
        members.push(property_type_id.clone());
    }
    members
}

fn collect(expr: &Expression, out: &mut CollectedNames, position: Position) {
    match expr {
        Expression::AliasRef { name } => out.refs.push(name.clone()),
        Expression::Traverse { alias_root, steps, expression } => {
            if let Some(root) = alias_root
                && position != Position::Member
            {
                out.refs.push(root.clone());
                out.rooted.push((root.clone(), member_names(steps, expression)));
            }
            collect_from_steps(steps, out);
            collect(expression, out, if steps.is_empty() { Position::Member } else { Position::Field });
        }
        Expression::Exists { steps, where_ } => {
            collect_from_steps(steps, out);
            if let Some(w) = where_ {
                collect(w, out, Position::Field);
            }
        }
        Expression::ResourceTraverse { expression_filter, expression, .. } => {
            if let Some(f) = expression_filter {
                collect(f, out, Position::Field);
            }
            collect(expression, out, Position::Field);
        }
        Expression::Llm { prompt_expression, .. } => {
            if let Some(p) = prompt_expression {
                collect(p, out, Position::Value);
            }
        }
        Expression::List { elements } => {
            for element in elements {
                match element {
                    ListElement::Expression(e) => collect(e, out, position),
                    ListElement::Spread(s) => collect(&s.expression, out, position),
                }
            }
        }
        Expression::Object { entries } => {
            for entry in entries {
                match entry {
                    ObjectMember::Entry { value, .. } => collect(value, out, position),
                    ObjectMember::Spread(s) => collect(&s.expression, out, position),
                }
            }
        }
        Expression::Arithmetic { left, right, .. } | Expression::Compare { left, right, .. } => {
            collect(left, out, position);
            collect(right, out, position);
        }
        Expression::Logical { operands, .. } => operands.iter().for_each(|o| collect(o, out, position)),
        Expression::Not { expression } | Expression::Negate { expression } | Expression::Aggregate { expression, .. } => {
            collect(expression, out, position)
        }
        Expression::Concat { parts } => parts.iter().for_each(|p| collect(p, out, position)),
        Expression::Conditional { condition, then, else_ } => {
            collect(condition, out, position);
            collect(then, out, position);
            collect(else_, out, position);
        }
        Expression::At { expression, index } => {
            collect(expression, out, position);
            collect(index, out, position);
        }
        Expression::Function { args, .. } => args.iter().for_each(|a| collect(a, out, position)),
        Expression::KgExists { params, .. } | Expression::KgValue { params, .. } => {
            params.iter().for_each(|p| collect(p, out, position))
        }
        Expression::Property { property_type_id } => {
            if position == Position::Value {
                out.refs.push(property_type_id.clone());
            }
        }
        Expression::EdgeProperty { .. }
        | Expression::Static { .. }
        | Expression::Meta { .. }
        | Expression::ParentResult { .. }
        | Expression::ActionResult { .. }
        | Expression::Resource { .. }
        | Expression::LinkedObject { .. }
        | Expression::ExtractValue { .. } => {}
    }
}

/// `extractHopAliases`: the alias opening each hop of a path head's text.
/// Offsets are UTF-16 units, as the TypeScript's string indices are.
pub fn extract_hop_aliases(hops_raw: &str) -> Vec<String> {
    let src: Vec<u16> = hops_raw.encode_utf16().collect();
    let (dash, open) = (u16::from(b'-'), u16::from(b'['));
    let mut aliases = Vec::new();
    let mut i = 0;
    while i + 1 < src.len() {
        if !(src[i] == dash && src[i + 1] == open) {
            i += 1;
            continue;
        }
        let interior = i + 2;
        if let Some(alias) = hop_alias_at(&src, interior) {
            aliases.push(alias);
        }
        let mut depth = 1;
        let mut j = interior;
        while j < src.len() && depth > 0 {
            match char::from_u32(u32::from(src[j])) {
                Some('"' | '\'' | '`') => {
                    j = skip_string(&src, j);
                    continue;
                }
                Some('[' | '(' | '{') => depth += 1,
                Some(']' | ')' | '}') => depth -= 1,
                _ => {}
            }
            j += 1;
        }
        i = j;
    }
    aliases
}

fn skip_string(src: &[u16], start: usize) -> usize {
    let quote = src[start];
    let mut i = start + 1;
    while i < src.len() {
        if src[i] == u16::from(b'\\') {
            i += 2;
            continue;
        }
        if src[i] == quote {
            return i + 1;
        }
        i += 1;
    }
    src.len()
}

fn hop_alias_at(src: &[u16], start: usize) -> Option<String> {
    let space = |c: u16| char::from_u32(u32::from(c)).is_some_and(char::is_whitespace);
    let mut i = start;
    while i < src.len() && space(src[i]) {
        i += 1;
    }
    let (name, end) = scan_name(src, i)?;
    let mut j = end;
    while j < src.len() && space(src[j]) {
        j += 1;
    }
    (src.get(j) == Some(&u16::from(b':'))).then_some(name)
}
