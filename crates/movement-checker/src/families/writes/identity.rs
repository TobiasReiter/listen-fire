//! How a write or a match finds the record it means: the `unique by`
//! clauses (check.ts `checkIdentity` and its helpers). One rule set for
//! both, because a match is a write's identity half on its own.

use movement_parser::ast::{ExprSlot, Span, UniqueClause};
use movement_parser::catalog::types::{FuzzyResolution, WritableRootSchema};
use movement_parser::lowering::expression::{Expression, FilterOperator, ListElement, LogicalOp, StaticValue};

use super::Field;
use crate::checker::Checker;
use crate::codes;
use crate::scope::{Resolution, ScopeId};
use crate::slots::{collect_expression_names, expression_of_slot, expression_of_text};
use crate::types::field::{Ty, strip_absent};
use crate::types::position::Position;
use crate::version;

/// One top-level component of a `unique by (…)` predicate, its leading
/// `FUZZY` lifted off (`UniquenessConjunct`). `offset` counts UTF-16 units.
struct Conjunct {
    raw: String,
    offset: usize,
    fuzzy: bool,
}

impl Checker<'_> {
    /// `checkIdentity`.
    pub(super) fn check_identity(&mut self, unique_by: &[UniqueClause], root: Option<&WritableRootSchema>, description: &str, scope: ScopeId, local: bool) {
        if let Some(root) = root
            && root.uniqueness_authorable == Some(false)
            && let Some(first) = unique_by.first()
        {
            self.report(
                codes::UNIQUE_NOT_AUTHORABLE,
                format!(
                    "{description} decides record identity itself — 'unique by' isn't configurable here. Drop the clause; matching on the system's own keys happens automatically"
                ),
                first.span,
            );
            return;
        }
        for clause in unique_by {
            // `None` once a part fails to parse (MOV_EXPR_PARSE, said here).
            let mut has_key: Option<bool> = Some(false);
            for part in split_conjuncts(&clause.predicate.raw) {
                let parsed = match expression_of_text(&part.raw) {
                    Ok(parsed) => parsed,
                    Err(error) => {
                        self.report(codes::EXPR_PARSE, error.message, span_within(&clause.predicate, part.offset + error.pos.unwrap_or(0)));
                        has_key = None;
                        continue;
                    }
                };
                if has_key == Some(false) && and_conjuncts(&parsed).into_iter().any(|c| identity_key_of(c).is_some()) {
                    has_key = Some(true);
                }
                let span = span_within(&clause.predicate, part.offset);
                self.check_identity_narrowing(&parsed, root, scope, &part.raw, span);
                let Some(root) = root else { continue };
                let names = collect_expression_names(&parsed);
                let refs: Vec<String> = names.distinct_refs().into_iter().filter(|r| !names.aliases.contains(*r)).map(str::to_string).collect();
                if part.fuzzy {
                    let fields: Vec<&str> = refs.iter().filter(|r| root.fields.contains_key(*r)).map(String::as_str).collect();
                    self.check_fuzzy_component(root, description, &fields, span);
                }
                for reference in &refs {
                    if root.fields.contains_key(reference) {
                        continue;
                    }
                    if !local && matches!(self.scopes.resolve(scope, reference), Resolution::Found(_)) {
                        continue;
                    }
                    self.report(
                        codes::UNIQUE_UNKNOWN_FIELD,
                        format!(
                            "'{reference}' is not a field of {description} or a bound handle — a 'unique by' predicate identifies by fields of the record or by a bound parent"
                        ),
                        clause.span,
                    );
                }
            }
            if has_key == Some(false) {
                self.report(
                    codes::UNIQUE_CONJUNCT_NEEDS_WHERE,
                    format!(
                        "'unique by ({})' has nothing to find the record by — its tests only narrow the candidates a key finds. Add the field or parent that identifies the record ('unique by (`Name`, …)'), or use a WHERE on the target instead",
                        clause.predicate.raw
                    ),
                    clause.span,
                );
            }
        }
        self.check_native_uniqueness(unique_by, root, description);
    }

    /// `checkIdentityNarrowing`: a conjunct that is not part of the key may
    /// test only the candidate's own fields.
    fn check_identity_narrowing(&mut self, parsed: &Expression, root: Option<&WritableRootSchema>, scope: ScopeId, text: &str, span: Span) {
        for conjunct in and_conjuncts(parsed) {
            if identity_key_of(conjunct).is_some() {
                continue;
            }
            let reason = match pure_leaf_reads(conjunct) {
                None => Some("it reads beyond the record — a hop, a call, or a value computed per candidate".to_string()),
                Some(leaves) => root.and_then(|root| {
                    leaves
                        .into_iter()
                        .find(|leaf| match leaf {
                            Expression::Property { property_type_id, .. } | Expression::EdgeProperty { property_type_id, .. } => {
                                !root.fields.contains_key(property_type_id) && matches!(self.scopes.resolve(scope, property_type_id), Resolution::Found(_))
                            }
                            _ => true,
                        })
                        .map(|outer| format!("'{}' is not a field of the record — it names a value from elsewhere in the run", leaf_read_key(outer)))
                }),
            };
            let Some(reason) = reason else { continue };
            self.report(
                codes::UNIQUE_CONJUNCT_NEEDS_WHERE,
                format!(
                    "'{text}' in 'unique by' can't narrow the candidates: {reason}. A 'unique by' component that isn't a key can only test the candidate's own fields — use a WHERE on the target instead ('write crm-[c:Companies WHERE …]-> {{ … }}'), where the candidate is named by the hop's alias and the rest of the run is in scope"
                ),
                span,
            );
        }
    }

    /// `checkFuzzyComponent`: FUZZY is the target's promise, per field.
    fn check_fuzzy_component(&mut self, root: &WritableRootSchema, description: &str, fields: &[&str], span: Span) {
        match &root.fuzzy_resolution {
            Some(FuzzyResolution::All(true)) => {}
            Some(FuzzyResolution::Fields(support)) => {
                let listed: Vec<String> = support.iter().map(|f| format!("`{f}`")).collect();
                for field in fields {
                    if support.iter().any(|s| s == field) {
                        continue;
                    }
                    self.report(
                        codes::UNIQUE_FUZZY_UNSUPPORTED,
                        format!(
                            "FUZZY isn't available for `{field}` on {description} — it matches `{field}` exactly. Similarity covers {}: drop FUZZY here, or match by similarity on one of those",
                            listed.join(", ")
                        ),
                        span,
                    );
                }
            }
            _ => self.report(
                codes::UNIQUE_FUZZY_UNSUPPORTED,
                format!(
                    "FUZZY isn't available on {description} — it matches identity exactly, not by similarity. Drop FUZZY and identify by an exact field, or pick a target that supports fuzzy matching"
                ),
                span,
            ),
        }
    }

    /// `checkNativeUniqueness`: an authored clause the target already enforces.
    fn check_native_uniqueness(&mut self, unique_by: &[UniqueClause], root: Option<&WritableRootSchema>, description: &str) {
        let Some(root) = root else { return };
        let Some(native) = root.native_uniqueness.as_ref().filter(|n| !n.is_empty()) else { return };
        for clause in unique_by {
            let Some(refs) = unique_clause_refs(clause) else { continue };
            let fields: Vec<&String> = refs.iter().filter(|r| root.fields.contains_key(*r)).collect();
            if fields.len() != refs.len() {
                continue;
            }
            let Some(duplicated) = native.iter().find(|group| group.len() == fields.len() && group.iter().all(|f| fields.contains(&f))) else { continue };
            let rule: Vec<String> = duplicated.iter().map(|f| format!("`{f}`")).collect();
            self.report_with(
                codes::UNIQUE_NATIVE_REDUNDANT,
                format!("{description} already matches records by {} natively — this 'unique by' duplicates the built-in rule and can be dropped", rule.join(" + ")),
                clause.span,
                crate::diagnostic::Severity::Info,
            );
        }
    }

    /// `reportBlankableIdentityKey`: a text key that may be `""`, on a move
    /// up across version 2 (where an empty key became no key).
    pub(super) fn report_blankable_identity_key(&mut self, unique_by: &[UniqueClause], field: &Field, value_type: Option<&Ty>, description: &str, scope: ScopeId) {
        if !self.upgrade_crosses(2) {
            return;
        }
        if !matches!(value_type.map(strip_absent), Some(Ty::Text)) {
            return;
        }
        if !unique_by.iter().any(|clause| unique_clause_refs(clause).is_some_and(|refs| refs.contains(&field.name))) {
            return;
        }
        let Ok(value) = expression_of_slot(&field.value) else { return };
        if let Expression::Static { value: StaticValue::String(text) } = &value
            && !text.trim().is_empty()
        {
            return;
        }
        if let Some((root, property)) = crate::types::narrowing::direct_field_read(&value)
            && let Resolution::Found(id) = self.scopes.resolve(scope, &root)
        {
            let types = &self.scopes.symbol(id).types;
            if matches!(types.pos, Some(Position::Extract { .. })) || types.non_blank_fields.contains(&property) {
                return;
            }
        }
        if let Some(name) = crate::types::narrowing::bare_name(&value)
            && let Resolution::Found(id) = self.scopes.resolve(scope, name)
            && self.scopes.symbol(id).types.non_blank
        {
            return;
        }
        self.report_upgrade_warning(
            codes::UNIQUE_KEY_MAY_BE_BLANK,
            format!(
                "'{}' identifies {description}, and its value may be \"\" — since language version {} an empty key is no key, so when it is \"\" nothing is matched by it (a write creates a new record each time). Before it, \"\" matched another record whose '{}' was \"\". If that matters here, guard the write on '{}' != \"\".",
                field.name,
                version::describe(2),
                field.name,
                field.name
            ),
            field.value.span,
        );
    }
}

