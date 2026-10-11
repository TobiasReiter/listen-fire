//! An expression spelled back as the formula grammar writes it
//! (packages/shared/expression/formula.ts `serialize`, with names resolved
//! to themselves): what an `ONLY(…)` that counted more than one names in
//! its failure. `None` for a kind this engine does not spell, which the run
//! never meets (admission refuses an `ONLY` of one, `aggregate:only`).

use movement_parser::lowering::expression::{
    AggregationFunction, ArithmeticOp, EdgeDirection, Expression, FilterOperator, ListElement, LogicalOp, ObjectMember, OrderDirection, StaticValue,
    TraversalStep,
};

/// `serialize(expr, (id) => id)`.
pub fn spell(expr: &Expression) -> Option<String> {
    spell_at(expr, 0)
}

/// `KEYWORDS`: the words the tokenizer folds to a keyword.
const KEYWORDS: [&str; 13] = ["AND", "OR", "NOT", "IF", "THEN", "ELSE", "END", "TRUE", "FALSE", "NULL", "CONTAINS", "EXISTS", "IN"];

/// `needsQuote`.
fn needs_quote(name: &str) -> bool {
    let mut chars = name.chars();
    !(chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_'))
}

/// `quoteName`.
fn quote_name(name: &str) -> String {
    if !needs_quote(name) {
        return name.to_string();
    }
    let escaped: String = name.chars().flat_map(|c| if c == '\\' || c == '`' { vec!['\\', c] } else { vec![c] }).collect();
    format!("`{escaped}`")
}

/// `quoteString`.
fn quote_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// `serializeObjectKey`.
fn object_key(key: &str) -> String {
    if !needs_quote(key) && !KEYWORDS.contains(&crate::js::to_upper_case(key).as_str()) { key.to_string() } else { quote_string(key) }
}

/// `isSimpleExpression`.
fn simple(expr: &Expression) -> bool {
    matches!(
        expr,
        Expression::Property { .. }
            | Expression::EdgeProperty { .. }
            | Expression::Static { .. }
            | Expression::Meta { .. }
            | Expression::ParentResult { .. }
            | Expression::ActionResult { .. }
            | Expression::Resource { .. }
            | Expression::LinkedObject { .. }
    )
}

fn op_text(op: FilterOperator) -> &'static str {
    match op {
        FilterOperator::Eq => "=",
        FilterOperator::Neq => "!=",
        FilterOperator::Contains => "contains",
        FilterOperator::Gt => ">",
        FilterOperator::Gte => ">=",
        FilterOperator::Lt => "<",
        FilterOperator::Lte => "<=",
        FilterOperator::Exists => "exists",
        FilterOperator::In => "in",
        FilterOperator::Within => "WITHIN",
    }
}

fn math_text(op: ArithmeticOp) -> &'static str {
    match op {
        ArithmeticOp::Add => "+",
        ArithmeticOp::Sub => "-",
        ArithmeticOp::Mul => "*",
        ArithmeticOp::Div => "/",
        ArithmeticOp::Rem => "%",
    }
}

fn aggregate_name(fn_: AggregationFunction) -> String {
    match fn_ {
        AggregationFunction::Llm => "LLM_AGG".into(),
        other => crate::js::to_upper_case(other.id()),
    }
}

fn parens(inner: String, parent: u8, prec: u8) -> String {
    if parent > prec { format!("({inner})") } else { inner }
}

