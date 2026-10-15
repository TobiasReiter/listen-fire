//! The nodes family: node declarations (`node Entry { … }`, `extends`,
//! borrowed field types), node and graph literals, links onto a node this
//! run built, and a declared node as a parameter's type. Codes (PORT.md has
//! where the TypeScript raises each):
//!
//! - MOV_BORROW_MALFORMED, MOV_BORROW_UNKNOWN_FIELD, MOV_BORROW_UNKNOWN_GRAPH,
//!   MOV_BORROW_UNKNOWN_ROOT, MOV_UNKNOWN_TYPE_NAME (`resolveNamedType`)
//! - MOV_EXTENDS_CYCLE, MOV_EXTENDS_NOT_A_NODE, MOV_EXTENDS_REDEFINES
//! - MOV_SHAPE_FIELD_PROTO
//! - MOV_NODE_ENTRY_DUPLICATE, MOV_NODE_ENTRY_NODE_VALUE, MOV_NODE_ENTRY_TYPE,
//!   MOV_NODE_LANDING_MISMATCH
//! - MOV_NODE_LINK_BODY, MOV_NODE_LINK_SHAPE, MOV_NODE_EDGE_UNDECLARED,
//!   MOV_NODE_EDGE_DEFERRED
//! - MOV_NODE_ARG_SHAPE
//! - MOV_GRAPH_* (graph literals), MOV_MEMBERS_NOT_CLOSED

use std::collections::HashMap;

use movement_parser::ast::{ShapeDeclaration, ShapeNode, Span};
use movement_parser::catalog::types::{InstanceSchema, SchemaFieldType};

use crate::checker::Checker;
use crate::codes;
use crate::scope::{Resolution, ScopeId, SymbolId, SymbolKind};
use crate::types::declared::{declared_instance, inherit_declaration, inherit_schema, schema_maybe_absent, schema_type_of, shape_to_schema};
use crate::types::position::InstanceRef;

/// A node declaration as its uses read it: the instance its schema stands
/// for (the root is the position keyed by its name), and the declaration
/// with any base folded in.
#[derive(Clone)]
pub struct Declared {
    pub instance: InstanceRef,
    pub declaration: ShapeDeclaration,
}

/// What the nodes family remembers across the file.
#[derive(Default)]
pub struct NodeState {
    /// Each node declaration's symbol, by what it declares (`ScopeSymbol.schema`
    /// and `.declaration`). An imported one carries the library's.
    declared: HashMap<SymbolId, Declared>,
    /// The declarations this file wrote, with the scope each was declared in
    /// (`localShapes`).
    local: HashMap<SymbolId, (ShapeDeclaration, ScopeId)>,
    /// Declarations settled at their statement, by where they are written.
    settled: Vec<Span>,
}

impl NodeState {
    /// An imported symbol stands for the library's declaration.
    pub fn adopt(&mut self, local: SymbolId, library: SymbolId) {
        if let Some(declared) = self.declared.get(&library).cloned() {
            self.declared.insert(local, declared);
        }
    }

    pub fn declared(&self, symbol: SymbolId) -> Option<&Declared> {
        self.declared.get(&symbol)
    }

    /// `declaredShapeTokens`: a declaration this file wrote (not an imported one).
    pub fn is_local(&self, symbol: SymbolId) -> bool {
        self.local.contains_key(&symbol)
    }
}

/// Why an annotation names no type: a report, or a name that did not resolve.
pub enum TypeNameRefusal {
    Report(&'static str, String),
    Resolution(Resolution),
}

pub const PRIMITIVE_TYPE_NAMES: &[&str] = &["text", "number", "boolean", "date", "datetime", "file", "json"];

impl Checker<'_> {
    /// The node declaration `symbol` is, when it is one.
    pub fn declared_node(&self, symbol: SymbolId) -> Option<&Declared> {
        (self.scopes.symbol(symbol).kind == SymbolKind::Shape).then(|| self.nodes.declared(symbol)).flatten()
    }

    /// `declaredTypeIn`, as a schema spells it.
    fn declared_schema_type_in(&self, name: &str, scope: ScopeId) -> Option<SchemaFieldType> {
        self.declared_type_in(name, scope).as_ref().and_then(schema_type_of)
    }

    fn schema_of_shape(&self, shape: &ShapeDeclaration, scope: ScopeId) -> InstanceSchema {
        shape_to_schema(shape, &|name| self.declared_schema_type_in(name, scope))
    }

    /// The hoist half of a node declaration: its schema as written, so a use
    /// checked before its statement already reads it. `fresh` when this
    /// statement bound the name (not a duplicate).
    pub fn declare_shape(&mut self, scope: ScopeId, shape: &ShapeDeclaration, fresh: bool) {
        let Some(id) = self.scopes.scope(scope).symbols.get(&shape.name).copied() else { return };
        if self.scopes.symbol(id).kind != SymbolKind::Shape {
            return;
        }
        let schema = self.schema_of_shape(shape, scope);
        self.nodes.declared.insert(id, Declared { instance: declared_instance(&shape.name, schema, id), declaration: shape.clone() });
        if fresh {
            self.nodes.local.insert(id, (shape.clone(), scope));
        }
    }

    /// The node declaration `shape` extends, when its base names one in
    /// scope — with its statement when this file declared it (`extendsTarget`).
    fn extends_target(&self, shape: &ShapeDeclaration, scope: ScopeId) -> Option<(SymbolId, Option<(ShapeDeclaration, ScopeId)>)> {
        let base = shape.extends.as_ref()?;
        let Resolution::Found(id) = self.scopes.resolve(scope, &base.name) else { return None };
        if self.scopes.symbol(id).kind != SymbolKind::Shape {
            return None;
        }
        Some((id, self.nodes.local.get(&id).cloned()))
    }

    /// `extendsCycle`: the names around an `extends` cycle `shape` sits on.
    fn extends_cycle(&self, shape: &ShapeDeclaration, scope: ScopeId) -> Option<Vec<String>> {
        let mut path = vec![shape.name.clone()];
        let mut seen = vec![shape.span];
        let mut current = (shape.clone(), scope);
        loop {
            let (_, local) = self.extends_target(&current.0, current.1)?;
            let next = local?;
            path.push(next.0.name.clone());
            if next.0.span == shape.span && next.0.name == shape.name {
                return Some(path);
            }
            if seen.contains(&next.0.span) {
                return None;
            }
            seen.push(next.0.span);
            current = next;
        }
    }

    /// `hoistDeclarations`' last pass: each `extends` folded in as early as it
    /// can be known (`inheritAtHoist`), reporting nothing.
    pub fn inherit_at_hoist(&mut self, shape: &ShapeDeclaration, scope: ScopeId, visited: &mut Vec<Span>) {
        if shape.extends.is_none() || visited.contains(&shape.span) {
            return;
        }
        visited.push(shape.span);
        if self.extends_cycle(shape, scope).is_some() {
            return;
        }
        let Some((base, local)) = self.extends_target(shape, scope) else { return };
        let Some((base_shape, base_scope)) = local else { return };
        self.inherit_at_hoist(&base_shape, base_scope, visited);
        let Some(id) = self.scopes.scope(scope).symbols.get(&shape.name).copied() else { return };
        if self.nodes.local.get(&id).is_none_or(|(s, _)| s.span != shape.span) {
            return;
        }
        let own = self.schema_of_shape(shape, scope);
        self.adopt_inheritance(id, shape, base, own);
    }

    /// X takes the whole tree: its own schema with the base's folded in.
    fn adopt_inheritance(&mut self, symbol: SymbolId, shape: &ShapeDeclaration, base: SymbolId, own: InstanceSchema) {
        let Some(base) = self.nodes.declared.get(&base).cloned() else { return };
        let schema = inherit_schema(&own, &shape.name, &base.declaration.name, &base.instance.schema);
        let declaration = inherit_declaration(shape, &base.declaration);
        self.nodes.declared.insert(symbol, Declared { instance: declared_instance(&shape.name, schema, symbol), declaration });
    }

    /// `settleShape`: a node declaration at its own statement — its field
    /// types resolved here (a borrowed one's graph is bound by now), its words
    /// checked, and an `extends` resolved and refused where it is wrong.
    pub fn settle_shape(&mut self, shape: &ShapeDeclaration, scope: ScopeId) {
        if self.nodes.settled.contains(&shape.span) {
            return;
        }
        self.nodes.settled.push(shape.span);
        let symbol = self
            .scopes
            .scope(scope)
            .symbols
            .get(&shape.name)
            .copied()
            .filter(|id| self.scopes.symbol(*id).kind == SymbolKind::Shape && self.nodes.local.get(id).is_some_and(|(s, _)| s.span == shape.span));
        if shape.extends.is_none() {
            if let Some(id) = symbol
                && let Some(declared) = self.nodes.declared.get(&id).cloned()
            {
                let mut schema = (*declared.instance.schema).clone();
                self.resolve_shape_field_types(&shape.root, &shape.name, &mut schema, scope);
                self.nodes.declared.insert(id, Declared { instance: declared_instance(&shape.name, schema, id), declaration: declared.declaration });
            }
            self.check_shape_descriptions(&shape.root, scope);
            return;
        }
        let mut own = self.schema_of_shape(shape, scope);
        self.resolve_shape_field_types(&shape.root, &shape.name, &mut own, scope);
        self.check_shape_descriptions(&shape.root, scope);
        let Some(base) = self.settled_base(shape, scope) else {
            if let Some(id) = symbol {
                self.nodes.declared.insert(id, Declared { instance: declared_instance(&shape.name, own, id), declaration: shape.clone() });
            }
            return;
        };
        let Some(base_declaration) = self.nodes.declared.get(&base).map(|d| d.declaration.clone()) else {
            if let Some(id) = symbol {
                self.nodes.declared.insert(id, Declared { instance: declared_instance(&shape.name, own, id), declaration: shape.clone() });
            }
            return;
        };
        self.refuse_redefinitions(shape, &base_declaration);
        if let Some(id) = symbol {
            self.adopt_inheritance(id, shape, base, own);
        }
    }