/// `uniqueClauseRefs`: the distinct names a clause reads; `None` when a part
/// does not parse.
pub fn unique_clause_refs(clause: &UniqueClause) -> Option<Vec<String>> {
    let mut refs: Vec<String> = Vec::new();
    for part in split_conjuncts(&clause.predicate.raw) {
        let parsed = expression_of_text(&part.raw).ok()?;
        for reference in collect_expression_names(&parsed).refs {
            if !refs.contains(&reference) {
                refs.push(reference);
            }
        }
    }
    Some(refs)
}

/// `spanWithin`: the span from `pos` (UTF-16 units into the slot) to the slot's end.
fn span_within(slot: &ExprSlot, pos: usize) -> Span {
    let units: Vec<u16> = slot.raw.encode_utf16().collect();
    if pos > units.len() {
        return slot.span;
    }
    let mut start = slot.span.start;
    for &unit in &units[..pos] {
        if unit == u16::from(b'\n') {
            start.line += 1;
            start.col = 1;
        } else {
            start.col += 1;
        }
    }
    Span { start, end: slot.span.end }
}

/// `splitUniquenessConjuncts` (expression/bridge.ts): the predicate split on
/// its top-level commas, strings and brackets blanked first.
fn split_conjuncts(raw: &str) -> Vec<Conjunct> {
    let units: Vec<u16> = raw.encode_utf16().collect();
    let blanked = blank_literals(&units);
    let mut depth: i64 = 0;
    let mut spans = Vec::new();
    let mut start = 0;
    for (i, &unit) in blanked.iter().enumerate() {
        let at = if unit == u16::from(b'(') || unit == u16::from(b'[') || unit == u16::from(b'{') {
            depth += 1;
            depth - 1
        } else if unit == u16::from(b')') || unit == u16::from(b']') || unit == u16::from(b'}') {
            depth -= 1;
            depth
        } else {
            depth
        };
        if unit == u16::from(b',') && at == 0 {
            spans.push((start, i));
            start = i + 1;
        }
    }
    spans.push((start, units.len()));
    spans
        .into_iter()
        .map(|(from, to)| {
            let text = String::from_utf16_lossy(&units[from..to]);
            let lead = text.len() - text.trim_start().len();
            let lead_units = text[..lead].encode_utf16().count();
            let rest = &text[lead..];
            if let Some(after) = rest.strip_prefix("FUZZY")
                && !after.chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                let gap = after.len() - after.trim_start().len();
                let modifier_units = lead_units + "FUZZY".len() + after[..gap].encode_utf16().count();
                return Conjunct { raw: after.trim().to_string(), offset: from + modifier_units, fuzzy: true };
            }
            Conjunct { raw: text.trim().to_string(), offset: from + lead_units, fuzzy: false }
        })
        .collect()
}