fn spell_at(expr: &Expression, parent: u8) -> Option<String> {
    let ser = |e: &Expression| spell_at(e, 0);
    Some(match expr {
        Expression::Property { property_type_id } => quote_name(property_type_id),
        Expression::EdgeProperty { property_type_id } => format!("edge.{}", quote_name(property_type_id)),
        Expression::Static { value } => match value {
            StaticValue::String(text) => quote_string(text),
            StaticValue::Null => "null".into(),
            StaticValue::Bool(b) => b.to_string(),
            StaticValue::Number(n) => crate::js::number_to_string(n.0),
        },
        Expression::Llm { prompt, prompt_expression, tier } => {
            let tier = tier.as_deref().map_or(String::new(), |t| format!(", {}", quote_string(t)));
            match prompt_expression {
                Some(e) => format!("AI({}{tier})", ser(e)?),
                None => format!("AI({}{tier})", quote_string(prompt)),
            }
        }
        Expression::Meta { key } => format!("@{key}"),
        Expression::ParentResult { field } => format!("@parent.{field}"),
        Expression::ActionResult { node_id, field } => format!("RESULT({}).{}", quote_name(node_id), quote_name(field)),
        Expression::Resource { field } => format!("@resource.{field}"),
        Expression::LinkedObject { adapter, field } => format!("-[#linked WHERE type = \"{adapter}\"]->.{field}"),
        Expression::ExtractValue { description } => format!("EXTRACT_VALUE({})", quote_string(description)),
        Expression::AliasRef { name } => quote_name(name),
        Expression::List { elements } => {
            let parts = elements
                .iter()
                .map(|e| match e {
                    ListElement::Expression(e) => ser(e),
                    ListElement::Spread(spread) => ser(&spread.expression).map(|s| format!("...{s}")),
                })
                .collect::<Option<Vec<_>>>()?;
            format!("[{}]", parts.join(", "))
        }
        Expression::Object { entries } => {
            let parts = entries
                .iter()
                .map(|m| match m {
                    ObjectMember::Entry { key, value } => ser(value).map(|v| format!("{}: {v}", object_key(key))),
                    ObjectMember::Spread(spread) => ser(&spread.expression).map(|s| format!("...{s}")),
                })
                .collect::<Option<Vec<_>>>()?;
            format!("{{{}}}", parts.join(", "))
        }
        Expression::Traverse { alias_root, steps, expression } => {
            let inner = ser(expression)?;
            let inner = if simple(expression) { inner } else { format!("({inner})") };
            let root = alias_root.as_deref().map_or(String::new(), quote_name);
            if alias_root.is_some() && steps.is_empty() {
                return Some(format!("{root}.{inner}"));
            }
            let steps = steps.iter().map(step).collect::<Option<Vec<_>>>()?;
            format!("{root}{}.{inner}", steps.join(""))
        }
        Expression::Compare { op: FilterOperator::Within, left, right } => {
            let duration = match right.as_ref() {
                Expression::Static { value: StaticValue::String(text) } => text.clone(),
                Expression::Static { .. } => spell_at(right, 4)?,
                other => spell_at(other, 4)?,
            };
            parens(format!("{} WITHIN {duration}", spell_at(left, 3)?), parent, 3)
        }
        Expression::Compare { op, left, right } => parens(format!("{} {} {}", spell_at(left, 3)?, op_text(*op), spell_at(right, 4)?), parent, 3),
        Expression::Arithmetic { op, left, right } => {
            let prec = if matches!(op, ArithmeticOp::Mul | ArithmeticOp::Div | ArithmeticOp::Rem) { 5 } else { 4 };
            parens(format!("{} {} {}", spell_at(left, prec)?, math_text(*op), spell_at(right, prec + 1)?), parent, prec)
        }
        Expression::Logical { op, operands } => {
            let prec = if *op == LogicalOp::And { 2 } else { 1 };
            let word = if *op == LogicalOp::And { " AND " } else { " OR " };
            let parts = operands.iter().map(|o| spell_at(o, prec + 1)).collect::<Option<Vec<_>>>()?;
            parens(parts.join(word), parent, prec)
        }
        Expression::Not { expression } => format!("NOT {}", spell_at(expression, 6)?),
        Expression::Negate { expression } => parens(format!("-{}", spell_at(expression, 6)?), parent, 6),
        Expression::Concat { parts } => format!("CONCAT({})", parts.iter().map(ser).collect::<Option<Vec<_>>>()?.join(", ")),
        Expression::Conditional { .. } => {
            let mut parts = Vec::new();
            let mut current = expr;
            while let Expression::Conditional { condition, then, else_ } = current {
                let lead = if parts.is_empty() { "IF" } else { "ELSE IF" };
                parts.push(format!("{lead} {} THEN {}", ser(condition)?, ser(then)?));
                current = else_;
            }
            parts.push(format!("ELSE {} END", ser(current)?));
            parts.join(" ")
        }
        Expression::Aggregate { fn_, expression, separator, prompt, order_by, order_direction } => {
            let mut args = vec![ser(expression)?];
            if *fn_ == AggregationFunction::Sort {
                if let Some(key) = order_by {
                    args.push(ser(key)?);
                }
                if *order_direction == Some(OrderDirection::Desc) {
                    args.push("DESC".into());
                }
                return Some(format!("{}({})", aggregate_name(*fn_), args.join(", ")));
            }
            if let Some(separator) = separator {
                args.push(quote_string(separator));
            }
            if let Some(prompt) = prompt {
                args.push(quote_string(prompt));
            }
            format!("{}({})", aggregate_name(*fn_), args.join(", "))
        }
        Expression::Function { fn_, args } => format!("{}({})", crate::js::to_upper_case(fn_), args.iter().map(ser).collect::<Option<Vec<_>>>()?.join(", ")),
        Expression::KgExists { query, params } | Expression::KgValue { query, params } => {
            let name = if matches!(expr, Expression::KgExists { .. }) { "KG_EXISTS" } else { "KG_VALUE" };
            let mut args = vec![quote_string(query)];
            args.extend(params.iter().map(ser).collect::<Option<Vec<_>>>()?);
            format!("{name}({})", args.join(", "))
        }
        Expression::At { expression, index } => format!("AT({}, {})", ser(expression)?, ser(index)?),
        // The resource walks and EXISTS: spelled by their own grammar, not
        // reached by an ONLY this engine runs.
        Expression::ResourceTraverse { .. } | Expression::Exists { .. } => return None,
    })
}