    /// `settledBase`: the base `shape` extends, settled — or `None`, reported.
    fn settled_base(&mut self, shape: &ShapeDeclaration, scope: ScopeId) -> Option<SymbolId> {
        let base = shape.extends.as_ref()?;
        let id = match self.scopes.resolve(scope, &base.name) {
            Resolution::Found(id) => id,
            failure => {
                self.report_resolution_failure(&base.name, base.span, failure);
                return None;
            }
        };
        let kind = self.scopes.symbol(id).kind;
        if kind != SymbolKind::Shape {
            self.report(
                codes::EXTENDS_NOT_A_NODE,
                format!(
                    "'{}' is {}, not a node declaration — '{}' extends a node declared with 'node {} {{ … }}', in this file or imported",
                    base.name,
                    kind.describe(),
                    shape.name,
                    base.name
                ),
                base.span,
            );
            return None;
        }
        if let Some(cycle) = self.extends_cycle(shape, scope) {
            let message = if cycle.len() == 2 {
                format!("'{}' extends itself — a node declaration extends a different one", shape.name)
            } else {
                let through: Vec<String> = cycle[1..cycle.len() - 1].iter().map(|n| format!("'{n}'")).collect();
                format!(
                    "'{}' extends itself through {} ({}) — one of them has to stand on its own",
                    shape.name,
                    through.join(", "),
                    cycle.join(" extends ")
                )
            };
            self.report(codes::EXTENDS_CYCLE, message, base.span);
            return None;
        }
        if let Some((local, local_scope)) = self.nodes.local.get(&id).cloned() {
            self.settle_shape(&local, local_scope);
        }
        Some(id)
    }

    /// `refuseRedefinitions`: X inherits its base's members whole.
    fn refuse_redefinitions(&mut self, shape: &ShapeDeclaration, base: &ShapeDeclaration) {
        let base_name = shape.extends.as_ref().map_or(base.name.as_str(), |e| e.name.as_str()).to_string();
        for field in &shape.root.fields {
            if !base.root.fields.iter().any(|f| f.name == field.name) {
                continue;
            }
            self.report(
                codes::EXTENDS_REDEFINES,
                format!(
                    "'{}' is already a field of '{base_name}' — '{}' inherits it, with its type and its words, and cannot redefine it; a field of its own needs a name '{base_name}' does not use",
                    field.name, shape.name
                ),
                field.span,
            );
        }
        for child in &shape.root.children {
            if !base.root.children.iter().any(|c| c.name == child.name) {
                continue;
            }
            self.report(
                codes::EXTENDS_REDEFINES,
                format!(
                    "'{}' is already a nested node of '{base_name}' — '{}' inherits it whole, with its fields, its words and its order, and cannot restate it; a nested node of its own needs a name '{base_name}' does not use",
                    child.name, shape.name
                ),
                child.span,
            );
        }
    }

    /// `resolveShapeFieldTypes`: each field's annotation resolved where the
    /// declaration is written, patching the schema. Version 1 resolved only
    /// borrowed paths here.
    fn resolve_shape_field_types(&mut self, node: &ShapeNode, key: &str, schema: &mut InstanceSchema, scope: ScopeId) {
        let mut refusals = Vec::new();
        self.apply_shape_field_types(node, key, schema, scope, &mut refusals);
        for (refusal, span, written) in refusals {
            match refusal {
                TypeNameRefusal::Report(code, message) => self.report(code, message, span),
                TypeNameRefusal::Resolution(failure) => {
                    let graph = written.split('.').next().unwrap_or(&written).to_string();
                    self.report_resolution_failure(&graph, span, failure);
                }
            }
        }
    }

    /// `resolveShapeFieldTypes`' reading: each field's annotation resolved
    /// into the schema, and the ones that name no type collected in order.
    fn apply_shape_field_types(&self, node: &ShapeNode, key: &str, schema: &mut InstanceSchema, scope: ScopeId, refusals: &mut Vec<(TypeNameRefusal, Span, String)>) {
        for field in &node.fields {
            if self.version < 2 && !field.type_.contains('.') {
                continue;
            }
            let resolved = match self.named_type(&field.type_, scope) {
                Ok(Some(resolved)) => resolved,
                Ok(None) => continue,
                Err(refusal) => {
                    refusals.push((refusal, field.span, field.type_.clone()));
                    continue;
                }
            };
            if let Some(position) = schema.positions.get_mut(key) {
                let resolved = if field.nullable == Some(true) { schema_maybe_absent(resolved) } else { resolved };
                position.properties.insert(field.name.clone(), resolved.clone());
                if let Some(root) = schema.writable_roots.get_mut(key) {
                    root.fields.insert(field.name.clone(), resolved.clone());
                    root.result_shape.insert(field.name.clone(), resolved);
                }
            }
        }
        for child in &node.children {
            self.apply_shape_field_types(child, &format!("{key}.{}", child.name), schema, scope, refusals);
        }
    }

    /// A declaration written in place (`extract(content, node X { … })`), as
    /// its statement would settle it, for typing alone.
    pub fn settled_schema_of(&self, shape: &ShapeDeclaration, scope: ScopeId) -> InstanceSchema {
        let mut schema = self.schema_of_shape(shape, scope);
        self.apply_shape_field_types(&shape.root, &shape.name, &mut schema, scope, &mut Vec::new());
        schema
    }

    /// The schema a graph symbol carries: an instance's, or a node declaration's.
    pub fn graph_schema(&self, symbol: SymbolId) -> Option<std::rc::Rc<InstanceSchema>> {
        let s = self.scopes.symbol(symbol);
        match s.kind {
            SymbolKind::Shape => self.nodes.declared(symbol).map(|d| d.instance.schema.clone()),
            SymbolKind::Instance => match &s.types.pos {
                Some(crate::types::Position::Meta { instance }) => Some(instance.schema.clone()),
                _ => None,
            },
            _ => None,
        }
    }

    /// `resolveNamedType`: an annotation — a primitive, a refinement the
    /// program declares, or a borrowed `<instance>.<root>.<field>` path —
    /// reporting what it names that is none of them.
    pub fn resolve_named_type(&mut self, written: &str, span: Span, scope: ScopeId) -> Option<SchemaFieldType> {
        match self.named_type(written, scope) {
            Ok(found) => found,
            Err(TypeNameRefusal::Resolution(failure)) => {
                let graph = written.split('.').next().unwrap_or(written).to_string();
                self.report_resolution_failure(&graph, span, failure);
                None
            }
            Err(TypeNameRefusal::Report(code, message)) => {
                self.report(code, message, span);
                None
            }
        }
    }

