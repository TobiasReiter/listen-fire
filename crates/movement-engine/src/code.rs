//! What a program's bodies write, at any depth: the closures they bind to a
//! name, the node declarations they write. (Code a parked state carries
//! comes back from its own syntax tree, never from here: crate::resume.)

use movement_parser::ast::{
    ArmExpression, AwaitSource, CallArg, CallStatement, CallbackSubject, ClosureExpression, CombinatorExpression, NodeEntry, NodeLiteral, Program,
    RValue, Span, Statement, UntilCondition,
};
use serde_json::Value as Json;

use crate::js::Js;

/// A node a body writes.
pub(crate) enum Found<'p> {
    /// A closure bound to a name (`f = (…) => { … }`).
    Bound(&'p str, &'p ClosureExpression),
    /// A node declaration written in a body.
    Shape(&'p movement_parser::ast::ShapeDeclaration),
    /// A name bound to a call's value (`h = mk(2)`, `h = mk(a: 2)`), by
    /// the callee as written.
    CallBound(&'p str, &'p str),
}

/// The names of the node declarations a body writes, at any depth.
pub(crate) fn shapes_declared_in(body: &[Statement]) -> Vec<String> {
    let mut found = Vec::new();
    visit(body, &mut |node| {
        if let Found::Shape(shape) = node {
            found.push(shape.name.clone());
        }
    });
    found
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

/// Every name the program binds to a call's value, anywhere, with the
/// callee as written (`h = mk(2)`).
pub(crate) fn call_bound(program: &Program) -> Vec<(&str, &str)> {
    let mut found = Vec::new();
    visit(&program.statements, &mut |node| {
        if let Found::CallBound(name, callee) = node {
            found.push((name, callee));
        }
    });
    found
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
                match &assign.value {
                    RValue::Closure { closure: c } => f(Found::Bound(&assign.name, c)),
                    RValue::Call { call } => f(Found::CallBound(&assign.name, &call.callee)),
                    RValue::Construct { construct } => f(Found::CallBound(&assign.name, &construct.callee)),
                    _ => {}
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
            Statement::Shape(shape) => f(Found::Shape(shape)),
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
            if let Some(mapping) = &lazy.mapping {
                node(mapping, f);
            }
        }
        _ => {}
    }
}

fn closure<'p>(c: &'p ClosureExpression, f: &mut dyn FnMut(Found<'p>)) {
    visit(&c.body, f);
}

fn arm<'p>(a: &'p ArmExpression, f: &mut dyn FnMut(Found<'p>)) {
    if let ArmExpression::Closure { closure: c, .. } = a {
        closure(c, f);
    }
}

fn combinator<'p>(c: &'p CombinatorExpression, f: &mut dyn FnMut(Found<'p>)) {
    {
        for a in c.arms.written() {
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
            NodeEntry::Traversal { mapping: Some(mapping), .. } => node(mapping, f),
            _ => {}
        }
    }
}