/// `serializeTraversalStep` (no edge info: the direction kept as written).
fn step(step: &TraversalStep) -> Option<String> {
    let TraversalStep::Edge(edge) = step else { return None };
    let mut suffix = match &edge.expression_filter {
        Some(filter) => format!(" WHERE {}", edge_filter(filter)?),
        None => String::new(),
    };
    if let Some(cardinality) = &edge.cardinality {
        if let Some(key) = &cardinality.order_by {
            suffix.push_str(&format!(" ORDER BY {}", spell(key)?));
            if cardinality.order_direction == Some(OrderDirection::Desc) {
                suffix.push_str(" DESC");
            }
        }
        if let Some(limit) = &cardinality.limit {
            suffix.push_str(&format!(" LIMIT {}", crate::js::number_to_string(limit.0)));
        }
    }
    let alias = edge.alias.as_deref().map_or(String::new(), quote_name);
    let name = if needs_quote(&edge.edge_type_id) { format!("`{}`", edge.edge_type_id) } else { edge.edge_type_id.clone() };
    Some(match edge.direction {
        EdgeDirection::Incoming => format!("<-[{alias}:{name}{suffix}]-"),
        EdgeDirection::Outgoing => format!("-[{alias}:{name}{suffix}]->"),
    })
}

/// `serializeEdgeFilter`: an edge property by its bare name.
fn edge_filter(expr: &Expression) -> Option<String> {
    Some(match expr {
        Expression::EdgeProperty { property_type_id } => quote_name(property_type_id),
        Expression::Compare { op, left, right } => format!("{} {} {}", edge_filter(left)?, op_text(*op), edge_filter(right)?),
        Expression::Logical { op, operands } => {
            let word = if *op == LogicalOp::And { " AND " } else { " OR " };
            operands.iter().map(edge_filter).collect::<Option<Vec<_>>>()?.join(word)
        }
        Expression::Not { expression } => format!("NOT {}", edge_filter(expression)?),
        other => spell(other)?,
    })
}