    /// `resolveNamedType`'s reading, reporting nothing: `Ok(None)` for a graph
    /// in scope whose schema is not known (it stays silent).
    pub fn named_type(&self, written: &str, scope: ScopeId) -> Result<Option<SchemaFieldType>, TypeNameRefusal> {
        if !written.contains('.') {
            if let Some(primitive) = movement_parser::catalog::helpers::parse_field_type_name(Some(written)) {
                return Ok(Some(primitive));
            }
            if let Some(declared) = self.declared_schema_type_in(written, scope) {
                return Ok(Some(declared));
            }
            let names = self.type_names_in_scope(scope);
            return Err(TypeNameRefusal::Report(
                codes::UNKNOWN_TYPE_NAME,
                format!(
                    "'{written}' is not a type — annotate with a primitive ({}), a type you declare (`type {written} = <\"A\" | \"B\">`), or another field's type by path (<crm-[:companies]->.`funding_stage`>){}",
                    PRIMITIVE_TYPE_NAMES.join(", "),
                    crate::meta::did_you_mean(written, &names)
                ),
            ));
        }
        let segments: Vec<&str> = written.split('.').collect();
        let [graph, root, field] = segments[..] else {
            return Err(TypeNameRefusal::Report(
                codes::BORROW_MALFORMED,
                format!(
                    "'{written}' is not a borrowable path — a borrowed type names another graph's field: an edge, then the field (e.g. <crm-[:companies]->.`funding_stage`>)"
                ),
            ));
        };
        let id = match self.scopes.resolve(scope, graph) {
            Resolution::Found(id) => id,
            Resolution::Unknown => {
                return Err(TypeNameRefusal::Report(
                    codes::BORROW_UNKNOWN_GRAPH,
                    format!("Unknown name '{graph}' in the borrowed type '{written}' — a borrowed type starts at a constructed instance, a declared node, or kg"),
                ));
            }
            failure => return Err(TypeNameRefusal::Resolution(failure)),
        };
        let kind = self.scopes.symbol(id).kind;
        if !matches!(kind, SymbolKind::Instance | SymbolKind::Shape) {
            return Err(TypeNameRefusal::Report(
                codes::BORROW_UNKNOWN_GRAPH,
                format!("'{graph}' is {} — a borrowed type starts at a constructed instance, a declared node, or kg", kind.describe()),
            ));
        }
        let Some(schema) = self.graph_schema(id) else { return Ok(None) };
        let readable = schema.positions.get(root).map(|p| &p.properties);
        let writable = schema.writable_roots.get(root).map(|r| &r.fields);
        if readable.is_none() && writable.is_none() {
            let mut available: Vec<&String> = schema.writable_roots.keys().collect();
            for key in schema.positions.keys() {
                if !available.contains(&key) {
                    available.push(key);
                }
            }
            let listed = if available.is_empty() { String::new() } else { format!(" — it has: {}", available.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")) };
            return Err(TypeNameRefusal::Report(codes::BORROW_UNKNOWN_ROOT, format!("'{graph}' has no '{root}' to borrow from{listed}")));
        }
        let mut fields: Vec<(&String, &SchemaFieldType)> = readable.into_iter().flat_map(|p| p.iter()).collect();
        for (name, ty) in writable.into_iter().flat_map(|w| w.iter()) {
            match fields.iter_mut().find(|(n, _)| *n == name) {
                Some(slot) => slot.1 = ty,
                None => fields.push((name, ty)),
            }
        }
        if let Some((_, ty)) = fields.iter().find(|(n, _)| n.as_str() == field) {
            return Ok(Some((*ty).clone()));
        }
        let listed = if fields.is_empty() { String::new() } else { format!(" — it has: {}", fields.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>().join(", ")) };
        Err(TypeNameRefusal::Report(codes::BORROW_UNKNOWN_FIELD, format!("'{graph}.{root}' has no field '{field}'{listed}")))
    }

    /// An annotation's type, for typing alone (nothing reported).
    pub fn annotation_type(&self, written: &str, scope: ScopeId) -> Option<Ty> {
        self.named_type(written, scope).ok().flatten().map(|t| Ty::from_schema(&t))
    }

    /// `checkMembers`: `MEMBERS(<T>)` lists a closed set's values, in the
    /// order declared.
    pub fn check_members(&mut self, expr: &movement_parser::ast::MembersExpression, scope: ScopeId) -> Option<crate::types::Ty> {
        let ty = self.resolve_named_type(&expr.type_, expr.type_span, scope)?;
        let named = crate::types::Ty::from_schema(&ty);
        let named = crate::types::field::strip_absent(&named).clone();
        let crate::types::Ty::Enum { open, .. } = &named else {
            self.report(
                codes::MEMBERS_NOT_CLOSED,
                format!(
                    "'MEMBERS' lists the values of a closed set, and '{t}' is {} — there is nothing to list. Declare the set ('type {t} = <\"A\" | \"B\">'), or name a field whose options the system holds.",
                    crate::types::field::describe_field_type(&named),
                    t = expr.type_
                ),
                expr.type_span,
            );
            return None;
        };
        if open.is_some() {
            self.report(
                codes::MEMBERS_NOT_CLOSED,
                format!(
                    "'{}' is a known-values field: those options are the ones we could read, and other values are legal there too — so there is no complete list of them to walk. Declare the set you mean ('type Thesis = <\"A\" | \"B\">') and iterate that.",
                    expr.type_
                ),
                expr.type_span,
            );
            return None;
        }
        Some(crate::types::Ty::list(named))
    }

    /// `typeNamesInScope`: the primitives, then every `type` declared in scope.
    fn type_names_in_scope(&self, scope: ScopeId) -> Vec<String> {
        let mut names: Vec<String> = PRIMITIVE_TYPE_NAMES.iter().map(|s| s.to_string()).collect();
        for id in self.scopes.chain(scope) {
            for symbol in self.scopes.scope(id).symbols.values() {
                let symbol = self.scopes.symbol(*symbol);
                if symbol.kind == SymbolKind::Type && !names.contains(&symbol.name) {
                    names.push(symbol.name.clone());
                }
            }
        }
        names
    }

    /// `checkShapeDescriptions`: a declaration's names kept apart, and its
    /// words checked against the scope it is declared in.
    pub fn check_shape_descriptions(&mut self, node: &ShapeNode, scope: ScopeId) {
        self.check_field_child_names_apart(node.fields.iter().map(|f| f.name.as_str()), node.children.iter().map(|c| (c.name.as_str(), c.span)));
        self.check_no_prototype_name(node.fields.iter().map(|f| (f.name.as_str(), f.span)).chain(node.children.iter().map(|c| (c.name.as_str(), c.span))));
        if let Some(description) = &node.description {
            self.check_expr_slot(description, scope);
        }
        for field in &node.fields {
            if let Some(description) = &field.description {
                self.check_expr_slot(description, scope);
            }
        }
        for child in &node.children {
            self.check_shape_descriptions(child, scope);
        }
    }

    /// `checkFieldChildNamesApart`: a record's fields and child nodes share one namespace.
    pub fn check_field_child_names_apart<'n>(&mut self, fields: impl Iterator<Item = &'n str>, children: impl Iterator<Item = (&'n str, Span)>) {
        let fields: Vec<&str> = fields.collect();
        for (name, span) in children {
            if fields.contains(&name) {
                self.report(
                    codes::EXTRACT_FIELD_DUPLICATE,
                    format!("'{name}' is both a field and a child node here — a record's fields and its child nodes share one namespace, so give one of them another name"),
                    span,
                );
            }
        }
    }

    /// `checkNoPrototypeName`.
    pub fn check_no_prototype_name<'n>(&mut self, entries: impl Iterator<Item = (&'n str, Span)>) {
        for (name, span) in entries {
            if name == "__proto__" {
                self.report(
                    codes::SHAPE_FIELD_PROTO,
                    "'__proto__' cannot name a field or a node — JavaScript reads that key as the record's prototype, so the record would never hold it; give it another name",
                    span,
                );
            }
        }
    }

    /// `conformsToDeclaredNode`: does `position` of `instance` structurally
    /// satisfy the declaration? `None` when nobody could compare (an
    /// undescribed position, a declaration whose schema did not resolve).
    pub fn conforms_to_declared_node(&self, instance: &InstanceRef, position: &str, declaration: SymbolId) -> Option<bool> {
        let declared = self.declared_node(declaration)?;
        let schema = &declared.instance.schema;
        if crate::types::declared::surface_not_enumerated(schema.positions.get(&declared.instance.name)) {
            return None;
        }
        let surface = crate::types::declared::schema_surface(&instance.schema, position)?;
        Some(crate::types::declared::surface_misfit(Some(&surface), schema, &declared.instance.name, false).is_none())
    }

    /// `declaredRootPosition` of the declaration `symbol` names.
    pub fn declared_root(&self, symbol: SymbolId) -> Option<crate::types::Position> {
        self.declared_node(symbol).and_then(|d| crate::types::declared::declared_root_position(&d.instance))
    }
}

// ── Node literals ──

use indexmap::IndexMap;
use movement_parser::ast::{NodeEntry, NodeLiteral, TypeRef};
use movement_parser::lowering::expression::Expression;

use crate::types::Position;
use crate::types::declared::{describe_shape_node, run_built_landing, supplied_surface, surface_misfit};
use crate::types::field::{Ty, describe_field_type, field_type_equals};
use crate::types::position::{LocalEdge, LocalNode, describe_position, position_ref_in, positions_match};

/// A run-local edge's promise: readable, and nothing else; sequenced when its
/// author said in what order.
pub fn local_edge_schema(name: &str, sequenced: Option<movement_parser::catalog::types::EdgeSequencing>) -> movement_parser::catalog::types::EdgeSchema {
    let mut schema = crate::types::position::edge_schema_to(name);
    schema.readable = Some(true);
    schema.sequenced = sequenced;
    schema
}

fn written_sequencing(of: Option<&movement_parser::ast::EdgeSequencing>) -> Option<movement_parser::catalog::types::EdgeSequencing> {
    use movement_parser::ast::EdgeSequencing as Written;
    use movement_parser::catalog::types::EdgeSequencing as Schema;
    of.map(|s| match s {
        Written::Arrival => Schema::Arrival,
        Written::Document => Schema::Document,
        Written::Chronological => Schema::Chronological,
    })
}

pub fn local_edge(name: &str, target: Option<Position>) -> LocalEdge {
    LocalEdge { schema: local_edge_schema(name, None), target, structural: false, deferred: false, references: false }
}

/// `scalarLiteralType`: the type a literal entry value is written as.
fn scalar_literal_type(raw: &str) -> Option<Ty> {
    let t = raw.trim();
    match t.to_uppercase().as_str() {
        "TRUE" | "FALSE" => return Some(Ty::Boolean),
        "NULL" => return None,
        _ => {}
    }
    let digits = t.strip_prefix('-').unwrap_or(t);
    let (whole, fraction) = digits.split_once('.').map_or((digits, None), |(w, f)| (w, Some(f)));
    let is_digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if is_digits(whole) && fraction.is_none_or(is_digits) {
        return Some(Ty::Number);
    }
    let quoted = |q: char| t.len() >= 2 && t.starts_with(q) && t.ends_with(q) && {
        let inner = &t[1..t.len() - 1];
        let mut escaped = false;
        inner.chars().all(|c| {
            let ok = escaped || c != q;
            escaped = !escaped && c == '\\';
            ok
        }) && !escaped
    };
    (quoted('"') || quoted('\'')).then_some(Ty::Text)
}

/// `aggregatedBarePath`: ONLY/FIRST/LAST over a bare walk, which picks a record.
fn aggregated_bare_path(expr: &Expression) -> bool {
    use movement_parser::lowering::expression::AggregationFunction as F;
    let Expression::Aggregate { fn_: F::First | F::Last | F::Only, expression, .. } = expr else { return false };
    let Expression::Traverse { steps, expression: terminal, .. } = &**expression else { return false };
    !steps.is_empty() && crate::types::narrowing::is_position_terminal(terminal)
}

