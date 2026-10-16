//! Code a park names by its place in the program: an AST path (crate::program
//! `in_file`), read back as the typed node it names in the pinned source.
//!
//! A path is a JSON Pointer through the program's tree as the parser writes
//! it, so this walks the typed AST by the same keys its serialized form has.
//! Through a nested call (language version 3) a path reads the call again
//! from its slot's text (`<slot>/nested/<start>-<end>/value`), as the run
//! that parked it read it.

use movement_parser::ast::{
    self, ArmExpression, AwaitSource, CallArg, CallStatement, CallbackSubject, ClosureExpression, CombinatorArms, CombinatorExpression,
    CollectionOpExpression, ExprSlot, LinkTarget, MatchExpression, MovementDeclaration, NodeEntry, NodeLiteral, PathHead, PathRoot, RValue,
    ShapeDeclaration, Span, Statement, UntilCondition, WriteExpression, WriteTarget,
};
use serde_json::Value as Json;

use crate::js::Js;

/// A state's `span` object, as the program's tree holds it.
pub(crate) fn span_json(value: &Js) -> Option<(Span, Json)> {
    let json = crate::env::json_of_js(value);
    let loc = |key: &str| -> Option<ast::Loc> {
        let at = json.get(key)?;
        Some(ast::Loc { line: at.get("line")?.as_u64()? as usize, col: at.get("col")?.as_u64()? as usize })
    };
    Some((Span { start: loc("start")?, end: loc("end")? }, json))
}

/// A span as a park writes it: `{start: {line, col}, end: {line, col}}`.
pub(crate) fn span_js(span: Span) -> Js {
    let loc = |at: ast::Loc| crate::env::object_of(vec![("line", Js::Number(at.line as f64)), ("col", Js::Number(at.col as f64))]);
    crate::env::object_of(vec![("start", loc(span.start)), ("end", loc(span.end))])
}

/// The code at a path: each kind a park names by its place.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum CodeAt {
    Closure(ClosureExpression),
    /// A movement read as a value (language version 5).
    Movement(MovementDeclaration),
    Head(PathHead),
    Literal(NodeLiteral),
    Shape(ShapeDeclaration),
}

impl CodeAt {
    /// A closure's code, or the closure a movement read as a value is: its
    /// parameters and body.
    pub(crate) fn closure(self) -> Option<ClosureExpression> {
        match self {
            CodeAt::Closure(closure) => Some(closure),
            CodeAt::Movement(declaration) => {
                Some(ClosureExpression { params: declaration.params, return_type: None, body: declaration.body, span: declaration.span })
            }
            _ => None,
        }
    }
}

/// The code at `path` (within one file) in `program`, parsed under
/// `version`.
pub(crate) fn code_at(program: &ast::Program, path: &str, version: u32) -> Option<CodeAt> {
    let steps: Vec<String> = path.strip_prefix('/')?.split('/').map(|t| t.replace("~1", "/").replace("~0", "~")).collect();
    let steps: Vec<&str> = steps.iter().map(String::as_str).collect();
    let walk = Walk { version };
    match steps.as_slice() {
        ["statements", rest @ ..] => walk.statements(&program.statements, rest),
        _ => None,
    }
}

struct Walk {
    version: u32,
}

impl Walk {
    fn statements(&self, list: &[Statement], steps: &[&str]) -> Option<CodeAt> {
        let (index, rest) = steps.split_first()?;
        self.statement(list.get(index.parse::<usize>().ok()?)?, rest)
    }

