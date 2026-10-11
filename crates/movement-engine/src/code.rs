//! The program's code a parked state carries back (a closure's body, a
//! kept walk's head and mapping): found again in the re-parsed program by
//! where it is written. The pin makes the re-parse the same tree, so a span
//! names the one node it named when the state was written; the node itself
//! is taken from the program, never read back out of the state, and its AST
//! path is where the next park writes it from.

use movement_parser::ast::{
    ArmExpression, AwaitSource, CallArg, CallStatement, CallbackSubject, ClosureExpression, CombinatorArms, CombinatorExpression, NodeEntry, NodeLiteral, PathHead, Program,
    RValue, Span, Statement, UntilCondition,
};
use serde_json::Value as Json;

use crate::js::Js;

/// A node of the program a state names.
pub(crate) enum Found<'p> {
    Closure(&'p ClosureExpression),
    /// A kept walk: its head, and the mapping its landings go through.
    Walk(&'p PathHead, Option<&'p NodeLiteral>),
    /// A closure bound to a name (`f = (…) => { … }`).
    Bound(&'p str, &'p ClosureExpression),
}

/// Every closure the program binds to a name, anywhere, by that name.
pub(crate) fn bound_closures(program: &Program) -> Vec<(&str, &ClosureExpression)> {
    let mut found = Vec::new();
    visit(&program.statements, &mut |node| {
        if let Found::Bound(name, closure) = node {
            found.push((name, closure));
        }
    });
    found
}

/// The closure written at `span`.
pub(crate) fn closure_at(program: &Program, span: &Span) -> Option<ClosureExpression> {
    let mut found = None;
    visit(&program.statements, &mut |node| {
        if found.is_none()
            && let Found::Closure(closure) = node
            && closure.span == *span
        {
            found = Some(closure.clone());
        }
    });
    found
}

/// The kept walk whose head is written at `span`.
pub(crate) fn walk_at(program: &Program, span: &Span) -> Option<(PathHead, Option<NodeLiteral>)> {
    let mut found = None;
    visit(&program.statements, &mut |node| {
        if found.is_none()
            && let Found::Walk(head, mapping) = node
            && head.span == *span
        {
            found = Some((head.clone(), mapping.cloned()));
        }
    });
    found
}

/// The AST path (a JSON Pointer into the program's tree) of the object with
/// every one of `keys` whose `span` is `span`.
pub(crate) fn path_of(tree: &Json, keys: &[&str], span: &Json) -> Option<String> {
    fn search(node: &Json, at: &mut String, keys: &[&str], span: &Json) -> bool {
        match node {
            Json::Object(map) => {
                if keys.iter().all(|key| map.contains_key(*key)) && map.get("span") == Some(span) {
                    return true;
                }
                for (key, child) in map {
                    let before = at.len();
                    at.push('/');
                    at.push_str(&key.replace('~', "~0").replace('/', "~1"));
                    if search(child, at, keys, span) {
                        return true;
                    }
                    at.truncate(before);
                }
                false
            }
            Json::Array(items) => {
                for (index, child) in items.iter().enumerate() {
                    let before = at.len();
                    at.push('/');
                    at.push_str(&index.to_string());
                    if search(child, at, keys, span) {
                        return true;
                    }
                    at.truncate(before);
                }
                false
            }
            _ => false,
        }
    }
    let mut at = String::new();
    search(tree, &mut at, keys, span).then_some(at)
}

/// A state's `span` object, as the program's tree holds it.
pub(crate) fn span_json(value: &Js) -> Option<(Span, Json)> {
    let json = crate::env::json_of_js(value);
    let loc = |key: &str| -> Option<movement_parser::ast::Loc> {
        let at = json.get(key)?;
        Some(movement_parser::ast::Loc { line: at.get("line")?.as_u64()? as usize, col: at.get("col")?.as_u64()? as usize })
    };
    Some((Span { start: loc("start")?, end: loc("end")? }, json))
}