impl Checker<'_> {
    /// `checkNodeLiteral`: `node { … }` — the type IS the literal, a
    /// checker-local node whose dot plane is its value entries and whose arrow
    /// plane is the rest. A `graph` literal is checked as one.
    pub fn check_node_literal(&mut self, literal: &NodeLiteral, scope: ScopeId) -> Option<Position> {
        if literal.graph.is_some() {
            return Some(Position::Local(self.check_graph_literal(literal, scope)));
        }
        let mut reads = IndexMap::new();
        let mut edges = IndexMap::new();
        let mut seen = Vec::new();
        for entry in &literal.entries {
            self.note_entry_name(entry, &mut seen);
            match entry {
                NodeEntry::Value { name, value, span } => {
                    let typed = self.check_expr_slot_as(value, scope, false);
                    let ty = self.node_value_entry_type(name, value, *span, typed.expr.as_ref(), typed.ty, scope);
                    reads.insert(name.clone(), ty);
                }
                NodeEntry::Nodes { name, nodes, span } => {
                    let landings: Vec<Position> = nodes.iter().map(|nested| self.check_node_literal(nested, scope).unwrap_or_else(|| empty_local("a node"))).collect();
                    let target = self.merge_landings(&landings, name, *span);
                    edges.insert(name.clone(), local_edge(name, Some(target)));
                }
                NodeEntry::Declared { name, type_, sequenced, .. } => {
                    let (target, structural) = self.declared_edge_landing(name, type_, scope);
                    let edge = LocalEdge { schema: local_edge_schema(name, written_sequencing(sequenced.as_ref())), target, structural, deferred: false, references: false };
                    edges.insert(name.clone(), edge);
                }
                NodeEntry::Traversal { name, head, mapping, lazy, .. } => {
                    let landed = self.check_lazy_traversal(head, mapping.as_ref(), scope);
                    let target = match landed {
                        Some(Position::Local(local)) if mapping.is_some() => Some(Position::Local(LocalNode { label: format!("a '{name}' landing"), ..local })),
                        other => other,
                    };
                    let mut edge = local_edge(name, target);
                    edge.deferred = *lazy;
                    edges.insert(name.clone(), edge);
                }
            }
        }
        for spread in literal.spreads.iter().flatten() {
            let root = spread.path.as_ref().map_or(spread.source.as_str(), |p| p.root.as_str());
            self.resolve_name(root, spread.span, scope);
        }
        Some(Position::Local(LocalNode { label: "a node".to_string(), reads, edges: Some(edges), run_built: None, extracted: None }))
    }

    /// `checkLazyTraversal`: a walk entry's landing — the walk's own, or the
    /// per-item mapping's structure.
    pub fn check_lazy_traversal(&mut self, head: &movement_parser::ast::PathHead, mapping: Option<&NodeLiteral>, scope: ScopeId) -> Option<Position> {
        let aliases = self.check_path_head(head, scope);
        let walk = self.walk_head(head, scope, false);
        match mapping {
            Some(mapping) => {
                let landing = self.open_landing(scope, &aliases, head.span);
                self.type_hop_aliases(landing, &aliases, walk.as_ref());
                self.check_node_literal(mapping, landing)
            }
            None => walk.and_then(|w| w.landed),
        }
    }

    /// `noteEntryName`: one entry name, once per literal.
    fn note_entry_name(&mut self, entry: &NodeEntry, seen: &mut Vec<String>) {
        let (name, span) = entry_name(entry);
        if seen.iter().any(|s| s == name) {
            self.report(codes::NODE_ENTRY_DUPLICATE, format!("'{name}' is written twice in this node — each entry names one thing"), span);
        }
        seen.push(name.to_string());
    }

    /// `nodeValueEntryType`: a field entry's type; a record written as one is refused.
    fn node_value_entry_type(&mut self, name: &str, value: &movement_parser::ast::ExprSlot, span: Span, parsed: Option<&Expression>, ty: Option<Ty>, scope: ScopeId) -> Option<Ty> {
        if let Some(node) = self.bare_node_symbol(&value.raw, parsed, scope) {
            self.report(
                codes::NODE_ENTRY_NODE_VALUE,
                format!(
                    "'{name}: {node}' puts a node in a field — an entry value is a scalar. A node becomes a child by synthesis ('{name}: node {{ … }}') or by a walk ('{name}: {node}-[:Edge]->')"
                ),
                span,
            );
        } else if parsed.is_some_and(aggregated_bare_path) {
            self.report(
                codes::NODE_ENTRY_NODE_VALUE,
                format!(
                    "'{name}' is given a record — ONLY/FIRST/LAST over a bare walk pick a NODE, and an entry value is a scalar. Walk the edge instead ('{name}: <source>-[:Edge]->') or aggregate a field ('ONLY(….`Field`)')"
                ),
                span,
            );
        }
        ty.or_else(|| scalar_literal_type(&value.raw))
    }

    /// `bareNodeSymbol`: the name a slot is, when it is bound on the node plane.
    fn bare_node_symbol(&self, raw: &str, parsed: Option<&Expression>, scope: ScopeId) -> Option<String> {
        let trimmed = raw.trim();
        let name = if crate::slots::is_bare_ident(trimmed) && !crate::slots::is_literal_word(trimmed) {
            Some(trimmed)
        } else {
            parsed.and_then(crate::types::narrowing::bare_name)
        }?;
        let Resolution::Found(id) = self.scopes.resolve(scope, name) else { return None };
        let symbol = self.scopes.symbol(id);
        let node_plane = symbol.types.pos.is_some() || symbol.is_closure || matches!(symbol.types.field, Some(Ty::Record(_)));
        node_plane.then(|| symbol.name.clone())
    }

    /// `declaredEdgeLanding`: what a declared edge's landings are — a node
    /// declaration's records (compared by structure), or an address's.
    fn declared_edge_landing(&mut self, name: &str, type_: &TypeRef, scope: ScopeId) -> (Option<Position>, bool) {
        if type_.hops_raw.is_none() {
            if let Resolution::Found(id) = self.scopes.resolve(scope, &type_.graph)
                && self.scopes.symbol(id).kind == SymbolKind::Shape
            {
                return match self.declared_root(id) {
                    Some(target) => (Some(run_built_landing(target)), true),
                    None => (None, false),
                };
            }
            self.report(
                codes::NODE_ENTRY_TYPE,
                format!(
                    "'{name}: <{graph}>' has to say what LANDS on the edge, and '{graph}' is neither a node this file declares nor an address — declare the structure its landings have ('node {graph} {{ … }}'), or give it the address they come from ('{name}: <{graph}-[:Edge]->>')",
                    graph = type_.graph
                ),
                type_.span,
            );
            return (None, false);
        }
        (self.declared_edge_address(type_, scope), false)
    }

    /// `declaredEdgeAddress`: the hop chain of a declared edge's address, walked.
    fn declared_edge_address(&mut self, type_: &TypeRef, scope: ScopeId) -> Option<Position> {
        let id = self.resolve_name(&type_.graph, type_.span, scope)?;
        let symbol = self.scopes.symbol(id);
        if symbol.kind == SymbolKind::Adapter {
            return None;
        }
        let start = symbol.types.pos.clone().or_else(|| match &symbol.types.field {
            Some(Ty::Record(Some(p))) => Some((**p).clone()),
            _ => None,
        })?;
        let probe = format!("{}{}.`__movement_head_probe__`", crate::families::names::spell_name(&type_.graph), type_.hops_raw.as_deref().unwrap_or(""));
        let Ok(Expression::Traverse { steps, .. }) = crate::slots::expression_of_text(&probe) else { return None };
        let (landed, diagnostics) = {
            let env = self.typing_env(scope);
            let mut typing = crate::types::Typing::new(&env, self.version, type_.span);
            let landed = typing.walk_steps(Some(start), &steps, false);
            (landed, std::mem::take(&mut typing.diagnostics))
        };
        for diagnostic in diagnostics {
            self.push(diagnostic);
        }
        landed
    }

    /// `mergeLandings`: the one landing type a plural synthesised edge exposes
    /// — what every landing carries. Landings that disagree about a read's
    /// type are refused.
    pub fn merge_landings(&mut self, landings: &[Position], name: &str, span: Span) -> Position {
        let label = format!("a '{name}' landing");
        let Some(Position::Local(first)) = landings.first() else { return empty_local(&label) };
        if landings.len() == 1 {
            return Position::Local(LocalNode { label, ..first.clone() });
        }
        let rest = &landings[1..];
        let local_of = |p: &Position| match p {
            Position::Local(l) => Some(l.clone()),
            _ => None,
        };
        let rest: Vec<Option<LocalNode>> = rest.iter().map(local_of).collect();
        let mut reads = IndexMap::new();
        for (read, ty) in &first.reads {
            if !rest.iter().all(|l| l.as_ref().is_some_and(|l| l.reads.contains_key(read))) {
                continue;
            }
            let types: Vec<Option<Ty>> = std::iter::once(ty.clone()).chain(rest.iter().map(|l| l.as_ref().and_then(|l| l.reads.get(read).cloned().flatten()))).collect();
            let known: Vec<&Ty> = types.iter().flatten().collect();
            if let Some(clash) = known.iter().find(|t| !field_type_equals(t, known[0])) {
                self.report(
                    codes::NODE_LANDING_MISMATCH,
                    format!(
                        "the landings of '{name}' disagree about `{read}` ({} and {}) — a traversal lands on one type, so they must agree",
                        describe_field_type(known[0]),
                        describe_field_type(clash)
                    ),
                    span,
                );
            }
            reads.insert(read.clone(), if known.len() == types.len() { Some(known[0].clone()) } else { None });
        }
        let mut edges = IndexMap::new();
        for (edge, local_edge) in first.edges.iter().flatten() {
            if rest.iter().all(|l| l.as_ref().is_some_and(|l| l.edges.as_ref().is_some_and(|e| e.contains_key(edge)))) {
                edges.insert(edge.clone(), local_edge.clone());
            }
        }
        Position::Local(LocalNode { label, reads, edges: Some(edges), run_built: None, extracted: None })
    }
}