/// `blankLiterals`: every string and backtick literal blanked, same length.
fn blank_literals(units: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut i = 0;
    while i < units.len() {
        let ch = units[i];
        if ch == u16::from(b'"') || ch == u16::from(b'\'') || ch == u16::from(b'`') {
            let mut end = i + 1;
            while end < units.len() {
                if units[end] == u16::from(b'\\') && end + 1 < units.len() {
                    end += 2;
                    continue;
                }
                if units[end] == ch {
                    end += 1;
                    break;
                }
                end += 1;
            }
            let end = end.min(units.len());
            out.extend(std::iter::repeat_n(u16::from(b' '), end - i));
            i = end;
            continue;
        }
        out.push(ch);
        i += 1;
    }
    out
}

/// `flattenAndConjuncts`.
fn and_conjuncts(expr: &Expression) -> Vec<&Expression> {
    match expr {
        Expression::Logical { op: LogicalOp::And, operands } => operands.iter().flat_map(and_conjuncts).collect(),
        other => vec![other],
    }
}

/// `identityKeyOf`: the name a conjunct keys by — a bare name, or `field == value`.
fn identity_key_of(conjunct: &Expression) -> Option<&str> {
    match conjunct {
        Expression::Property { property_type_id, .. } | Expression::EdgeProperty { property_type_id, .. } => Some(property_type_id),
        Expression::AliasRef { name } => Some(name),
        Expression::Compare { op: FilterOperator::Eq, left, .. } => match left.as_ref() {
            Expression::Property { property_type_id, .. } | Expression::EdgeProperty { property_type_id, .. } => Some(property_type_id),
            _ => None,
        },
        _ => None,
    }
}