fn visit<'p>(statements: &'p [Statement], f: &mut dyn FnMut(Found<'p>)) {
    for statement in statements {
        match statement {
            Statement::Assign(assign) => {
                if let RValue::Closure { closure: c } = &assign.value {
                    f(Found::Bound(&assign.name, c));
                }
                rvalue(&assign.value, f)
            }
            Statement::Return(ret) => rvalue(&ret.value, f),
            Statement::Movement(movement) => visit(&movement.body, f),
            Statement::Call(call) => call_args(call, f),
            Statement::Block(block) => visit(&block.block.body, f),
            Statement::If(statement) => {
                for arm in &statement.arms {
                    visit(&arm.body, f);
                }
                if let Some(arm) = &statement.else_arm {
                    visit(&arm.body, f);
                }
            }
            Statement::Await(statement) => source(&statement.r#await.source, f),
            Statement::Combinator(statement) => combinator(&statement.combinator, f),
            Statement::Collection(statement) => arm(&statement.collection.r#fn, f),
            _ => {}
        }
    }
}

fn rvalue<'p>(value: &'p RValue, f: &mut dyn FnMut(Found<'p>)) {
    match value {
        RValue::Call { call } => call_args(call, f),
        RValue::Block { block } => visit(&block.body, f),
        RValue::Await { r#await } => source(&r#await.source, f),
        RValue::Combinator { combinator: c } => combinator(c, f),
        RValue::Collection { collection } => arm(&collection.r#fn, f),
        RValue::InlineBlock { inline_block } => visit(&inline_block.body, f),
        RValue::Callback { callback } => match &callback.subject {
            CallbackSubject::Inline { closure: c, .. } => closure(c, f),
            CallbackSubject::Named { args, .. } => {
                for arg in args {
                    call_arg(arg, f);
                }
            }
        },
        RValue::Closure { closure: c } => closure(c, f),
        RValue::Node { node: n } => node(n, f),
        RValue::Lazy { lazy } => {
            f(Found::Walk(&lazy.head, lazy.mapping.as_ref()));
            if let Some(mapping) = &lazy.mapping {
                node(mapping, f);
            }
        }
        _ => {}
    }
}

fn closure<'p>(c: &'p ClosureExpression, f: &mut dyn FnMut(Found<'p>)) {
    f(Found::Closure(c));
    visit(&c.body, f);
}

fn arm<'p>(a: &'p ArmExpression, f: &mut dyn FnMut(Found<'p>)) {
    if let ArmExpression::Closure { closure: c, .. } = a {
        closure(c, f);
    }
}

fn combinator<'p>(c: &'p CombinatorExpression, f: &mut dyn FnMut(Found<'p>)) {
    if let CombinatorArms::Literal { arms, .. } = &c.arms {
        for a in arms {
            arm(a, f);
        }
    }
}

fn source<'p>(s: &'p AwaitSource, f: &mut dyn FnMut(Found<'p>)) {
    match s {
        AwaitSource::Combinator { combinator: c, .. } => combinator(c, f),
        AwaitSource::Until { condition: UntilCondition::Closure { closure: c }, .. } => closure(c, f),
        _ => {}
    }
}

fn call_args<'p>(call: &'p CallStatement, f: &mut dyn FnMut(Found<'p>)) {
    for arg in &call.args {
        call_arg(arg, f);
    }
}

fn call_arg<'p>(arg: &'p CallArg, f: &mut dyn FnMut(Found<'p>)) {
    match arg {
        CallArg::Closure { closure: c, .. } => closure(c, f),
        CallArg::Node { node: n, .. } => node(n, f),
        CallArg::Call { call, .. } => call_args(call, f),
        _ => {}
    }
}

fn node<'p>(literal: &'p NodeLiteral, f: &mut dyn FnMut(Found<'p>)) {
    for entry in &literal.entries {
        match entry {
            NodeEntry::Nodes { nodes, .. } => {
                for n in nodes {
                    node(n, f);
                }
            }
            NodeEntry::Traversal { head, lazy: true, mapping, .. } => {
                f(Found::Walk(head, mapping.as_ref()));
                if let Some(mapping) = mapping {
                    node(mapping, f);
                }
            }
            NodeEntry::Traversal { mapping: Some(mapping), .. } => node(mapping, f),
            _ => {}
        }
    }
}