fn entry_name(entry: &NodeEntry) -> (&str, Span) {
    match entry {
        NodeEntry::Value { name, span, .. } | NodeEntry::Nodes { name, span, .. } | NodeEntry::Declared { name, span, .. } | NodeEntry::Traversal { name, span, .. } => (name, *span),
    }
}

fn empty_local(label: &str) -> Position {
    Position::Local(LocalNode { label: label.to_string(), reads: IndexMap::new(), edges: None, run_built: None, extracted: None })
}

/// `structuralMisfit`: what a supplied record lacks that the required
/// position (or every variant of a required union) declares.
pub fn structural_misfit(supplied: &Position, required: &Position) -> Option<String> {
    match required {
        Position::Position(p) => node_misfit_against(supplied, &p.instance.schema, &p.position),
        Position::Union(u) => {
            let mut misfits = Vec::new();
            for variant in &u.variants {
                let misfit = node_misfit_against(supplied, &u.instance.schema, variant)?;
                misfits.push(format!("{variant} ({misfit})"));
            }
            (!misfits.is_empty()).then(|| format!("it fits none of {}", or_list(&misfits)))
        }
        Position::Meta { .. } => Some("a synthesised node is a position, not a whole graph".to_string()),
        _ => None,
    }
}

fn node_misfit_against(supplied: &Position, schema: &InstanceSchema, position: &str) -> Option<String> {
    surface_misfit(supplied_surface(supplied).as_ref(), schema, position, false)
}

/// `orList`: `a`, `a or b`, `a, b, or c`.
pub fn or_list(items: &[String]) -> String {
    match items.len() {
        0 => String::new(),
        1 => items[0].clone(),
        2 => format!("{} or {}", items[0], items[1]),
        n => format!("{}, or {}", items[..n - 1].join(", "), items[n - 1]),
    }
}

// ── Graph literals ──

use crate::types::field::{field_assignable, holds_records, is_maybe_absent, record_in, strip_absent};

/// `RequiredPosition`: the declared node a graph body has to satisfy.
#[derive(Clone)]
pub struct Required {
    pub schema: std::rc::Rc<InstanceSchema>,
    pub position: String,
}

impl Required {
    fn declared(&self) -> Option<&movement_parser::catalog::types::PositionSchema> {
        self.schema.positions.get(&self.position)
    }
}

/// `declaredLocalGraph`: the type of `graph<Shape> { … }`, a run-local node
/// whose planes are the declaration's; each child edge lands on the nested
/// node, compared by structure.
fn declared_local_graph(instance: &InstanceRef, position: &str) -> LocalNode {
    let declared = instance.schema.positions.get(position);
    let mut edges = IndexMap::new();
    for (name, edge) in declared.map(|d| d.edges.iter()).into_iter().flatten() {
        let target = position_ref_in(instance, &edge.target);
        let structural = target.is_some();
        edges.insert(
            name.clone(),
            LocalEdge { schema: local_edge_schema(name, edge.sequenced), target: target.map(run_built_landing), structural, deferred: false, references: false },
        );
    }
    let reads = declared.map(|d| d.properties.iter().map(|(k, v)| (k.clone(), Some(Ty::from_schema(v)))).collect()).unwrap_or_default();
    LocalNode { label: format!("a {} graph", describe_shape_node(position)), reads, edges: Some(edges), run_built: None, extracted: None }
}

/// `shapedWithReferences`: a shaped graph is of the shape, except where an
/// entry holds references, at any depth — that edge is typed as its records.
fn shaped_with_references(declared: LocalNode, body: &LocalNode) -> LocalNode {
    let mut edges = declared.edges.clone().unwrap_or_default();
    for (name, edge) in body.edges.iter().flatten() {
        let Some(shaped) = edges.get(name).cloned() else { continue };
        // References this checker could not type: the records are unknown,
        // not the shape's nested node (the TypeScript types them).
        if edge.references && edge.target.is_none() {
            edges.insert(name.clone(), LocalEdge { target: None, references: true, structural: false, ..shaped });
            continue;
        }
        let Some(target) = &edge.target else { continue };
        if edge.references {
            let mut schema = shaped.schema.clone();
            if edge.schema.sequenced.is_some() {
                schema.sequenced = edge.schema.sequenced;
            }
            edges.insert(name.clone(), LocalEdge { schema, target: Some(target.clone()), references: true, ..shaped });
            continue;
        }
        let (Position::Local(child), Some(Position::Position(shaped_child))) = (target, &shaped.target) else { continue };
        if !holds_references(child) {
            continue;
        }
        let retyped = shaped_with_references(declared_local_graph(&shaped_child.instance, &shaped_child.position), child);
        edges.insert(name.clone(), LocalEdge { target: Some(Position::Local(retyped)), ..shaped });
    }
    LocalNode { edges: Some(edges), ..declared }
}

fn holds_references(body: &LocalNode) -> bool {
    body.edges.iter().flatten().any(|(_, e)| e.references || matches!(&e.target, Some(Position::Local(l)) if holds_references(l)))
}

/// `referenceEdge`: a graph literal's edge holding references to records.
fn reference_edge(name: &str, records: Option<Position>, sequenced: Option<movement_parser::catalog::types::EdgeSequencing>) -> LocalEdge {
    LocalEdge { schema: local_edge_schema(name, sequenced), target: records, structural: false, deferred: false, references: true }
}

/// `recordSurface`: what a record a reference entry holds offers.
fn record_surface(position: &Position) -> Option<crate::types::declared::Surface<'_>> {
    match position {
        Position::Handle(h) => match &h.position {
            Some(p) => crate::types::declared::schema_surface(&h.instance.schema, p),
            None => Some(crate::types::declared::Surface { properties: h.result_shape.iter().map(|(k, v)| (k.clone(), Some(v.clone()))).collect(), edges: Vec::new() }),
        },
        Position::Extract { node, .. } => crate::types::declared::extract_surface(node),
        Position::MaybeEmpty(of) => record_surface(of),
        other => supplied_surface(other),
    }
}

/// What a graph entry written as a value holds when it is a record: the
/// records (unknown when `None`) and the order the edge keeps.
struct Reference {
    position: Option<Position>,
    sequenced: Option<movement_parser::catalog::types::EdgeSequencing>,
}