    fn statement(&self, statement: &Statement, steps: &[&str]) -> Option<CodeAt> {
        let Some((step, rest)) = steps.split_first() else {
            return match statement {
                Statement::Shape(shape) => Some(CodeAt::Shape(shape.clone())),
                Statement::Movement(movement) => Some(CodeAt::Movement(movement.clone())),
                _ => None,
            };
        };
        match (statement, *step) {
            (Statement::Assign(assign), "value") => self.rvalue(&assign.value, rest),
            (Statement::Return(ret), "value") => self.rvalue(&ret.value, rest),
            (Statement::Movement(movement), "body") => self.statements(&movement.body, rest),
            (Statement::Write(write), "write") => self.write(&write.write, rest),
            (Statement::Match(statement), "match") => self.match_expression(&statement.r#match, rest),
            (Statement::Call(call), _) => self.call(call, steps),
            (Statement::Block(block), "block") => self.block(&block.block.head, &block.block.body, rest),
            (Statement::Link(link), "link") => self.link(&link.link.to, rest),
            (Statement::If(statement), "arms") => {
                let (index, rest) = rest.split_first()?;
                let arm = statement.arms.get(index.parse::<usize>().ok()?)?;
                match rest.split_first()? {
                    (&"condition", rest) => self.slot(&arm.condition, rest),
                    (&"body", rest) => self.statements(&arm.body, rest),
                    _ => None,
                }
            }
            (Statement::If(statement), "elseArm") => match rest.split_first()? {
                (&"body", rest) => self.statements(&statement.else_arm.as_ref()?.body, rest),
                _ => None,
            },
            (Statement::Await(statement), "await") => self.await_source(&statement.r#await.source, rest.strip_prefix(&["source"])?),
            (Statement::Combinator(statement), "combinator") => self.combinator(&statement.combinator, rest),
            (Statement::Collection(statement), "collection") => self.collection(&statement.collection, rest),
            (Statement::Error(statement), "message") => self.slot(&statement.message, rest),
            (Statement::Listen(listen), "config") => self.named_args(&listen.config, rest),
            (Statement::Listen(listen), "construct") => self.named_args(&listen.construct.as_ref()?.args, rest.strip_prefix(&["args"])?),
            _ => None,
        }
    }

    fn rvalue(&self, value: &RValue, steps: &[&str]) -> Option<CodeAt> {
        let (step, rest) = steps.split_first()?;
        match (value, *step) {
            (RValue::Construct { construct }, "construct") => self.named_args(&construct.args, rest.strip_prefix(&["args"])?),
            (RValue::Call { call }, "call") => self.call(call, rest),
            (RValue::Write { write }, "write") => self.write(write, rest),
            (RValue::Match { r#match }, "match") => self.match_expression(r#match, rest),
            (RValue::Link { link }, "link") => self.link(&link.to, rest),
            (RValue::ExtractCall { extract_call }, "extractCall") => match rest.split_first()? {
                (&"content", rest) => self.slot(&extract_call.content, rest),
                (&"config", rest) => self.slot(extract_call.config.as_ref()?, rest),
                _ => None,
            },
            (RValue::Block { block }, "block") => self.block(&block.head, &block.body, rest),
            (RValue::Await { r#await }, "await") => self.await_source(&r#await.source, rest.strip_prefix(&["source"])?),
            (RValue::Combinator { combinator }, "combinator") => self.combinator(combinator, rest),
            (RValue::Collection { collection }, "collection") => self.collection(collection, rest),
            (RValue::InlineBlock { inline_block }, "inlineBlock") => self.statements(&inline_block.body, rest.strip_prefix(&["body"])?),
            (RValue::Callback { callback }, "callback") => match rest.split_first()? {
                (&"subject", rest) => match &callback.subject {
                    CallbackSubject::Inline { closure, .. } => self.closure(closure, rest.strip_prefix(&["closure"])?),
                    CallbackSubject::Named { args, .. } => self.call_args(args, rest.strip_prefix(&["args"])?),
                },
                (&"config", rest) => self.named_args(&callback.config, rest),
                _ => None,
            },
            (RValue::Closure { closure }, "closure") => self.closure(closure, rest),
            (RValue::Node { node }, "node") => self.literal(node, rest),
            (RValue::Lazy { lazy }, "lazy") => match rest.split_first()? {
                (&"head", rest) => self.head(&lazy.head, rest),
                (&"mapping", rest) => self.literal(lazy.mapping.as_ref()?, rest),
                _ => None,
            },
            (RValue::Expr { expr }, "expr") => self.slot(expr, rest),
            _ => None,
        }
    }

    fn closure(&self, closure: &ClosureExpression, steps: &[&str]) -> Option<CodeAt> {
        match steps.split_first() {
            None => Some(CodeAt::Closure(closure.clone())),
            Some((&"body", rest)) => self.statements(&closure.body, rest),
            Some(_) => None,
        }
    }

    fn call(&self, call: &CallStatement, steps: &[&str]) -> Option<CodeAt> {
        match steps.split_first()? {
            (&"args", rest) => self.call_args(&call.args, rest),
            (&"expression", rest) => self.slot(call.expression.as_ref()?, rest),
            _ => None,
        }
    }

    fn call_args(&self, args: &[CallArg], steps: &[&str]) -> Option<CodeAt> {
        let (index, rest) = steps.split_first()?;
        let (step, rest) = rest.split_first()?;
        match (args.get(index.parse::<usize>().ok()?)?, *step) {
            (CallArg::Expr { expr, .. }, "expr") => self.slot(expr, rest),
            (CallArg::Write { write, .. }, "write") => self.write(write, rest),
            (CallArg::Node { node, .. }, "node") => self.literal(node, rest),
            (CallArg::Call { call, .. }, "call") => self.call(call, rest),
            (CallArg::Closure { closure, .. }, "closure") => self.closure(closure, rest),
            _ => None,
        }
    }

    fn named_args(&self, args: &[ast::NamedArg], steps: &[&str]) -> Option<CodeAt> {
        let (index, rest) = steps.split_first()?;
        self.slot(&args.get(index.parse::<usize>().ok()?)?.value, rest.strip_prefix(&["value"])?)
    }

    fn write(&self, write: &WriteExpression, steps: &[&str]) -> Option<CodeAt> {
        match steps.split_first()? {
            (&"target", rest) => self.target(&write.target, rest),
            (&"uniqueBy", rest) => self.unique_by(&write.unique_by, rest),
            (&"fields", rest) => self.fields(&write.fields, rest),
            _ => None,
        }
    }

    fn match_expression(&self, expression: &MatchExpression, steps: &[&str]) -> Option<CodeAt> {
        match steps.split_first()? {
            (&"target", rest) => self.target(&expression.target, rest),
            (&"uniqueBy", rest) => self.unique_by(&expression.unique_by, rest),
            (&"fields", rest) => self.fields(&expression.fields, rest),
            _ => None,
        }
    }

    fn target(&self, target: &WriteTarget, steps: &[&str]) -> Option<CodeAt> {
        let (step, rest) = steps.split_first()?;
        match (target, *step) {
            (WriteTarget::Linked { path, .. }, "path") => self.head(path, rest),
            (WriteTarget::Tuple { paths, .. }, "paths") => {
                let (index, rest) = rest.split_first()?;
                self.head(paths.get(index.parse::<usize>().ok()?)?, rest)
            }
            (WriteTarget::Position { root, .. }, "root") => self.root(root, rest),
            _ => None,
        }
    }

    fn unique_by(&self, clauses: &[ast::UniqueClause], steps: &[&str]) -> Option<CodeAt> {
        let (index, rest) = steps.split_first()?;
        self.slot(&clauses.get(index.parse::<usize>().ok()?)?.predicate, rest.strip_prefix(&["predicate"])?)
    }

    fn fields(&self, fields: &[ast::FieldEntry], steps: &[&str]) -> Option<CodeAt> {
        let (index, rest) = steps.split_first()?;
        self.slot(&fields.get(index.parse::<usize>().ok()?)?.value, rest.strip_prefix(&["value"])?)
    }

    fn link(&self, to: &LinkTarget, steps: &[&str]) -> Option<CodeAt> {
        match (to, steps.split_first()?) {
            (LinkTarget::Match { r#match, .. }, (&"to", rest)) => self.match_expression(r#match, rest.strip_prefix(&["match"])?),
            _ => None,
        }
    }

    fn block(&self, head: &PathHead, body: &[Statement], steps: &[&str]) -> Option<CodeAt> {
        match steps.split_first()? {
            (&"head", rest) => self.head(head, rest),
            (&"body", rest) => self.statements(body, rest),
            _ => None,
        }
    }

    fn head(&self, head: &PathHead, steps: &[&str]) -> Option<CodeAt> {
        match steps.split_first() {
            None => Some(CodeAt::Head(head.clone())),
            Some((&"root", rest)) => self.root(head.root.as_ref()?, rest),
            Some(_) => None,
        }
    }

    fn root(&self, root: &PathRoot, steps: &[&str]) -> Option<CodeAt> {
        match (root, steps.split_first()?) {
            (PathRoot::Expression { expr }, (&"expr", rest)) => self.slot(expr, rest),
            _ => None,
        }
    }

    fn await_source(&self, source: &AwaitSource, steps: &[&str]) -> Option<CodeAt> {
        let (step, rest) = steps.split_first()?;
        match (source, *step) {
            (AwaitSource::Traversal { head, .. } | AwaitSource::First { head, .. }, "head") => self.head(head, rest),
            (AwaitSource::Combinator { combinator, .. }, "combinator") => self.combinator(combinator, rest),
            (AwaitSource::Until { condition, .. }, "condition") => match (condition, rest.split_first()?) {
                (UntilCondition::Closure { closure }, (&"closure", rest)) => self.closure(closure, rest),
                (UntilCondition::Expr { expr }, (&"expr", rest)) => self.slot(expr, rest),
                _ => None,
            },
            _ => None,
        }
    }

    fn combinator(&self, combinator: &CombinatorExpression, steps: &[&str]) -> Option<CodeAt> {
        match steps.split_first()? {
            (&"settings", rest) => self.slot(combinator.settings.as_ref()?, rest),
            (&"arms", rest) => match (&combinator.arms, rest.split_first()?) {
                (CombinatorArms::Literal { arms, .. } | CombinatorArms::Arguments { arms, .. }, (&"arms", rest)) => {
                    let (index, rest) = rest.split_first()?;
                    self.arm(arms.get(index.parse::<usize>().ok()?)?, rest)
                }
                (CombinatorArms::Dynamic { expr, .. }, (&"expr", rest)) => self.slot(expr, rest),
                _ => None,
            },
            _ => None,
        }
    }

    fn arm(&self, arm: &ArmExpression, steps: &[&str]) -> Option<CodeAt> {
        match (arm, steps.split_first()?) {
            (ArmExpression::Closure { closure, .. }, (&"closure", rest)) => self.closure(closure, rest),
            _ => None,
        }
    }

    fn collection(&self, collection: &CollectionOpExpression, steps: &[&str]) -> Option<CodeAt> {
        match steps.split_first()? {
            (&"source", rest) => self.slot(&collection.source, rest),
            (&"init", rest) => self.slot(collection.init.as_ref()?, rest),
            (&"config", rest) => self.slot(collection.config.as_ref()?, rest),
            (&"fn", rest) => self.arm(&collection.r#fn, rest),
            _ => None,
        }
    }

    fn literal(&self, literal: &NodeLiteral, steps: &[&str]) -> Option<CodeAt> {
        let Some((step, rest)) = steps.split_first() else { return Some(CodeAt::Literal(literal.clone())) };
        if *step != "entries" {
            return None;
        }
        let (index, rest) = rest.split_first()?;
        let (step, rest) = rest.split_first()?;
        match (literal.entries.get(index.parse::<usize>().ok()?)?, *step) {
            (NodeEntry::Value { value, .. }, "value") => self.slot(value, rest),
            (NodeEntry::Nodes { nodes, .. }, "nodes") => {
                let (index, rest) = rest.split_first()?;
                self.literal(nodes.get(index.parse::<usize>().ok()?)?, rest)
            }
            (NodeEntry::Traversal { head, .. }, "head") => self.head(head, rest),
            (NodeEntry::Traversal { mapping, .. }, "mapping") => self.literal(mapping.as_ref()?, rest),
            _ => None,
        }
    }

    /// A call nested in the slot's text, read as its statement read it.
    fn slot(&self, slot: &ExprSlot, steps: &[&str]) -> Option<CodeAt> {
        let ["nested", extent, "value", rest @ ..] = steps else { return None };
        let (start, end) = extent.split_once('-')?;
        let at = movement_parser::tree::At { start: start.parse().ok()?, end: end.parse().ok()? };
        let value = crate::nested::nested_call(slot, at, self.version).ok()?;
        self.rvalue(&value, rest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every piece of code a park can name, at every place the corpus
    /// writes one (nested calls read too), reads back as the node the tree
    /// holds there.
    #[test]
    fn every_code_node_in_the_corpus_reads_back_by_its_path() {
        let fixture = concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/movement-lang/parser/__test__/__fixtures__/programs.json");
        let text = std::fs::read_to_string(fixture).unwrap();
        let mut found = std::collections::BTreeMap::<&'static str, usize>::new();
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let record: Json = serde_json::from_str(line).unwrap();
            let (Some(source), Some(version)) = (record["source"].as_str(), record["version"].as_u64()) else { continue };
            let version = version as u32;
            let Ok(program) = movement_parser::stmt::parse_program(source, version, false) else { continue };
            let tree = serde_json::to_value(&program).unwrap();
            check(&program, &tree, "", version, 0, &mut found);
        }
        for kind in ["closure", "movement", "head", "literal", "shape", "nested"] {
            assert!(found.get(kind).copied().unwrap_or(0) > 0, "the corpus reaches no {kind}: {found:?}");
        }
    }

    fn kind_of(node: &Json, path: &str) -> Option<&'static str> {
        let object = node.as_object()?;
        let last = path.rsplit('/').next().unwrap_or("");
        match object.get("kind").and_then(Json::as_str) {
            Some("shape") if object.contains_key("root") && !path.ends_with("declaration") => return Some("shape"),
            Some("movement") if object.contains_key("body") => return Some("movement"),
            _ => {}
        }
        if object.contains_key("params") && object.contains_key("body") && !object.contains_key("kind") {
            return Some("closure");
        }
        if object.contains_key("hopsRaw") && (last == "head" || last == "path" || path.contains("/paths/")) {
            return Some("head");
        }
        if object.contains_key("entries") && object.contains_key("span") {
            return Some("literal");
        }
        None
    }

    /// `depth`: the nested calls read so far. A call's own `expression` slot
    /// holds its whole text, which reads as the same call again, so the walk
    /// stops two reads deep.
    fn check(program: &ast::Program, node: &Json, path: &str, version: u32, depth: usize, found: &mut std::collections::BTreeMap<&'static str, usize>) {
        if let Some(kind) = kind_of(node, path) {
            let code = code_at(program, path, version).unwrap_or_else(|| panic!("no {kind} at {path}"));
            let written = match code {
                CodeAt::Closure(c) => serde_json::to_value(c),
                CodeAt::Movement(m) => serde_json::to_value(m),
                CodeAt::Head(h) => serde_json::to_value(h),
                CodeAt::Literal(l) => serde_json::to_value(l),
                CodeAt::Shape(s) => serde_json::to_value(s),
            }
            .unwrap();
            assert_eq!(&written, node, "the {kind} at {path}");
            *found.entry(kind).or_default() += 1;
        }
        if let Some(slot) = crate::program::slot_of(node) {
            if depth == 2 {
                return;
            }
            let Ok(tree) = movement_parser::expr::parse_expression(&slot.raw) else { return };
            for at in crate::nested::staged_calls(&tree, &|_| true) {
                let Ok(value) = crate::nested::nested_call(&slot, at, version) else { continue };
                *found.entry("nested").or_default() += 1;
                let value = serde_json::to_value(&value).unwrap();
                check(program, &value, &format!("{path}/nested/{}-{}/value", at.start, at.end), version, depth + 1, found);
            }
            return;
        }
        match node {
            Json::Object(object) => {
                for (key, child) in object {
                    check(program, child, &format!("{path}/{}", key.replace('~', "~0").replace('/', "~1")), version, depth, found);
                }
            }
            Json::Array(items) => {
                for (index, child) in items.iter().enumerate() {
                    check(program, child, &format!("{path}/{index}"), version, depth, found);
                }
            }
            _ => {}
        }
    }
}