/// `isPurePredicate` then `pureLeafReads` (expression/filter.ts).
fn pure_leaf_reads(expr: &Expression) -> Option<Vec<&Expression>> {
    let mut leaves = Vec::new();
    leaf_reads(expr, &mut leaves).then_some(leaves)
}

fn leaf_reads<'e>(expr: &'e Expression, into: &mut Vec<&'e Expression>) -> bool {
    match expr {
        Expression::Static { .. } => true,
        Expression::Property { .. } | Expression::EdgeProperty { .. } | Expression::AliasRef { .. } | Expression::Meta { .. } => {
            into.push(expr);
            true
        }
        Expression::Traverse { steps, expression, .. } if steps.is_empty() => {
            if !matches!(expression.as_ref(), Expression::Property { .. } | Expression::EdgeProperty { .. } | Expression::AliasRef { .. }) {
                return false;
            }
            into.push(expr);
            true
        }
        Expression::List { elements } => elements.iter().all(|e| match e {
            ListElement::Expression(e) => leaf_reads(e, into),
            ListElement::Spread(spread) => leaf_reads(&spread.expression, into),
        }),
        Expression::Concat { parts } => parts.iter().all(|p| leaf_reads(p, into)),
        Expression::Conditional { condition, then, else_ } => leaf_reads(condition, into) && leaf_reads(then, into) && leaf_reads(else_, into),
        Expression::Compare { left, right, .. } | Expression::Arithmetic { left, right, .. } => leaf_reads(left, into) && leaf_reads(right, into),
        Expression::Logical { operands, .. } => operands.iter().all(|o| leaf_reads(o, into)),
        Expression::Not { expression } | Expression::Negate { expression } => leaf_reads(expression, into),
        Expression::At { expression, index } => leaf_reads(expression, into) && leaf_reads(index, into),
        _ => false,
    }
}

/// `leafReadKey`.
fn leaf_read_key(leaf: &Expression) -> String {
    match leaf {
        Expression::AliasRef { name } => name.clone(),
        Expression::Property { property_type_id, .. } | Expression::EdgeProperty { property_type_id, .. } => property_type_id.clone(),
        Expression::Meta { key } => format!("@{key}"),
        Expression::Traverse { alias_root, expression, .. } => {
            let inner = match expression.as_ref() {
                Expression::Property { property_type_id, .. } | Expression::EdgeProperty { property_type_id, .. } => property_type_id.clone(),
                Expression::AliasRef { name } => name.clone(),
                Expression::Traverse { .. } => leaf_read_key(expression),
                _ => String::new(),
            };
            format!("{}.{inner}", alias_root.as_deref().unwrap_or(""))
        }
        _ => String::new(),
    }
}