impl Checker<'_> {
    /// `checkGraphLiteral`: `graph<Shape> { … }` / `graph { … }`.
    fn check_graph_literal(&mut self, literal: &NodeLiteral, scope: ScopeId) -> LocalNode {
        let Some(shape) = literal.graph.as_ref().and_then(|g| g.shape.as_ref()) else {
            return self.check_graph_body(literal, scope, None);
        };
        let symbol = self.resolve_name(&shape.name, shape.span, scope);
        if let Some(id) = symbol {
            let kind = self.scopes.symbol(id).kind;
            if kind != SymbolKind::Shape {
                self.report(
                    codes::GRAPH_SHAPE,
                    format!(
                        "'graph<{name}>' takes a node declaration, and '{name}' is {} — declare the structure ('node {name} {{ … }}'), or drop '<{name}>' to infer it from the literal",
                        kind.describe(),
                        name = shape.name
                    ),
                    shape.span,
                );
            }
        }
        let root = symbol.and_then(|id| self.declared_root(id));
        let Some(Position::Position(root)) = root else {
            return self.check_graph_body(literal, scope, None);
        };
        let required = Required { schema: root.instance.schema.clone(), position: root.position.clone() };
        let body = self.check_graph_body(literal, scope, Some(&required));
        shaped_with_references(declared_local_graph(&root.instance, &root.position), &body)
    }

    /// `checkGraphBody`: one body, checked against the shape node it has to
    /// satisfy. What a spread supplies is not typed here: a body with one is
    /// checked for missing fields when the graph is built.
    fn check_graph_body(&mut self, literal: &NodeLiteral, scope: ScopeId, required: Option<&Required>) -> LocalNode {
        let mut reads: IndexMap<String, Option<Ty>> = IndexMap::new();
        let mut edges: IndexMap<String, LocalEdge> = IndexMap::new();
        let spreads = literal.spreads.as_deref().unwrap_or(&[]);
        let mut opaque_spread = false;
        let mut seen = Vec::new();
        for (index, entry) in literal.entries.iter().enumerate() {
            self.apply_graph_spreads(literal, spreads, index, scope, required, &mut reads, &mut edges, &mut opaque_spread);
            self.note_entry_name(entry, &mut seen);
            match entry {
                NodeEntry::Value { name, value, span } => {
                    let typed = self.check_expr_slot_as(value, scope, false);
                    // A value this checker cannot type where the shape declares
                    // a child node is taken for the records it would hold
                    // (unknown): the TypeScript types more values (a `MAP` of
                    // writes) and reads those as references.
                    let untyped_child = typed.ty.is_none()
                        && typed.may_hold.is_none()
                        && scalar_literal_type(&value.raw).is_none()
                        && required.and_then(Required::declared).is_some_and(|d| d.edges.contains_key(name));
                    let reference = if untyped_child {
                        Some(Reference { position: None, sequenced: Some(movement_parser::catalog::types::EdgeSequencing::Arrival) })
                    } else {
                        self.graph_reference(value, typed.expr.as_ref(), typed.ty.as_ref(), typed.may_hold.as_ref(), scope)
                    };
                    if let Some(reference) = reference {
                        if let Some(child) = self.graph_child(name, required, *span)
                            && let Some(records) = &reference.position
                        {
                            self.check_graph_reference_fits(name, records, &child, *span);
                        }
                        reads.shift_remove(name);
                        edges.insert(name.clone(), reference_edge(name, reference.position, reference.sequenced));
                        continue;
                    }
                    // A value holding a record somewhere inside is the
                    // graph-spread family's refusal; its field is not judged here.
                    let holds = holds_records(typed.ty.as_ref()) || holds_records(typed.may_hold.as_ref());
                    let ty = self.node_value_entry_type(name, value, *span, typed.expr.as_ref(), typed.ty, scope);
                    edges.shift_remove(name);
                    reads.insert(name.clone(), ty.clone());
                    if let Some(required) = required
                        && !holds
                    {
                        self.check_graph_field(name, ty.as_ref(), required, *span, None);
                    }
                }
                NodeEntry::Nodes { name, nodes, span } => {
                    let child = self.graph_child(name, required, *span);
                    let landings: Vec<Position> = nodes.iter().map(|n| Position::Local(self.check_graph_body(n, scope, child.as_ref()))).collect();
                    let target = self.merge_landings(&landings, name, *span);
                    reads.shift_remove(name);
                    edges.insert(name.clone(), local_edge(name, Some(target)));
                }
                NodeEntry::Traversal { name, head, mapping, span, .. } => {
                    let child = self.graph_child(name, required, *span);
                    reads.shift_remove(name);
                    let edge = self.check_graph_walk(name, head, mapping.as_ref(), *span, scope, child.as_ref());
                    edges.insert(name.clone(), edge);
                }
                // The parser refuses a declared edge in a graph body.
                NodeEntry::Declared { .. } => {}
            }
        }
        self.apply_graph_spreads(literal, spreads, literal.entries.len(), scope, required, &mut reads, &mut edges, &mut opaque_spread);
        if let Some(required) = required
            && !opaque_spread
        {
            self.report_missing_graph_fields(required, &reads, literal.span);
        }
        LocalNode { label: "a graph".to_string(), reads, edges: Some(edges), run_built: None, extracted: None }
    }

    /// `reportMissingGraphFields`.
    fn report_missing_graph_fields(&mut self, required: &Required, reads: &IndexMap<String, Option<Ty>>, span: Span) {
        let Some(declared) = required.declared() else { return };
        let missing: Vec<(String, Ty)> = declared
            .properties
            .iter()
            .filter(|(name, _)| !reads.contains_key(*name))
            .map(|(name, want)| (name.clone(), Ty::from_schema(want)))
            .filter(|(_, want)| !is_maybe_absent(Some(want)))
            .collect();
        for (name, want) in missing {
            self.report(
                codes::GRAPH_FIELD_MISSING,
                format!(
                    "{} needs `{name}` ({}) and this graph doesn't write it — only a field declared '<T | null>' may be left out",
                    describe_shape_node(&required.position),
                    describe_field_type(&want)
                ),
                span,
            );
        }
    }

    /// `checkGraphField`: a field written in a body that has to satisfy `required`.
    fn check_graph_field(&mut self, name: &str, have: Option<&Ty>, required: &Required, span: Span, via: Option<&str>) {
        let Some(declared) = required.declared() else { return };
        let Some(want) = declared.properties.get(name).map(Ty::from_schema) else {
            self.report_graph_unknown(name, required, span, false);
            return;
        };
        let shape = describe_shape_node(&required.position);
        let Some(have) = have else { return };
        if !field_assignable(have, &want) {
            self.report(
                codes::GRAPH_FIELD_TYPE,
                format!(
                    "{shape} declares `{name}` as {}, and this is {}{}",
                    describe_field_type(&want),
                    describe_field_type(have),
                    crate::types::declared::text_repair(have, &want)
                ),
                span,
            );
            return;
        }
        if is_maybe_absent(Some(have)) && !is_maybe_absent(Some(&want)) && self.version >= 3 {
            let supplier = via.map_or_else(|| "this value".to_string(), |v| format!("'...{v}' supplies one that"));
            self.report(
                codes::ABSENT_REQUIRED,
                format!(
                    "{shape} needs `{name}` ({}), and {supplier} may be absent ({}) — fall back to a value that is always there ('{name}: COALESCE(…, \"…\")'), or declare the field '<{} | null>' if it may be left empty",
                    describe_field_type(&want),
                    describe_field_type(have),
                    describe_field_type(strip_absent(&want))
                ),
                span,
            );
        }
    }

    /// `graphChild`: the nested node a child entry has to satisfy.
    fn graph_child(&mut self, name: &str, required: Option<&Required>, span: Span) -> Option<Required> {
        let required = required?;
        let declared = required.declared()?;
        let Some(edge) = declared.edges.get(name) else {
            self.report_graph_unknown(name, required, span, true);
            return None;
        };
        Some(Required { schema: required.schema.clone(), position: edge.target.clone() })
    }

    /// `reportGraphUnknown`: an entry the shape doesn't declare as what it was written as.
    fn report_graph_unknown(&mut self, name: &str, required: &Required, span: Span, as_child: bool) {
        let declared = required.declared();
        let shape = describe_shape_node(&required.position);
        if !as_child && declared.is_some_and(|d| d.edges.contains_key(name)) {
            self.report(
                codes::GRAPH_ENTRY_KIND,
                format!("`{name}` is a child node of {shape}, not a field — build it with a body ('{name}: {{ … }}') or from a walk ('{name}: m-[x:Edge]-> {{ … }}')"),
                span,
            );
            return;
        }
        if as_child && declared.is_some_and(|d| d.properties.contains_key(name)) {
            self.report(codes::GRAPH_ENTRY_KIND, format!("`{name}` is a field of {shape}, not a child node — give it a value ('{name}: …')"), span);
            return;
        }
        let known: Vec<String> = declared.map(|d| d.properties.keys().chain(d.edges.keys()).cloned().collect()).unwrap_or_default();
        let listed = if known.is_empty() { "(nothing)".to_string() } else { known.join(", ") };
        self.report(codes::GRAPH_FIELD_UNKNOWN, format!("{shape} has no `{name}`{} — it declares: {listed}", crate::meta::did_you_mean(name, &known)), span);
    }

    /// `checkGraphWalk`: a walk in a graph body — with a body, each record
    /// builds a child from it; bare, the edge holds references to the records.
    fn check_graph_walk(
        &mut self,
        name: &str,
        head: &movement_parser::ast::PathHead,
        mapping: Option<&NodeLiteral>,
        span: Span,
        scope: ScopeId,
        required: Option<&Required>,
    ) -> LocalEdge {
        let aliases = self.check_path_head(head, scope);
        let walk = self.walk_head(head, scope, false);
        if let Some(mapping) = mapping {
            let landing = self.open_landing(scope, &aliases, head.span);
            self.type_hop_aliases(landing, &aliases, walk.as_ref());
            let body = self.check_graph_body(mapping, landing, required);
            return local_edge(name, Some(Position::Local(LocalNode { label: format!("a '{name}' landing"), ..body })));
        }
        let landed = walk.as_ref().and_then(|w| w.landed.clone());
        if let Some(required) = required
            && let Some(records) = &landed
        {
            self.check_graph_reference_fits(name, records, required, span);
        }
        let sequenced = walk.as_ref().and_then(|w| w.last_edge_schema.as_ref().and_then(|e| e.sequenced)).or_else(|| last_hop_ordered(head).then_some(movement_parser::catalog::types::EdgeSequencing::Arrival));
        reference_edge(name, landed, sequenced)
    }

    /// `graphReference`: a value entry that is a record, and so an edge
    /// holding a reference to it.
    fn graph_reference(&mut self, value: &movement_parser::ast::ExprSlot, parsed: Option<&Expression>, ty: Option<&Ty>, may_hold: Option<&Ty>, scope: ScopeId) -> Option<Reference> {
        use movement_parser::catalog::types::EdgeSequencing::Arrival;
        let trimmed = value.raw.trim();
        let name = if crate::slots::is_bare_ident(trimmed) && !crate::slots::is_literal_word(trimmed) { Some(trimmed) } else { parsed.and_then(crate::types::narrowing::bare_name) };
        if let Some(name) = name
            && let Resolution::Found(id) = self.scopes.resolve(scope, name)
        {
            let symbol = self.scopes.symbol(id);
            let node_plane = symbol.types.pos.is_some() || symbol.is_closure || matches!(symbol.types.field, Some(Ty::Record(_)));
            if node_plane {
                if matches!(symbol.kind, SymbolKind::Shape | SymbolKind::Instance | SymbolKind::Movement) {
                    return None;
                }
                let position = symbol.types.pos.clone().or_else(|| match &symbol.types.field {
                    Some(Ty::Record(Some(p))) => Some((**p).clone()),
                    _ => None,
                });
                if matches!(position, Some(Position::Closure(_) | Position::Meta { .. })) {
                    return None;
                }
                let plural = symbol.types.plural.is_some();
                return Some(Reference { position, sequenced: (!plural).then_some(Arrival) });
            }
        }
        if parsed.is_some_and(aggregated_bare_path) {
            let selected = record_in(ty).flatten();
            let position = match selected {
                Some(Position::MaybeEmpty(of)) => Some(*of),
                other => other,
            };
            return Some(Reference { position, sequenced: Some(Arrival) });
        }
        let held = record_in(ty)?;
        let unordered = matches!(ty.map(strip_absent), Some(Ty::List { unordered: true, .. }));
        let _ = may_hold;
        Some(Reference { position: held, sequenced: (!unordered).then_some(Arrival) })
    }

    /// `checkGraphReferenceFits`: do the records a reference entry holds carry
    /// what the shape's child node needs?
    fn check_graph_reference_fits(&mut self, name: &str, records: &Position, required: &Required, span: Span) {
        let Some(misfit) = surface_misfit(record_surface(records).as_ref(), &required.schema, &required.position, true) else { return };
        self.report(
            codes::GRAPH_REFERENCE_SHAPE,
            format!(
                "'{name}' holds the records themselves, and {} doesn't fit them: {misfit} — copy the fields it needs with a body ('{name}: … -> {{ field: x.Field }}')",
                describe_shape_node(&required.position)
            ),
            span,
        );
    }
}

impl Checker<'_> {
    /// A `link` with a body onto a node this run built: the body would find
    /// among what the edge already holds.
    pub fn report_local_link_body(&mut self, link: &movement_parser::ast::LinkExpression, label: &str, span: Span) {
        self.report(
            codes::NODE_LINK_BODY,
            format!(
                "'{from}' is {label} this run built, so a body here would find among what '{edge}' already holds — anything it found is linked already. To pick one of them out, 'match {from}-[:{edge}]-> {{ … }}'; to link a record you hold, 'link {from} -[:{edge}]-> <name>'",
                from = link.from,
                edge = link.edge
            ),
            span,
        );
    }

    /// `reportUndeclaredLocalEdge`: a local node's edges are exactly what declared it.
    pub fn report_undeclared_local_edge(&mut self, from: &LocalNode, edge: &str, span: Span, subject: Option<&str>) {
        let declared: Vec<&str> = from.edges.iter().flat_map(|e| e.keys()).map(String::as_str).collect();
        let subject = subject.map_or_else(|| from.label.clone(), |s| format!("'{s}'"));
        let has = if declared.is_empty() {
            format!(" — declare it where the node is built ('{edge}: <SomeNode>' or '{edge}: <source-[:Edge]->>')")
        } else {
            format!(" — it has: {}", declared.join(", "))
        };
        self.report(codes::NODE_EDGE_UNDECLARED, format!("{subject} declares no edge '{edge}'{has}"), span);
    }

    /// `checkLocalLink`: `link sent -[:messages]-> one` onto a node this run
    /// built — appended to an edge the literal declared, and judged by
    /// structure where the edge's landings are a declared node's (or the
    /// record linked is itself a node a construct built).
    pub fn check_local_link(&mut self, link: &movement_parser::ast::LinkExpression, to: &str, from: &LocalNode, scope: ScopeId) {
        let Some(edge) = from.edges.as_ref().and_then(|e| e.get(&link.edge)) else {
            self.report_undeclared_local_edge(from, &link.edge, link.span, Some(&link.from));
            return;
        };
        if edge.deferred {
            self.report(
                codes::NODE_EDGE_DEFERRED,
                format!(
                    "'{e}' is a lazy entry — its landings come from a walk that runs again at every read, so an appended one would be gone by the next. Declare a separate edge for what this run writes ('{e}Written: <source-[:Edge]->>')",
                    e = link.edge
                ),
                link.span,
            );
            return;
        }
        let to_type = match self.scopes.resolve(scope, to) {
            Resolution::Found(id) => {
                let types = &self.scopes.symbol(id).types;
                types.pos.clone().or_else(|| match &types.field {
                    Some(Ty::Record(Some(p))) => Some((**p).clone()),
                    _ => None,
                })
            }
            _ => None,
        };
        let (Some(to_type), Some(target)) = (to_type, edge.target.as_ref()) else { return };
        let local_to = matches!(to_type, Position::Local(_));
        if (edge.structural || local_to)
            && let Some(misfit) = structural_misfit(&to_type, target)
        {
            self.report(codes::NODE_LINK_SHAPE, format!("'{}' lands on {}, and {misfit}", link.edge, describe_position(target)), link.span);
            return;
        }
        if !edge.structural && !local_to && positions_match(&to_type, target) == Some(false) {
            self.report(
                codes::NODE_LINK_SHAPE,
                format!("'{}' lands on {}, but '{to}' is {}", link.edge, describe_position(target), describe_position(&to_type)),
                link.span,
            );
        }
    }
}

/// `declaredParamMisfit`: what a record lacks that a declared-node parameter needs.
pub(crate) fn declared_param_misfit(arg: &Position, param: &crate::types::position::RecordPosition) -> Option<String> {
    let schema = &param.instance.schema;
    match arg {
        Position::Union(u) => {
            for variant in &u.variants {
                let surface = crate::types::declared::schema_surface(&u.instance.schema, variant);
                if let Some(misfit) = surface_misfit(surface.as_ref(), schema, &param.position, false) {
                    let shown = crate::types::position::display_name_of(&u.instance, variant);
                    return Some(format!("{shown}, one of what this argument may be, does not fit: {misfit}"));
                }
            }
            None
        }
        Position::Meta { .. } | Position::Closure(_) => Some(format!("this argument is {}, not a record", describe_position(arg))),
        _ => surface_misfit(record_surface(arg).as_ref(), schema, &param.position, false),
    }
}

/// What a graph literal's spread supplies: its keys on the two planes.
struct SpreadKeys {
    reads: IndexMap<String, Option<Ty>>,
    edges: IndexMap<String, LocalEdge>,
    may_be_absent: bool,
}

/// `nestedMapKeys`: the keys a nested map (or a list of them) holds.
fn nested_map_keys(ty: &Ty) -> Option<IndexMap<String, Option<Ty>>> {
    match strip_absent(ty) {
        Ty::Dict { shape, .. } => shape.as_ref().map(|s| s.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
        Ty::List { of, .. } => nested_map_keys(of),
        Ty::Tuple { of, rest } => {
            let members: Vec<Option<&Ty>> = of.iter().map(Option::as_ref).chain(rest.as_ref().map(|r| r.of.as_deref())).collect();
            let keyed: Vec<Option<IndexMap<String, Option<Ty>>>> = members.iter().map(|m| m.and_then(nested_map_keys)).collect();
            let (first, others) = keyed.split_first()?;
            let first = first.as_ref()?;
            if others.iter().any(Option::is_none) {
                return None;
            }
            let mut common = IndexMap::new();
            for (key, key_type) in first {
                let found: Vec<Option<&Option<Ty>>> = others.iter().map(|o| o.as_ref().and_then(|o| o.get(key))).collect();
                if found.iter().any(Option::is_none) {
                    continue;
                }
                let agreed = found.iter().all(|o| matches!((o, key_type), (Some(Some(other)), Some(mine)) if field_type_equals(other, mine)));
                common.insert(key.clone(), if agreed { key_type.clone() } else { None });
            }
            Some(common)
        }
        _ => None,
    }
}

/// `mayHoldMap`.
fn may_hold_map(ty: &Ty) -> bool {
    match strip_absent(ty) {
        Ty::Json | Ty::Dict { .. } => true,
        Ty::List { of, .. } => may_hold_map(of),
        Ty::Tuple { of, rest } => of.iter().flatten().chain(rest.as_ref().and_then(|r| r.of.as_deref())).any(may_hold_map),
        _ => false,
    }
}

impl Checker<'_> {
    /// The spreads written before entry `index` of a graph body, applied in
    /// order: a later member wins, and a key written before a spread that
    /// always supplies it is overwritten (MAP_KEY_OVERWRITTEN).
    #[allow(clippy::too_many_arguments)]
    fn apply_graph_spreads(
        &mut self,
        literal: &NodeLiteral,
        spreads: &[movement_parser::ast::MapSpread],
        index: usize,
        scope: ScopeId,
        required: Option<&Required>,
        reads: &mut IndexMap<String, Option<Ty>>,
        edges: &mut IndexMap<String, LocalEdge>,
        opaque: &mut bool,
    ) {
        for spread in spreads.iter().filter(|s| s.after == index) {
            let earlier: Vec<&str> = literal.entries[..index].iter().map(|e| entry_name(e).0).collect();
            let written: Vec<&str> = literal.entries[index..].iter().map(|e| entry_name(e).0).collect();
            let Some(keys) = self.check_graph_spread(spread, scope, required, &written, &earlier) else {
                *opaque = true;
                continue;
            };
            let names: Vec<String> = keys.reads.keys().chain(keys.edges.keys()).cloned().collect();
            for name in names {
                if !keys.may_be_absent && earlier.contains(&name.as_str()) {
                    self.report(
                        codes::MAP_KEY_OVERWRITTEN,
                        format!(
                            "'{name}' is written before '...{}', which always has '{name}', so the spread overwrites it — move '{name}: …' after the spread to override it, or drop it",
                            spread.source
                        ),
                        spread.span,
                    );
                }
                let held = reads.contains_key(&name) || edges.contains_key(&name);
                if keys.may_be_absent && held {
                    if let (Some(Some(before)), Some(Some(ty))) = (reads.get(&name), keys.reads.get(&name)) {
                        let merged = crate::types::field::value_union(&[before.clone(), strip_absent(ty).clone()]);
                        reads.insert(name.clone(), merged);
                    }
                    continue;
                }
                reads.shift_remove(&name);
                edges.shift_remove(&name);
                if let Some(ty) = keys.reads.get(&name) {
                    reads.insert(name.clone(), ty.clone());
                } else if let Some(edge) = keys.edges.get(&name) {
                    edges.insert(name.clone(), edge.clone());
                }
            }
        }
    }

    /// `checkGraphSpread`: what `...v` supplies, key by key — `None` when its
    /// keys can't be named here. A value this checker cannot type is taken
    /// as such a spread rather than refused.
    fn check_graph_spread(&mut self, spread: &movement_parser::ast::MapSpread, scope: ScopeId, required: Option<&Required>, written: &[&str], earlier: &[&str]) -> Option<SpreadKeys> {
        let root = spread.path.as_ref().map_or(spread.source.as_str(), |p| p.root.as_str());
        let id = self.resolve_name(root, spread.span, scope)?;
        if spread.path.is_some() {
            return None;
        }
        let symbol = self.scopes.symbol(id).clone();
        let record = match &symbol.types.pos {
            Some(Position::Meta { .. } | Position::Closure(_)) => None,
            Some(Position::MaybeEmpty(of)) => Some((Some((**of).clone()), true)),
            Some(other) if symbol.types.plural.is_none() => Some((Some(other.clone()), false)),
            Some(_) => return None,
            None => match symbol.types.field.as_ref() {
                Some(held) => match strip_absent(held) {
                    Ty::Record(position) => Some((position.as_deref().cloned(), is_maybe_absent(Some(held)))),
                    _ => None,
                },
                None => None,
            },
        };
        if let Some((position, may_be_absent)) = record {
            let mut keys = self.check_graph_record_spread(spread, position.as_ref(), may_be_absent, required, written, earlier)?;
            keys.may_be_absent = may_be_absent;
            return Some(keys);
        }
        let value = if symbol.types.pos.is_none() { symbol.types.field.clone() } else { None };
        let value = value?;
        let map = strip_absent(&value).clone();
        if !matches!(map, Ty::Json | Ty::Dict { .. }) {
            self.report(
                codes::GRAPH_SPREAD_NOT_MAP,
                format!(
                    "'...{}' copies a map's keys or a record's fields into the graph, and '{}' is {} — spread a map (plugin output, JSON, '{{ … }}') or one record, or write the fields one by one",
                    spread.source,
                    spread.source,
                    describe_field_type(&map)
                ),
                spread.span,
            );
            return None;
        }
        let may_be_absent = is_maybe_absent(Some(&value));
        let keys: Option<IndexMap<String, Option<Ty>>> = match &map {
            Ty::Dict { shape: Some(shape), .. } => Some(
                shape
                    .iter()
                    .map(|(k, v)| (k.clone(), if may_be_absent { v.clone().map(crate::types::field::maybe_absent) } else { v.clone() }))
                    .collect(),
            ),
            _ => None,
        };
        let Some(keys) = keys else {
            if required.is_none() {
                self.report(
                    codes::GRAPH_SPREAD_UNTYPED,
                    format!(
                        "nothing says which keys '{s}' holds, so nothing could say what this graph holds — give the graph a shape ('graph<Shape> {{ ...{s} }}'), and it is checked against the shape when it is built",
                        s = spread.source
                    ),
                    spread.span,
                );
            }
            return None;
        };
        let (reads, edges) = self.check_spread_keys(&keys, required, spread, written, earlier);
        Some(SpreadKeys { reads, edges, may_be_absent })
    }

    /// `checkGraphRecordSpread`: `...r` of one record — its fields copied.
    fn check_graph_record_spread(
        &mut self,
        spread: &movement_parser::ast::MapSpread,
        position: Option<&Position>,
        may_be_absent: bool,
        required: Option<&Required>,
        written: &[&str],
        earlier: &[&str],
    ) -> Option<SpreadKeys> {
        let absent = |ty: Option<Ty>| if may_be_absent { ty.map(crate::types::field::maybe_absent) } else { ty };
        let supplied = position.and_then(record_surface);
        let Some(supplied) = supplied else {
            if required.is_none() {
                self.report(
                    codes::GRAPH_SPREAD_UNTYPED,
                    format!(
                        "nothing says which fields '{s}' has, so nothing could say what this graph holds — give the graph a shape ('graph<Shape> {{ ...{s} }}'), and it is checked against the shape when it is built",
                        s = spread.source
                    ),
                    spread.span,
                );
            }
            return None;
        };
        let Some(required) = required else {
            let reads = supplied.properties.iter().map(|(k, v)| (k.clone(), absent(v.clone()))).collect();
            return Some(SpreadKeys { reads, edges: IndexMap::new(), may_be_absent });
        };
        let declared = required.declared().cloned();
        let mut reads = IndexMap::new();
        let mut edges = IndexMap::new();
        for name in declared.iter().flat_map(|d| d.properties.keys()) {
            let Some((_, ty)) = supplied.properties.iter().find(|(k, _)| k == name) else { continue };
            let ty = absent(ty.clone());
            if !written.contains(&name.as_str()) {
                let held = if earlier.contains(&name.as_str()) { ty.as_ref().map(|t| strip_absent(t).clone()) } else { ty.clone() };
                self.check_graph_field(name, held.as_ref(), required, spread.span, Some(&spread.source));
            }
            reads.insert(name.clone(), ty);
        }
        let follows_edges = !matches!(position, Some(Position::Handle(_)));
        for (name, edge) in declared.iter().flat_map(|d| d.edges.iter()) {
            if !follows_edges || written.contains(&name.as_str()) {
                continue;
            }
            let Some((_, landing)) = supplied.edges.iter().find(|(k, _)| k == name) else { continue };
            let landed = landing.as_ref().and_then(|thunk| thunk());
            if let Some(misfit) = surface_misfit(landed.as_ref(), &required.schema, &edge.target, true) {
                self.report(
                    codes::GRAPH_COPY_SHAPE,
                    format!(
                        "'...{s}' copies its '{name}' records, and {} doesn't fit them: {misfit} — write '{name}' after the spread with a body ('{name}: {s}-[x:{name}]-> {{ field: x.Field }}')",
                        describe_shape_node(&edge.target),
                        s = spread.source
                    ),
                    spread.span,
                );
            }
            edges.insert(name.clone(), local_edge(name, None));
        }
        Some(SpreadKeys { reads, edges, may_be_absent })
    }

    /// `checkSpreadKeys`: a known map's keys, read as a graph body.
    fn check_spread_keys(
        &mut self,
        keys: &IndexMap<String, Option<Ty>>,
        required: Option<&Required>,
        spread: &movement_parser::ast::MapSpread,
        written: &[&str],
        earlier: &[&str],
    ) -> (IndexMap<String, Option<Ty>>, IndexMap<String, LocalEdge>) {
        let declared = required.and_then(Required::declared).cloned();
        let mut reads = IndexMap::new();
        let mut edges = IndexMap::new();
        for (key, value_type) in keys {
            let nested = value_type.as_ref().and_then(nested_map_keys);
            let as_child = match &declared {
                Some(d) => d.edges.contains_key(key),
                None => nested.is_some(),
            };
            if !as_child {
                if declared.is_none() && value_type.as_ref().is_some_and(may_hold_map) {
                    self.report(
                        codes::GRAPH_SPREAD_UNTYPED,
                        format!(
                            "'{s}.{key}' may hold a nested map, and without a shape nothing says whether that is a child node or a value — give the graph a shape ('graph<Shape> {{ ...{s} }}')",
                            s = spread.source
                        ),
                        spread.span,
                    );
                }
                if let (Some(required), Some(d), Some(ty)) = (required, &declared, value_type)
                    && d.properties.contains_key(key)
                    && !written.contains(&key.as_str())
                {
                    let held = if earlier.contains(&key.as_str()) { strip_absent(ty).clone() } else { ty.clone() };
                    self.check_graph_field(key, Some(&held), required, spread.span, Some(&spread.source));
                }
                reads.insert(key.clone(), value_type.clone());
                continue;
            }
            let child = match (required, &declared) {
                (Some(required), Some(d)) => d.edges.get(key).map(|e| Required { schema: required.schema.clone(), position: e.target.clone() }),
                _ => None,
            };
            let Some(nested) = nested else {
                if let Some(ty) = value_type
                    && !may_hold_map(ty)
                {
                    let shape = describe_shape_node(required.map_or("", |r| r.position.as_str()));
                    self.report(
                        codes::GRAPH_ENTRY_KIND,
                        format!("'{}.{key}' is {}, and `{key}` is a child node of {shape} — it needs a map, or a list of maps", spread.source, describe_field_type(ty)),
                        spread.span,
                    );
                }
                edges.insert(key.clone(), local_edge(key, None));
                continue;
            };
            let (landing_reads, landing_edges) = self.check_spread_keys(&nested, child.as_ref(), spread, &[], &[]);
            if let Some(child) = &child {
                self.report_missing_graph_fields(child, &landing_reads, spread.span);
            }
            let landing = LocalNode { label: format!("a '{key}' landing"), reads: landing_reads, edges: Some(landing_edges), run_built: None, extracted: None };
            edges.insert(key.clone(), local_edge(key, Some(Position::Local(landing))));
        }
        (reads, edges)
    }
}

/// Whether a head's last hop sorts its landings (`ORDER BY` on the edge).
fn last_hop_ordered(head: &movement_parser::ast::PathHead) -> bool {
    use movement_parser::lowering::expression::TraversalStep;
    let probe = format!("x{}.`__movement_head_probe__`", head.hops_raw);
    let Ok(Expression::Traverse { steps, .. }) = crate::slots::expression_of_text(&probe) else { return false };
    matches!(steps.last(), Some(TraversalStep::Edge(edge)) if edge.cardinality.as_ref().is_some_and(|c| c.order_by.is_some()))
}
