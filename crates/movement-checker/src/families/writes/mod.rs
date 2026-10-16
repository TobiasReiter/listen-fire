//! The writes family (check.ts `checkWrite`, `checkMatch`, `checkLinkedPath`
//! and their helpers): where a write or a match lands, what its body may
//! set, how it finds the record it means (`unique by`), and the edge-only
//! statements (`link`, `unlink`, `delete`, `refresh`).
//!
//! The walk (`crate::checker`) resolves every name a write reads first; the
//! rules here run after, against the types the type core gives each name.
//! Where a name carries no type, every rule here stays silent: the
//! TypeScript would know more, and a guess would be a diagnostic it never
//! reports.
//!
//! Codes raised elsewhere: MOV_WRITE_ONLY_EDGE and MOV_WRITE_ONLY_PROPERTY
//! are raised by the walk's typing (`typing.ts`, the walks family's hooks);
//! MOV_LINKED_HOP_RETIRED by `checkWalkKeepsWhatIsWritten`.
//! MOV_LINKED_TARGET_NOT_WRITABLE and MOV_WRITE_UNKNOWN_ROOT are declared
//! and never raised.

mod identity;
mod link;

pub use link::LinkVerb;

use movement_parser::ast::{
    FieldEntry, FieldWriteMode, MatchExpression, PathHead, PathRoot, Span, UniqueClause, WriteExpression, WriteSpread, WriteTarget,
};
use movement_parser::catalog::types::{PositionSchema, SchemaFieldType, WritableRootSchema};
use movement_parser::lowering::expression::{Expression, StaticValue, TraversalStep};

use crate::checker::Checker;
use crate::codes;
use crate::diagnostic::{Diagnostic, Severity};
use crate::families::names::spell_name;
use crate::scope::{Resolution, ScopeId, SymbolKind};
use crate::slots::{expression_of_slot, is_bare_ident};
use crate::types::field::{
    HeldHandle, HeldWalk, Ty, closure_not_data_message, describe_field_type, field_assignable, field_type_compatible, handle_within,
    holds_records, is_list, is_maybe_absent, may_be_closure, spell_held_steps, strip_absent,
};
use crate::types::position::{HandlePosition, InstanceRef, Position, describe_position, position_schema_of_ref};
use crate::types::scope_env::SymbolTypes;
use crate::types::Typing;
use crate::version;

/// What a target path is for: a write creates along the edge, a match only
/// looks along it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    Write,
    Match,
}

impl Purpose {
    fn word(self) -> &'static str {
        match self {
            Purpose::Write => "write",
            Purpose::Match => "match",
        }
    }
}

/// One parent a target path hangs the record off (required-edge satisfaction).
pub struct Parent {
    pub type_: Option<String>,
    pub edge: String,
}

/// The fully-typed landing of a linked path.
pub struct Resolved {
    pub instance: InstanceRef,
    pub written: String,
    pub parent_type: Option<String>,
    pub edge_name: String,
}

/// Where a target lands (`checkLinkedPath`'s answer).
#[derive(Default)]
pub struct Landing {
    pub root: Option<WritableRootSchema>,
    pub handle: Option<Position>,
    pub description: Option<String>,
    /// The record lands on an edge of a node this run built.
    pub local: bool,
    /// …whose landings are a node declaration's records.
    pub declared: bool,
    pub resolved: Option<Resolved>,
}

/// What a name holds, for a rule that needs a record (`recordOfName`).
pub enum RecordOf {
    Record(Position),
    /// A value, described.
    Value(String),
    /// A record nobody describes, or a name nothing types: silence.
    Unknown,
}

/// A write field as the rules read it: an authored line, or one a spread
/// stands for (`expandWriteSpreads`).
struct Field<'a> {
    name: String,
    value: std::borrow::Cow<'a, movement_parser::ast::ExprSlot>,
    semantics: Option<FieldWriteMode>,
    spread: Option<String>,
    span: Span,
}

impl<'a> Field<'a> {
    fn authored(field: &'a FieldEntry) -> Self {
        Field {
            name: field.name.clone(),
            value: std::borrow::Cow::Borrowed(&field.value),
            semantics: field.semantics,
            spread: None,
            span: field.span,
        }
    }
}

impl Checker<'_> {
    /// `upgradeCrosses`: this check is for a move up across version `n`.
    pub fn upgrade_crosses(&self, n: u32) -> bool {
        self.upgrading_from.is_some_and(|from| from < n && self.version >= n)
    }

    pub fn report_with(&mut self, code: &str, message: impl Into<String>, span: Span, severity: Severity) {
        let mut diagnostic = Diagnostic::error(code, message, span);
        diagnostic.severity = Some(severity);
        self.push(diagnostic);
    }

    pub(crate) fn report_upgrade_warning(&mut self, code: &str, message: impl Into<String>, span: Span) {
        let mut diagnostic = Diagnostic::error(code, message, span);
        diagnostic.severity = Some(Severity::Warning);
        diagnostic.upgrade = Some(true);
        self.push(diagnostic);
    }

    /// `recordOfName`, for the symbol `name` resolves to in `scope`.
    pub fn record_of_name(&self, name: &str, scope: ScopeId) -> Option<RecordOf> {
        let Resolution::Found(id) = self.scopes.resolve(scope, name) else { return None };
        let symbol = self.scopes.symbol(id);
        Some(record_of(&symbol.types, symbol.kind))
    }

    // ── write ──

    /// `checkWrite`, the rules half: returns the handle the write hands back.
    pub fn check_write_rules(&mut self, write: &WriteExpression, scope: ScopeId, binding: Option<&str>, is_bound: bool) -> Option<Position> {
        let spread_lines = self.expand_write_spreads(write, scope);
        let mut fields: Vec<Field> = write.fields.iter().map(Field::authored).collect();
        fields.extend(spread_lines);
        if self.refuse_shape_write(write, &fields, scope) {
            return None;
        }
        let mut root: Option<WritableRootSchema>;
        let mut root_description = "the write target".to_string();
        let mut handle: Option<Position>;
        let mut local = false;
        let mut declared_target = false;
        let mut parents: Vec<Parent> = Vec::new();
        let mut position_write = false;
        let bind_name = write.bind.as_ref().map(|b| b.name.as_str());

        match &write.target {
            WriteTarget::Linked { path, explicit_type, span } => {
                let linked = self.linked_target(path, explicit_type.as_deref(), *span, Purpose::Write, is_bound, bind_name, scope);
                root = linked.root;
                handle = linked.handle;
                local = linked.local;
                declared_target = linked.declared;
                if let Some(description) = linked.description {
                    root_description = description;
                }
                if let Some(resolved) = linked.resolved {
                    parents.push(Parent { type_: resolved.parent_type, edge: resolved.edge_name });
                }
            }
            WriteTarget::Tuple { paths, explicit_type, span } => {
                let tuple = self.tuple_target(paths, explicit_type.as_deref(), *span, &mut parents, Purpose::Write, is_bound, bind_name, scope);
                root = tuple.root;
                handle = tuple.handle;
                if let Some(description) = tuple.description {
                    root_description = description;
                }
            }
            WriteTarget::Position { root: target_root, span } => {
                let position = self.position_target(target_root, *span, scope);
                root = position.root;
                handle = position.handle;
                root_description = position.description.unwrap_or_default();
                local = position.local;
                declared_target = position.declared;
                position_write = true;
                if let PathRoot::Name { name } = target_root
                    && matches!(&handle, Some(Position::Handle(h)) if h.written)
                    && self.upgrade_crosses(4)
                {
                    let named = binding.map(|b| format!(" ('{b}' names the same record)")).unwrap_or_default();
                    self.report_upgrade_warning(
                        codes::HANDLE_UPDATED_IN_PLACE,
                        format!(
                            "since {} '{name}' reads as the updated record below this line{named}; before, it kept the values of its own write",
                            version::describe(4)
                        ),
                        *span,
                    );
                }
            }
        }

        let selected = self.select_write_variant(root, &fields, &root_description);
        root = selected.root;
        root_description = selected.description;
        if let Some(variant) = &selected.variant {
            handle = self.handle_of_variant(handle, variant);
        }
        handle = self.apply_generic_landings(handle, &fields, root.as_ref(), &root_description);
        if !position_write {
            handle = with_set_fields(handle, &fields);
        }

        if write.bind.is_some() {
            self.check_bind_clause(write, scope, handle.as_ref());
        }
        self.check_write_union(write, &fields, root.as_ref(), &root_description);

        let target_span = target_span(&write.target);
        if matches!(write.target, WriteTarget::Position { .. }) {
            if let (Some(clause), WriteTarget::Position { root: target_root, .. }) = (write.unique_by.first(), &write.target) {
                self.report(
                    codes::WRITE_POSITION_UNIQUE,
                    format!(
                        "'unique by' has no meaning on a position write — 'write {} {{ … }}' already holds the exact record. Drop the 'unique by' clause",
                        spell_path_root(target_root)
                    ),
                    clause.span,
                );
            }
        } else {
            self.check_required_edges(&fields, root.as_ref(), &root_description, &parents, handle.as_ref(), target_span);
            self.check_required_fields(&fields, root.as_ref(), &root_description, &parents, target_span);
            if write.bind.is_none() {
                self.check_identity(&write.unique_by, root.as_ref(), &root_description, scope, local);
            }
        }

        let written_edges: Option<Vec<String>> =
            handle.as_ref().and_then(position_schema_of_ref).map(|schema| schema.edges.keys().cloned().collect());
        let mut omittable = 0;
        for field in &fields {
            let target_type = root.as_ref().and_then(|r| r.fields.get(&field.name)).map(Ty::from_schema);
            if let Some(root) = &root
                && target_type.is_none()
            {
                let available: Vec<&str> = root.fields.keys().map(String::as_str).collect();
                let mut message = format!("{root_description} has no field '{}'", field.name);
                if !available.is_empty() {
                    message.push_str(&format!(" — it has: {}", available.join(", ")));
                }
                if let Some(spread) = &field.spread {
                    message.push_str(&format!(
                        " ('...{spread}' writes every field of '{spread}', '{}' included — write the fields that belong here one per line instead)",
                        field.name
                    ));
                }
                self.report(codes::WRITE_UNKNOWN_FIELD, message, field.span);
            }
            if matches!(field.semantics, Some(FieldWriteMode::Append | FieldWriteMode::AppendMissing))
                && let Some(target) = &target_type
                && !is_list(Some(strip_absent(target)))
            {
                let op = if field.semantics == Some(FieldWriteMode::Append) { "+:" } else { "+?:" };
                self.report(
                    codes::WRITE_APPEND_NOT_MULTI,
                    format!(
                        "'{}' on {root_description} is {}, not a list — '{op}' (append) applies only to multi-valued fields. Use ':' to set it, or '?:' to set it only when empty",
                        field.name,
                        describe_field_type(target)
                    ),
                    field.span,
                );
            }
            let relationship = written_edges.as_ref().is_some_and(|edges| edges.contains(&field.name));
            if relationship && let Some(handle_name) = self.bare_handle_name(&field.value, scope) {
                self.report_with(
                    codes::WRITE_LINK_FIELD_NUDGE,
                    format!(
                        "'{}' is a relationship of {root_description} — rather than assigning the handle '{handle_name}' to a field, establish the connection structurally: put the parent in the write target (a linked or tuple-path write) or assert it afterwards with a link statement",
                        field.name
                    ),
                    field.span,
                    Severity::Info,
                );
            }
            let path = root_description.contains('.').then(|| format!("{root_description}.{}", field.name));
            let (value_type, held) = self.write_field_value(&field.value, scope, target_type.as_ref(), path);
            // Against a target the walk typed, or a linked one it refused
            // (a maybe-empty parent): the TypeScript holds every field to it.
            // Not against a node this run built that the walk could not
            // type: it may declare the field maybe-absent itself.
            if (root.is_some() || (matches!(write.target, WriteTarget::Linked { .. }) && !local))
                && is_maybe_absent(value_type.as_ref())
                && field.semantics != Some(FieldWriteMode::Fill)
                && !is_maybe_absent(target_type.as_ref())
            {
                let may_leave_unset = matches!(write.target, WriteTarget::Position { .. })
                    || !root.as_ref().and_then(|r| r.required_fields.as_ref()).is_some_and(|r| r.contains(&field.name));
                let identifies = field.spread.is_none()
                    && write.unique_by.iter().any(|clause| identity::unique_clause_refs(clause).is_some_and(|refs| refs.contains(&field.name)));
                let entry = FieldEntry { name: field.name.clone(), value: field.value.clone().into_owned(), semantics: field.semantics, span: field.span };
                if let Some(diagnostic) = crate::families::values::write_field_absence(crate::families::values::WriteFieldAbsence {
                    field: &entry,
                    spread: field.spread.as_deref(),
                    target_type: target_type.as_ref(),
                    value_type: value_type.as_ref(),
                    root_description: &root_description,
                    may_leave_unset,
                    identifies,
                }) {
                    self.push(diagnostic);
                }
            }
            if field.semantics == Some(FieldWriteMode::Fill) && is_maybe_absent(value_type.as_ref()) {
                omittable += 1;
            }
            self.report_blankable_identity_key(&write.unique_by, field, value_type.as_ref(), &root_description, scope);
            self.report_field_value_type(
                &field.name,
                &root_description,
                target_type.as_ref(),
                value_type.as_ref(),
                field.value.span,
                FieldFit { relationship, declared: declared_target, held: held.as_ref() },
            );
            self.check_enum_literal_write(&field.value, target_type.as_ref(), &format!("'{}' on {root_description}", field.name));
        }
        if !fields.is_empty() && omittable == fields.len() {
            self.report_with(
                codes::WRITE_MAY_BE_EMPTY,
                format!(
                    "every field of this write to {root_description} is a '?:' fill of a possibly-absent value, so at runtime they can all be omitted and the write reaches the system empty. Gate the write on presence instead (e.g. 'r-[x:…]-> {{ write … }}'), so it only runs when there's something to write."
                ),
                target_span,
                Severity::Warning,
            );
        }
        if position_write && !local { self.position_write_result(handle, root.as_ref()) } else { handle }
    }

    /// `refuseShapeWrite`: a write rooted at a node declaration.
    fn refuse_shape_write(&mut self, write: &WriteExpression, fields: &[Field], scope: ScopeId) -> bool {
        let roots: Vec<&str> = match &write.target {
            WriteTarget::Linked { path, .. } => path_root_name(path).into_iter().collect(),
            WriteTarget::Tuple { paths, .. } => paths.iter().filter_map(path_root_name).collect(),
            WriteTarget::Position { .. } => Vec::new(),
        };
        let Some(shape_root) = roots.into_iter().find(|root| {
            matches!(self.scopes.resolve(scope, root), Resolution::Found(id) if self.scopes.symbol(id).kind == SymbolKind::Shape)
        }) else {
            return false;
        };
        let entries: Vec<String> = fields.iter().map(|f| format!("{}: …", f.name)).collect();
        let entries = if entries.is_empty() { "…".to_string() } else { entries.join(", ") };
        self.report(
            codes::WRITE_SHAPE_RETIRED,
            format!(
                "'{shape_root}' is a declared node — the structure a parameter is checked against, not a system that stores anything, so this write has nowhere to land. Synthesise the record instead: 'node {{ {entries} }}' — the same entries, and it can carry what a write to a declaration never could: a nested 'node {{ … }}' for a related record, or a traversal off a position you hold ('files: lazy a-[f:…]->') to pass real records through untouched. Keep the declaration if the callee's parameter names it"
            ),
            write.span,
        );
        true
    }

    /// `expandWriteSpreads` with `spreadFields`: the lines each spread stands for.
    fn expand_write_spreads<'w>(&mut self, write: &'w WriteExpression, scope: ScopeId) -> Vec<Field<'w>> {
        let Some(spreads) = &write.spreads else { return Vec::new() };
        if spreads.is_empty() {
            return Vec::new();
        }
        let fields_of: Vec<Option<Vec<String>>> = spreads.iter().map(|spread| self.spread_fields(spread, scope)).collect();
        let mut written: std::collections::HashSet<String> = write.fields.iter().map(|f| f.name.clone()).collect();
        let mut expanded: Vec<Field> = Vec::new();
        for (spread, names) in spreads.iter().zip(fields_of).rev() {
            let mut lines = Vec::new();
            for name in names.unwrap_or_default() {
                if !written.insert(name.clone()) {
                    continue;
                }
                let source = if spread.path.is_some() { spread.source.clone() } else { spell_name(&spread.source) };
                lines.push(Field {
                    value: std::borrow::Cow::Owned(movement_parser::ast::ExprSlot::plain(format!("{source}.{}", spell_name(&name)), spread.span)),
                    name,
                    semantics: spread.semantics,
                    spread: Some(spread.source.clone()),
                    span: spread.span,
                });
            }
            expanded.splice(0..0, lines);
        }
        expanded
    }

    /// `spreadFields`: the fields `...e` writes, where the program spells
    /// them out; `MOV_WRITE_SPREAD_SOURCE` where it does not.
    fn spread_fields(&mut self, spread: &WriteSpread, scope: ScopeId) -> Option<Vec<String>> {
        let root = spread.path.as_ref().map_or(spread.source.as_str(), |p| p.root.as_str());
        let Resolution::Found(id) = self.scopes.resolve(scope, root) else { return None };
        let (types, kind) = if spread.path.is_some() {
            let slot = movement_parser::ast::ExprSlot::plain(spread.source.clone(), spread.span);
            let field = self.type_of_slot(&slot, scope).and_then(|(_, ty, _)| ty);
            (SymbolTypes { field, ..SymbolTypes::default() }, SymbolKind::Binding)
        } else {
            let symbol = self.scopes.symbol(id);
            (symbol.types.clone(), symbol.kind)
        };
        let position = match &types.pos {
            Some(pos) => Some(pos.clone()),
            None => match types.field.as_ref().map(strip_absent) {
                Some(Ty::Record(Some(position))) => Some((**position).clone()),
                _ => None,
            },
        };
        if let Some(position) = &position
            && let Some(fields) = known_fields_of(position)
        {
            crate::types::position::note_fields_needed(Some(position), || format!("writes every field of it with '...{}' (line {})", spread.source, spread.span.start.line));
            return Some(fields);
        }
        // A declared extract node's fields are its declaration's (the nodes
        // family's shapeToSchema), unknown here rather than absent.
        if let Some(Position::Extract { node, .. }) = position.as_ref().map(|p| match p {
            Position::MaybeEmpty(of) => &**of,
            other => other,
        }) && node.declared
        {
            return None;
        }
        // Only a name the type core typed can be said to be something else.
        let what = match &position {
            Some(position) => {
                let system = if crate::types::position::instance_of_ref(Some(position)).is_some() {
                    ", whose fields are the system's to say, not this program's"
                } else {
                    ""
                };
                format!("{}{system}", describe_position(position))
            }
            None if types.field.is_some() || kind != SymbolKind::Binding && kind != SymbolKind::Param && kind != SymbolKind::Alias => {
                kind.describe().to_string()
            }
            None => return None,
        };
        self.report(
            codes::WRITE_SPREAD_SOURCE,
            format!(
                "'...{}' writes every field of a record whose fields this program spells out — an extracted record, a declared structure, or a 'node {{ … }}' — and '{}' is {what}. Write the fields it should carry one per line ('name: {}.name')",
                spread.source, spread.source, spread.source
            ),
            spread.span,
        );
        None
    }

    // ── targets ──

    /// `checkLinkedPath`: a path's destination, for a write or a match.
    #[allow(clippy::too_many_arguments)]
    pub fn linked_target(
        &mut self,
        path: &PathHead,
        explicit_type: Option<&str>,
        span: Span,
        purpose: Purpose,
        is_bound: bool,
        bind_name: Option<&str>,
        scope: ScopeId,
    ) -> Landing {
        let root_name = path_root_name(path);
        let Some((Some(root_type), steps)) = self.head_walk(path, scope) else { return Landing::default() };
        if steps.is_empty() {
            return Landing::default();
        }
        if let (Position::MaybeEmpty(of), Some(root_name)) = (&root_type, root_name) {
            self.report(
                codes::ABSENT_REQUIRED,
                format!(
                    "'{root_name}' is {} that may not be there, so a {} off it can't be guaranteed to happen — and nothing in this statement says it might be skipped. Test it first ('if {root_name} == null {{ ERROR(\"…\") }}', or 'if EXISTS({root_name})'), or gate on it with a traversal block ('{root_name}-[x:…]-> {{ … }}'), which runs zero times when it's empty.",
                    describe_position(of),
                    purpose.word()
                ),
                span,
            );
            return Landing::default();
        }
        for step in &steps[..steps.len() - 1] {
            if let TraversalStep::Edge(edge) = step
                && edge.expression_filter.is_some()
            {
                let word = purpose.word();
                self.report(
                    codes::TARGET_WHERE_NOT_FINAL,
                    format!(
                        "the WHERE on '-[:{}]->' narrows a hop the {word} only passes through — a {word} target's WHERE goes on its final hop, where it says which existing records may be matched ('{word} parent-[x:Edge WHERE …]-> {{ … }}')",
                        edge.edge_type_id
                    ),
                    span,
                );
            }
        }
        let (parent, parent_locals) = {
            let env = self.typing_env(scope);
            let mut typing = Typing::new(&env, self.version, span);
            let parent = typing.walk_steps(Some(root_type), &steps[..steps.len() - 1], false);
            (parent, typing.locals)
        };
        let Some(parent) = parent else { return Landing::default() };
        let TraversalStep::Edge(link_step) = &steps[steps.len() - 1] else { return Landing::default() };
        let edge_name = link_step.edge_type_id.clone();

        if let Position::Local(local) = &parent {
            let subject = if steps.len() == 1 { root_name } else { None };
            if link_step.expression_filter.is_some() {
                self.report(
                    codes::TARGET_WHERE_LOCAL,
                    format!("'{edge_name}' is an edge of a node this run built, and its landings take no WHERE — say which one you mean in 'unique by (…)' instead"),
                    span,
                );
            }
            return self.local_write_target(local, &edge_name, span, subject);
        }

        let parent_schema: Option<PositionSchema> = position_schema_of_ref(&parent).map(|s| s.into_owned()).or_else(|| match &parent {
            Position::Handle(HandlePosition { edges: Some(edges), .. }) => Some(PositionSchema { edges: edges.clone(), ..empty_position_schema() }),
            _ => None,
        });
        let instance = match &parent {
            Position::Meta { instance } => {
                if let Some(root) = root_name
                    && let Resolution::Found(id) = self.scopes.resolve(scope, root)
                    && !matches!(self.scopes.symbol(id).kind, SymbolKind::Instance | SymbolKind::Shape)
                {
                    let what = self.scopes.symbol(id).kind.describe();
                    let form = if purpose == Purpose::Write { "linked write" } else { "match" };
                    self.report(
                        codes::WRITE_TARGET_NOT_GRAPH,
                        format!(
                            "'{root}' is {what} standing for a whole system, not a record — a {form} starts from a record handle or the instance's own edge: construct the instance in this file — instances don't pass between movements"
                        ),
                        span,
                    );
                    return Landing::default();
                }
                instance.clone()
            }
            Position::Position(p) if parent_schema.is_some() => p.instance.clone(),
            Position::Handle(h) if parent_schema.is_some() => h.instance.clone(),
            _ => return Landing::default(),
        };
        let Some(parent_schema) = parent_schema else { return Landing::default() };

        let Some(edge) = parent_schema.edges.get(&edge_name).cloned() else {
            if surface_not_enumerated(&parent_schema) {
                return Landing::default();
            }
            if edge_name.starts_with('#') && self.version >= 5 {
                return Landing::default();
            }
            let available: Vec<&str> = parent_schema.edges.keys().map(String::as_str).collect();
            let why = if purpose == Purpose::Write {
                "a linked write creates the record AND the edge, so the parent's type must declare it"
            } else {
                "a match looks along an edge the parent's type declares"
            };
            let declares = if available.is_empty() { String::new() } else { format!("; it declares: {}", available.join(", ")) };
            self.report(codes::LINKED_UNKNOWN_EDGE, format!("{} has no edge '{edge_name}' — {why}{declares}", describe_position(&parent)), span);
            return Landing::default();
        };

        if purpose == Purpose::Write && edge.writable != Some(true) {
            let available: Vec<String> = writable_edges_of(&instance).into_iter().map(|(parent, edge)| format!("{parent}-[:{edge}]->")).collect();
            let target_schema = instance.schema.positions.get(&edge.target);
            let cause = if target_schema.is_none_or(|s| s.undescribed == Some(true)) {
                format!("nothing has described '{}' yet, so its writable fields aren't known here", edge.target)
            } else if target_schema.is_some_and(|s| s.properties.is_empty()) {
                format!("'{}' has no fields to write", edge.target)
            } else {
                format!("'{}' fills it itself", instance.name)
            };
            let writes_along =
                if available.is_empty() { String::new() } else { format!("; '{}' writes along: {}", instance.name, available.join(", ")) };
            self.report(
                codes::WRITE_READ_ONLY_EDGE,
                format!(
                    "'-[:{edge_name}]->' is read-only on {} — {cause}, so a {} can't create or attach along it{writes_along}",
                    describe_position(&parent),
                    purpose.word()
                ),
                span,
            );
            return Landing::default();
        }

        if edge.ephemeral == Some(true) && purpose == Purpose::Write && is_bound {
            self.report(
                codes::WRITE_EPHEMERAL_BOUND,
                format!("nothing to bind — 'write …-[:{edge_name}]->' is an action, not a record; drop the binding and write it as a bare statement"),
                span,
            );
        }

        let written = if edge.polymorphic == Some(true) {
            let Some(explicit) = explicit_type else {
                let what = if purpose == Purpose::Write { "write creates" } else { "match finds" };
                self.report(
                    codes::LINKED_NEEDS_TYPE,
                    format!("'{edge_name}' is polymorphic — say which type this {what}: {} …-[:{edge_name}]-><type> {{ … }}", purpose.word()),
                    span,
                );
                return Landing::default();
            };
            let variants = instance.schema.unions.as_ref().and_then(|u| u.get(&edge.target));
            let fits = match variants {
                Some(variants) => variants.iter().any(|v| v == explicit),
                None => instance.schema.positions.contains_key(explicit),
            };
            if !fits {
                let message = match variants {
                    Some(variants) => {
                        let shown = instance
                            .schema
                            .union_display_names
                            .as_ref()
                            .and_then(|names| names.get(&edge.target).cloned())
                            .unwrap_or_else(|| edge.target.clone());
                        format!("'{edge_name}' targets {shown} ({}) — '{explicit}' is not one of its types", variants.join(" | "))
                    }
                    None => format!("'{}' has no position type '{explicit}'", instance.name),
                };
                self.report(codes::LINKED_TYPE_MISMATCH, message, span);
                return Landing::default();
            }
            explicit.to_string()
        } else {
            if let Some(explicit) = explicit_type
                && explicit != edge.target
            {
                self.report(
                    codes::LINKED_TYPE_MISMATCH,
                    format!("'{edge_name}' targets {}.{} — the explicit type '{explicit}' contradicts it", instance.name, edge.target),
                    span,
                );
                return Landing::default();
            }
            match &parent {
                Position::Handle(h) => h.generic_landings.as_ref().and_then(|g| g.get(&edge_name).cloned()).unwrap_or_else(|| edge.target.clone()),
                _ => edge.target.clone(),
            }
        };

        if link_step.expression_filter.is_some()
            && let Some(bind) = bind_name
            && self.version < 5
        {
            self.report(
                codes::TARGET_WHERE_BIND,
                format!(
                    "a WHERE on the target and 'bind {bind}' don't combine — a bound write's identity IS the binding, so there are no candidates for the WHERE to narrow. Drop the WHERE, or the 'bind' to find the record by 'unique by (…)'"
                ),
                span,
            );
        }

        // The final hop's WHERE narrows the identity candidates — each read
        // as the record it is, so it types like a read hop's WHERE at the
        // type the target lands on (`typeTargetFilter`).
        if let Some(filter) = &link_step.expression_filter {
            let landing = crate::types::position::position_ref_in(&instance, &written);
            let diagnostics = {
                let env = self.typing_env(scope);
                let mut typing = Typing::new(&env, self.version, span);
                typing.locals = parent_locals;
                if let Some(alias) = &link_step.alias {
                    typing.locals.insert(alias.clone(), landing.clone());
                }
                typing.infer_at(filter, landing.as_ref());
                (typing.diagnostics, typing.receipt_reads)
            };
            self.push_typed(diagnostics, scope);
        }

        let root = instance
            .schema
            .writable_roots
            .get(&written)
            .cloned()
            .or_else(|| instance.schema.create_shapes.as_ref().and_then(|c| c.get(&written).cloned()))
            .or_else(|| if purpose == Purpose::Match { readable_match_root(instance.schema.positions.get(&written)) } else { None });
        let result_shape: Vec<(String, Ty)> = match &root {
            Some(root) => root.result_shape.iter().map(|(k, v)| (k.clone(), Ty::from_schema(v))).collect(),
            None => instance
                .schema
                .positions
                .get(&written)
                .map(|p| p.properties.iter().map(|(k, v)| (k.clone(), Ty::from_schema(v))).collect())
                .unwrap_or_default(),
        };
        let result_shape = if purpose == Purpose::Write { self.write_result_shape(result_shape) } else { result_shape };
        let handle = Position::Handle(HandlePosition {
            instance: instance.clone(),
            position: instance.schema.positions.contains_key(&written).then(|| written.clone()),
            result_shape: result_shape.into_iter().collect(),
            edges: root.as_ref().and_then(|r| r.edges.clone()),
            generic_landings: None,
            written: purpose == Purpose::Write,
            set_fields: None,
            identity: Default::default(),
        });
        let parent_type = match &parent {
            Position::Position(p) => Some(p.position.clone()),
            Position::Handle(h) => h.position.clone(),
            _ => None,
        };
        Landing {
            root,
            handle: Some(handle),
            description: Some(format!("{}.{written}", instance.name)),
            local: false,
            declared: false,
            resolved: Some(Resolved { instance, written, parent_type, edge_name }),
        }
    }

    /// `localWriteTarget`: a write into an edge of a node this run built. The
    /// handle is a local node with the whole of what the landing type
    /// declares: its fields, and (for a declared node) its nested nodes.
    fn local_write_target(&mut self, from: &crate::types::position::LocalNode, edge_name: &str, span: Span, subject: Option<&str>) -> Landing {
        let Some(edge) = from.edges.as_ref().and_then(|e| e.get(edge_name)) else {
            self.report_undeclared_local_edge(from, edge_name, span, subject);
            return Landing { local: true, ..Landing::default() };
        };
        if edge.deferred {
            self.report(
                codes::NODE_EDGE_DEFERRED,
                format!(
                    "'{edge_name}' is a lazy entry — its landings come from a walk that runs again at every read, so a written one would be gone by the next. Declare a separate edge for what this run writes ('{edge_name}Written: <SomeNode>')"
                ),
                span,
            );
            return Landing { local: true, ..Landing::default() };
        }
        let description = format!("'{edge_name}' on {} this run built", from.label);
        let (Some(landing), Some(schema)) = (edge.target.as_ref(), edge.target.as_ref().and_then(position_schema_of_ref).map(|s| s.into_owned())) else {
            return Landing { local: true, description: Some(description), ..Landing::default() };
        };
        let instance = crate::types::position::instance_of_ref(Some(landing));
        let declared = instance.is_some_and(|i| i.declared.is_some());
        let nested = if edge.structural { instance.and_then(|i| nested_local_edges(i, &schema)) } else { None };
        let root = WritableRootSchema {
            fields: schema.properties.clone(),
            result_shape: schema.properties.clone(),
            fuzzy_resolution: Some(movement_parser::catalog::types::FuzzyResolution::All(true)),
            ..empty_writable_root()
        };
        let handle = Position::Local(crate::types::position::LocalNode {
            label: format!("a '{edge_name}' landing"),
            reads: schema.properties.iter().map(|(k, v)| (k.clone(), Some(Ty::from_schema(v)))).collect(),
            edges: nested,
            run_built: Some(Box::new(landing.clone())),
            extracted: None,
        });
        Landing { local: true, declared, description: Some(description), root: Some(root), handle: Some(handle), ..Landing::default() }
    }

    /// `checkTupleWriteTarget`: every path resolves as a linked one does, and
    /// all of them land on one written type.
    #[allow(clippy::too_many_arguments)]
    fn tuple_target(
        &mut self,
        paths: &[PathHead],
        explicit_type: Option<&str>,
        span: Span,
        parents: &mut Vec<Parent>,
        purpose: Purpose,
        is_bound: bool,
        bind_name: Option<&str>,
        scope: ScopeId,
    ) -> Landing {
        let mut agreed: Option<(Landing, usize)> = None;
        let mut mismatched = false;
        for (i, path) in paths.iter().enumerate() {
            let mut linked = self.linked_target(path, explicit_type, path.span, purpose, is_bound, bind_name, scope);
            let Some(resolved) = linked.resolved.take() else { continue };
            parents.push(Parent { type_: resolved.parent_type.clone(), edge: resolved.edge_name.clone() });
            match &agreed {
                None => {
                    linked.resolved = Some(resolved);
                    agreed = Some((linked, i));
                }
                Some((first, index)) => {
                    let first_resolved = first.resolved.as_ref().unwrap_or_else(|| unreachable!("agreed paths are resolved"));
                    let same = std::rc::Rc::ptr_eq(&first_resolved.instance, &resolved.instance) && first_resolved.written == resolved.written;
                    if !same && !mismatched {
                        mismatched = true;
                        self.report(
                            codes::WRITE_TUPLE_MISMATCH,
                            format!(
                                "the tuple's paths must converge on ONE written type — '{}' infers {}, but '{}' infers {}",
                                raw_path(&paths[*index]),
                                first.description.clone().unwrap_or_else(|| first_resolved.written.clone()),
                                raw_path(path),
                                linked.description.clone().unwrap_or_else(|| resolved.written.clone())
                            ),
                            span,
                        );
                    }
                }
            }
        }
        match agreed {
            Some((landing, _)) if !mismatched => Landing { resolved: None, ..landing },
            _ => Landing::default(),
        }
    }

    /// `checkPositionWriteTarget`: `write a { … }`, an update of a record in hand.
    fn position_target(&mut self, root: &PathRoot, span: Span, scope: ScopeId) -> Landing {
        let (alias, record) = match root {
            PathRoot::Name { name } => {
                let Some(record) = self.record_of_name(name, scope) else {
                    return Landing { description: Some(format!("'{name}'")), ..Landing::default() };
                };
                (name.clone(), record)
            }
            PathRoot::Expression { expr } => {
                let Some(alias) = member_path_binding_name(&expr.raw) else {
                    return Landing { description: Some(format!("'{}'", expr.raw)), ..Landing::default() };
                };
                let field = self.type_of_slot(expr, scope).and_then(|(_, ty, _)| ty);
                (alias, record_of(&SymbolTypes { field, ..SymbolTypes::default() }, SymbolKind::Binding))
            }
        };
        let described = Landing { description: Some(format!("'{alias}'")), ..Landing::default() };
        let position = match record {
            RecordOf::Value(what) => {
                self.report(
                    codes::WRITE_POSITION_NOT_RECORD,
                    format!(
                        "'{alias}' is {what} — 'write {alias} {{ … }}' updates an already-identified record in place, so it needs a record: a traversal alias, a prior write result, or a record picked from either"
                    ),
                    span,
                );
                return described;
            }
            RecordOf::Unknown => return described,
            RecordOf::Record(position) => position,
        };
        // A record the run holds on one of its own edges: the run's graph is
        // its system, and that system updates by id. What it may set is what
        // it carries — the landing type IS the write shape, as for the write
        // that put it there.
        if let Some(run_built) = run_built_write_shape(&position) {
            let root = WritableRootSchema { fields: run_built.fields.clone(), result_shape: run_built.fields, ..empty_writable_root() };
            return Landing {
                root: Some(root),
                description: Some(format!("'{alias}' ({} this run built)", describe_position(&position))),
                handle: Some(position),
                local: true,
                declared: run_built.declared,
                resolved: None,
            };
        }
        let instance = match &position {
            Position::Position(p) => p.instance.clone(),
            Position::Handle(h) => h.instance.clone(),
            Position::Union(u) => u.instance.clone(),
            // A record that may be empty is told only where no guard proves
            // it there, which the walk does not yet track for every guard
            // (`IS`); an extraction's result is the extraction family's.
            Position::Extract { .. } | Position::MaybeEmpty(_) => return described,
            other => {
                self.report(
                    codes::WRITE_POSITION_NOT_RECORD,
                    format!(
                        "'{alias}' is {} — 'write {alias} {{ … }}' updates an already-identified record in place, so it needs a record position: a traversal alias or a prior write result",
                        describe_position(other)
                    ),
                    span,
                );
                return described;
            }
        };
        if instance.schema.supports_in_place_update != Some(true) {
            self.report(
                codes::WRITE_POSITION_NO_UPDATE,
                format!(
                    "'{}' can't update records in place — its system has no update-by-id. To change {}, create a new record (a graph-root, linked, or tuple-path write) instead of 'write {alias} {{ … }}'",
                    instance.name,
                    describe_position(&position)
                ),
                span,
            );
            return Landing { description: Some(describe_position(&position)), ..Landing::default() };
        }
        let record_type = match &position {
            Position::Union(u) => Some(u.union.clone()),
            Position::Position(p) => Some(p.position.clone()),
            Position::Handle(h) => h.position.clone(),
            _ => None,
        };
        let root = record_type.and_then(|t| instance.schema.writable_roots.get(&t).cloned());
        Landing { root, description: Some(describe_position(&position)), handle: Some(position), ..Landing::default() }
    }

    // ── shape of the write ──

    /// `selectWriteVariant`: a discriminated shape's variant, by the body's literal.
    fn select_write_variant(&mut self, root: Option<WritableRootSchema>, fields: &[Field], description: &str) -> Selected {
        let unchanged = |root| Selected { root, description: description.to_string(), variant: None };
        let Some(discriminated) = root.as_ref().and_then(|r| r.discriminated.clone()) else { return unchanged(root) };
        let Some(field) = fields.iter().find(|f| f.name == discriminated.discriminant) else { return unchanged(root) };
        let Some(literal) = static_string_literal_of(&field.value) else {
            let example = discriminated.variants.keys().next().cloned().unwrap_or_else(|| "…".to_string());
            self.report(
                codes::WRITE_DISCRIMINANT_NOT_LITERAL,
                format!(
                    "'{}' selects what {description} can carry, so it must be a fixed value known here — name it with a literal (e.g. {}: \"{example}\"), not an expression. A create names its target; it can't discover the shape at run time",
                    discriminated.discriminant, discriminated.discriminant
                ),
                field.value.span,
            );
            return unchanged(root);
        };
        let Some(variant) = discriminated.variants.get(&literal).cloned() else { return unchanged(root) };
        Selected {
            root: Some(variant.clone()),
            description: format!("{description} ({}: \"{literal}\")", discriminated.discriminant),
            variant: Some(variant),
        }
    }

    /// `handleOfVariant`: the handle stands on the variant's own type.
    fn handle_of_variant(&self, handle: Option<Position>, variant: &WritableRootSchema) -> Option<Position> {
        let Some(Position::Handle(mut handle)) = handle else { return handle };
        if let Some(position) = &variant.position
            && handle.instance.schema.positions.contains_key(position)
        {
            handle.position = Some(position.clone());
        }
        let shape: Vec<(String, Ty)> = variant.result_shape.iter().map(|(k, v)| (k.clone(), Ty::from_schema(v))).collect();
        let shape = if handle.written { self.write_result_shape(shape) } else { shape };
        handle.result_shape = shape.into_iter().collect();
        if let Some(edges) = &variant.edges {
            handle.edges = Some(edges.clone());
        }
        Some(Position::Handle(handle))
    }

    /// `writeResultShape`: before 4 a write's handle also read `created` and `committed`.
    fn write_result_shape(&self, shape: Vec<(String, Ty)>) -> Vec<(String, Ty)> {
        if self.version >= 4 {
            return shape;
        }
        let mut out = vec![("created".to_string(), Ty::Boolean), ("committed".to_string(), Ty::Boolean)];
        for (key, ty) in shape {
            match out.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) => slot.1 = ty,
                None => out.push((key, ty)),
            }
        }
        out
    }

    /// `checkWriteUnion`: an untagged write union — the body's declared
    /// fields must all belong to one variant.
    fn check_write_union(&mut self, write: &WriteExpression, fields: &[Field], root: Option<&WritableRootSchema>, description: &str) {
        let Some(root) = root else { return };
        let Some(union) = &root.write_union else { return };
        if union.variants.is_empty() {
            return;
        }
        let mut authored: Vec<&str> = Vec::new();
        for field in fields {
            if root.fields.contains_key(&field.name) && !authored.contains(&field.name.as_str()) {
                authored.push(&field.name);
            }
        }
        if union.variants.iter().any(|v| authored.iter().all(|n| v.fields.iter().any(|f| f == n))) {
            return;
        }
        let forcing: std::collections::HashSet<&str> =
            union.variants.iter().flat_map(|v| authored.iter().filter(|n| !v.fields.iter().any(|f| f == *n)).copied()).collect();
        let conflict: Vec<String> = authored.iter().filter(|n| forcing.contains(*n)).map(|n| n.to_string()).collect();
        let shapes: Vec<String> = union.variants.iter().map(|v| format!("{} ({})", v.name, v.fields.join(", "))).collect();
        self.report(
            codes::WRITE_UNION_UNSATISFIED,
            format!(
                "{description} is either {} — {}. Set the fields of one shape only, or split this into separate writes",
                join_list(&shapes, "or"),
                write_union_clash(&conflict)
            ),
            target_span(&write.target),
        );
    }

    /// `applyGenericLandings`: the body's literals fix what a generic edge lands on.
    fn apply_generic_landings(&mut self, handle: Option<Position>, fields: &[Field], root: Option<&WritableRootSchema>, description: &str) -> Option<Position> {
        let Some(Position::Handle(mut handle_position)) = handle else { return handle };
        let edges = match handle_position.edges.clone() {
            Some(edges) => edges,
            None => match handle_position.position.as_ref().and_then(|p| handle_position.instance.schema.positions.get(p)) {
                Some(schema) => schema.edges.clone(),
                None => return Some(Position::Handle(handle_position)),
            },
        };
        let mut landings = indexmap::IndexMap::new();
        for (edge_name, edge_schema) in edges.iter() {
            let Some(generic) = &edge_schema.generic_over else { continue };
            let Some(field) = fields.iter().find(|f| f.name == generic.field) else { continue };
            let Some(values) = literal_string_values_of(&field.value.raw) else {
                let example = literal_example_for(&generic.field, root.and_then(|r| r.fields.get(&generic.field)));
                use movement_parser::catalog::types::OnNonLiteral;
                match generic.on_non_literal {
                    Some(OnNonLiteral::Error) => self.report(
                        codes::WRITE_GENERIC_NOT_LITERAL,
                        format!(
                            "'{}' fixes the type of what '-[:{edge_name}]->' delivers on {description}, so it must be a fixed value known here — name it with a literal{example}, not an expression. The type is decided when the record is written; it can't be discovered at run time",
                            generic.field
                        ),
                        field.value.span,
                    ),
                    Some(OnNonLiteral::Warn) => self.report_with(
                        codes::WRITE_GENERIC_UNTYPED,
                        format!(
                            "'{}' is built at run time, so what '-[:{edge_name}]->' delivers on {description} cannot be typed here — it stays one opaque value you cannot read a part out of. Name '{}' with a literal{example} to read the answer back by name",
                            generic.field, generic.field
                        ),
                        field.value.span,
                        Severity::Warning,
                    ),
                    _ => {}
                }
                continue;
            };
            let key = generic_landing_key(&edge_schema.target, &values);
            if let Some(landed) = handle_position.instance.schema.generic_landings.as_ref().and_then(|g| g.get(&key))
                && handle_position.instance.schema.positions.contains_key(landed)
            {
                landings.insert(edge_name.clone(), landed.clone());
            }
        }
        if !landings.is_empty() {
            handle_position.generic_landings = Some(landings);
        }
        Some(Position::Handle(handle_position))
    }

    /// `checkBindClause`: a write's `bind` counterpart.
    fn check_bind_clause(&mut self, write: &WriteExpression, scope: ScopeId, target: Option<&Position>) {
        let Some(bind) = &write.bind else { return };
        if self.version >= 5 {
            self.report(codes::WRITE_BIND_RETIRED, write_bind_retired_message(&bind.name), bind.span);
            return;
        }
        if let WriteTarget::Position { root, .. } = &write.target {
            self.report(
                codes::WRITE_BIND_POSITION,
                format!(
                    "'bind' has no meaning on a position write — 'write {} {{ … }}' already holds the exact record, so there is no counterpart to establish. Drop the 'bind {}'",
                    spell_path_root(root),
                    bind.name
                ),
                bind.span,
            );
            return;
        }
        if let Some(instance) = crate::types::position::instance_of_ref(target)
            && !matches!(target, Some(Position::MaybeEmpty(_)))
            && instance.schema.supports_in_place_update != Some(true)
        {
            self.report(
                codes::WRITE_BIND_NO_UPDATE,
                format!(
                    "'{}' can't update records in place — but a 'bind' write re-fires as an update when '{}' recurs, so the target needs update-by-id. Drop the 'bind {}' (a plain create/append), or bind to a system that supports updates",
                    instance.name, bind.name, bind.name
                ),
                bind.span,
            );
            return;
        }
        if let Some(clause) = write.unique_by.first() {
            self.report(
                codes::WRITE_BIND_UNIQUE,
                format!(
                    "'unique by' and 'bind {}' don't combine — a bound write's identity IS the binding, so field uniqueness has no role. Drop the 'unique by' clause (it applies only to writes without a bind)",
                    bind.name
                ),
                clause.span,
            );
        }
        let not_record = |what: String| {
            format!(
                "'{}' is {what} — 'bind' names the counterpart RECORD this write corresponds to, so it needs a record position: a traversal alias, a prior write result, or the event position",
                bind.name
            )
        };
        match self.record_of_name(&bind.name, scope) {
            Some(RecordOf::Value(what)) => self.report(codes::WRITE_BIND_NOT_RECORD, not_record(what), bind.span),
            Some(RecordOf::Record(position))
                if !matches!(position, Position::Position(_) | Position::Handle(_) | Position::Union(_) | Position::Local(_) | Position::Extract { .. }) =>
            {
                self.report(codes::WRITE_BIND_NOT_RECORD, not_record(describe_position(&position)), bind.span);
            }
            _ => {}
        }
    }

    /// `checkRequiredEdges`: every required edge the written type declares
    /// is established by a parent of the target, or a body field of its name.
    fn check_required_edges(&mut self, fields: &[Field], root: Option<&WritableRootSchema>, description: &str, parents: &[Parent], handle: Option<&Position>, span: Span) {
        let Some(required) = root.and_then(|r| r.required_edges.as_ref()) else { return };
        if required.is_empty() {
            return;
        }
        let schema = match handle {
            Some(Position::Handle(h)) => Some(h.instance.schema.clone()),
            Some(Position::Position(p)) => Some(p.instance.schema.clone()),
            Some(Position::Union(u)) => Some(u.instance.schema.clone()),
            Some(Position::Meta { instance }) => Some(instance.schema.clone()),
            _ => None,
        };
        let is_from = |parent_type: &str, from: &str| {
            parent_type == from || schema.as_ref().and_then(|s| s.unions.as_ref()).and_then(|u| u.get(from)).is_some_and(|members| members.iter().any(|m| m == parent_type))
        };
        let from_display = |from: &str| {
            schema.as_ref().and_then(|s| s.union_display_names.as_ref()).and_then(|n| n.get(from).cloned()).unwrap_or_else(|| from.to_string())
        };
        let missing: Vec<_> = required
            .iter()
            .filter(|entry| {
                !parents.iter().any(|p| match &p.type_ {
                    Some(t) => is_from(t, &entry.from),
                    None => p.edge == entry.edge,
                }) && !fields.iter().any(|f| f.name == entry.edge)
            })
            .collect();
        if missing.is_empty() {
            return;
        }
        let described: Vec<String> = missing.iter().map(|m| format!("'{}' (a {} parent)", m.edge, from_display(&m.from))).collect();
        let spelling: Vec<String> = missing.iter().map(|m| format!("<{} handle>-[:{}]->", from_display(&m.from), m.edge)).collect();
        self.report(
            codes::WRITE_MISSING_REQUIRED_EDGE,
            format!(
                "{description} requires {} this write doesn't establish: {} — write the record at the convergence of its required edges, e.g. write ({}) {{ … }}",
                if missing.len() == 1 { "an edge" } else { "edges" },
                described.join(", "),
                spelling.join(", ")
            ),
            span,
        );
    }

    /// `checkRequiredFields`: a create must set every field the target requires.
    fn check_required_fields(&mut self, fields: &[Field], root: Option<&WritableRootSchema>, description: &str, parents: &[Parent], span: Span) {
        let Some(required) = root.and_then(|r| r.required_fields.as_ref()) else { return };
        let missing: Vec<String> = required
            .iter()
            .filter(|name| !fields.iter().any(|f| &f.name == *name) && !parents.iter().any(|p| &p.edge == *name))
            .map(|name| format!("'{name}'"))
            .collect();
        if missing.is_empty() {
            return;
        }
        let one = missing.len() == 1;
        self.report(
            codes::WRITE_MISSING_REQUIRED_FIELD,
            format!(
                "{description} requires {} this write never sets: {} — the target rejects creates without {}; add {} to the write body",
                if one { "a field" } else { "fields" },
                missing.join(", "),
                if one { "it" } else { "them" },
                if one { "it" } else { "them" }
            ),
            span,
        );
    }

    /// `positionWriteResult`: since 4 `x = write c { … }` is the record's
    /// latest version, a handle a write produced.
    fn position_write_result(&self, target: Option<Position>, root: Option<&WritableRootSchema>) -> Option<Position> {
        if self.version < 4 {
            return target;
        }
        match target {
            Some(Position::Handle(mut handle)) => {
                handle.set_fields = None;
                handle.written = true;
                handle.identity = Default::default();
                Some(Position::Handle(handle))
            }
            Some(Position::Position(p)) => {
                let shape: indexmap::IndexMap<String, Ty> = match root {
                    Some(root) => root.result_shape.iter().map(|(k, v)| (k.clone(), Ty::from_schema(v))).collect(),
                    None => p
                        .instance
                        .schema
                        .positions
                        .get(&p.position)
                        .map(|s| s.properties.iter().map(|(k, v)| (k.clone(), Ty::from_schema(v))).collect())
                        .unwrap_or_default(),
                };
                Some(Position::Handle(HandlePosition {
                    instance: p.instance.clone(),
                    position: Some(p.position.clone()),
                    result_shape: shape,
                    edges: root.and_then(|r| r.edges.clone()),
                    generic_landings: None,
                    written: true,
                    set_fields: None,
                    identity: Default::default(),
                }))
            }
            other => other,
        }
    }

    // ── fields ──

    /// A field's value type, and the first record or file in it the target
    /// does not take (`checkExprSlot`'s `valueType` and `held`).
    fn write_field_value(&mut self, slot: &movement_parser::ast::ExprSlot, scope: ScopeId, target: Option<&Ty>, path: Option<String>) -> (Option<Ty>, Option<HeldHandle>) {
        // The slot as it was checked: each call it runs already hoisted to a
        // name holding what the call hands back.
        let hoisted = self.nested_call_rewrite(slot, scope).map(|(_, hoisted)| hoisted);
        let Ok(expr) = crate::slots::expression_of_slot(hoisted.as_ref().unwrap_or(slot)) else { return (None, None) };
        let (ty, held, refused) = {
            let env = self.typing_env(scope);
            let mut typing = crate::types::Typing::new(&env, self.version, slot.span);
            typing.write_target = target.map(|t| (t.clone(), path));
            let ty = typing.infer(&expr);
            // Read off the parts of a value the expression builds, where the
            // whole value's type no longer shows them (`handleHeldBy`).
            let walk = HeldWalk::taken_by(target);
            let held = typing.handle_held_by(&expr, &walk).or_else(|| handle_within(ty.as_ref(), &walk));
            // The slot's other typing diagnostics are reported where it is checked.
            let refused: Vec<_> = typing.diagnostics.into_iter().filter(|d| crate::families::extraction::reads_write_target(&d.code)).collect();
            (ty, held, refused)
        };
        for diagnostic in refused {
            self.push(diagnostic);
        }
        (ty, held)
    }

    /// `bareHandleName`: a slot that is one bare name bound to a write handle.
    fn bare_handle_name(&self, slot: &movement_parser::ast::ExprSlot, scope: ScopeId) -> Option<String> {
        let trimmed = slot.raw.trim();
        if !is_bare_ident(trimmed) {
            return None;
        }
        let Resolution::Found(id) = self.scopes.resolve(scope, trimmed) else { return None };
        matches!(self.scopes.symbol(id).types.pos, Some(Position::Handle(_))).then(|| trimmed.to_string())
    }


    /// `reportFieldValueType`: a value the field's type does not take.
    /// `checkEnumLiteralWrite`: a string literal written into an enum field is
    /// one of its options. A value that is not a literal is unknown at author
    /// time, which is a reason for silence only while some value could still
    /// be right — so an empty domain is refused whatever is written.
    fn check_enum_literal_write(&mut self, value: &movement_parser::ast::ExprSlot, target: Option<&Ty>, subject: &str) {
        let Some(target @ Ty::Enum { .. }) = target else { return };
        let found = crate::families::values::check_enum_domain(target, subject)
            .or_else(|| static_string_literal_of(value).and_then(|literal| crate::families::values::check_enum_literal(&literal, target)));
        let Some(found) = found else { return };
        match found.severity {
            Some(severity) => self.report_with(found.code, found.message, value.span, severity),
            None => self.report(found.code, found.message, value.span),
        }
    }

    fn report_field_value_type(&mut self, field_name: &str, subject: &str, target: Option<&Ty>, value: Option<&Ty>, span: Span, fit: FieldFit) {
        if self.version >= 5 && (may_be_closure(value) || may_be_closure(fit.held.map(|h| &h.handle))) {
            self.report(
                codes::CLOSURE_NOT_DATA,
                closure_not_data_message(&format!("'{field_name}' on {subject} is written, and this is")),
                span,
            );
            return;
        }
        let Some(target) = target else { return };
        if let Some(held) = fit.held
            && !fit.relationship
            && let Some(message) = handle_in_field_message(field_name, subject, target, value, held)
        {
            self.report(codes::WRITE_FIELD_TYPE, message, span);
            return;
        }
        let Some(value) = value else { return };
        let is_record = matches!(strip_absent(value), Ty::Record(_));
        if is_record && fit.relationship {
            return;
        }
        if fit.declared && !matches!(value, Ty::Absent) && !is_record {
            if field_assignable(value, target) {
                return;
            }
            self.report(
                codes::WRITE_FIELD_TYPE,
                format!("'{field_name}' on {subject} is {}, and this is {}{}", describe_field_type(target), describe_field_type(value), text_repair(value, target)),
                span,
            );
            return;
        }
        if field_type_compatible(value, target) {
            return;
        }
        if is_record {
            let held = HeldHandle { steps: Vec::new(), handle: value.clone(), may: false };
            self.report(codes::WRITE_FIELD_TYPE, record_in_field_message(field_name, subject, target, Some(value), &held), span);
            return;
        }
        self.report(
            codes::WRITE_FIELD_TYPE,
            format!("'{field_name}' on {subject} is {}, but this expression produces {}", describe_field_type(target), describe_field_type(value)),
            span,
        );
    }

    // ── match ──

    /// `checkMatch`: the identity half of a write, checked by the same rules.
    pub fn check_match_rules(&mut self, matched: &MatchExpression, scope: ScopeId, binding: Option<&str>, implied_identity: bool) -> Option<Position> {
        let mut root: Option<WritableRootSchema> = None;
        let mut root_description = "the match target".to_string();
        let mut handle: Option<Position> = None;
        let mut local = false;
        let mut parents: Vec<Parent> = Vec::new();
        match &matched.target {
            WriteTarget::Linked { path, explicit_type, span } => {
                let linked = self.linked_target(path, explicit_type.as_deref(), *span, Purpose::Match, false, None, scope);
                root = linked.root;
                handle = linked.handle;
                local = linked.local;
                if let Some(description) = linked.description {
                    root_description = description;
                }
            }
            WriteTarget::Tuple { paths, explicit_type, span } => {
                let tuple = self.tuple_target(paths, explicit_type.as_deref(), *span, &mut parents, Purpose::Match, false, None, scope);
                root = tuple.root;
                handle = tuple.handle;
                if let Some(description) = tuple.description {
                    root_description = description;
                }
            }
            // The parser gives a match no position target.
            WriteTarget::Position { .. } => {}
        }
        let fields: Vec<Field> = matched.fields.iter().map(Field::authored).collect();
        let selected = self.select_write_variant(root, &fields, &root_description);
        root = selected.root;
        root_description = selected.description;
        if let Some(variant) = &selected.variant {
            handle = self.handle_of_variant(handle, variant);
        }
        if let Some(root) = &root {
            let native_identity =
                root.uniqueness_authorable == Some(false) || root.native_uniqueness.as_ref().is_some_and(|n| !n.is_empty());
            if matched.unique_by.is_empty() && !native_identity {
                let example = root.fields.keys().next().map_or("…".to_string(), |f| format!("`{f}`"));
                self.report(
                    codes::MATCH_NO_IDENTITY,
                    format!(
                        "this match has nothing to identify {root_description} by — add 'unique by (…)' naming the field(s) that make it the same record (e.g. 'unique by ({example})')"
                    ),
                    target_span(&matched.target),
                );
            }
        }
        let unique_by: &[UniqueClause] = if implied_identity { &[] } else { &matched.unique_by };
        self.check_identity(unique_by, root.as_ref(), &root_description, scope, local);
        for field in &fields {
            let target_type = root.as_ref().and_then(|r| r.fields.get(&field.name)).map(Ty::from_schema);
            if let Some(root) = &root
                && target_type.is_none()
            {
                let available: Vec<&str> = root.fields.keys().map(String::as_str).collect();
                let has = if available.is_empty() { String::new() } else { format!("; it has: {}", available.join(", ")) };
                self.report(
                    codes::WRITE_UNKNOWN_FIELD,
                    format!("{root_description} has no field '{}' — a match's fields are fields of the record it finds{has}", field.name),
                    field.span,
                );
            }
            let (value_type, held) = self.write_field_value(&field.value, scope, target_type.as_ref(), None);
            self.report_blankable_identity_key(&matched.unique_by, field, value_type.as_ref(), &root_description, scope);
            self.report_field_value_type(
                &field.name,
                &root_description,
                target_type.as_ref(),
                value_type.as_ref(),
                field.value.span,
                FieldFit { relationship: false, declared: false, held: held.as_ref() },
            );
            self.check_enum_literal_write(&field.value, target_type.as_ref(), &format!("'{}' on {root_description}", field.name));
        }
        if let Some(binding) = binding
            && self.upgrade_crosses(4)
        {
            self.report_upgrade_warning(
                codes::MATCH_MISS_CONTINUES,
                format!(
                    "since {} a 'match' that finds nothing no longer ends the scope: '{binding}' is absent and the block carries on — guard what depends on it with `if {binding} != null {{ … }}`",
                    version::describe(4)
                ),
                matched.span,
            );
        }
        found_handle(handle, self.version)
    }

    /// A `match` statement nobody names gates nothing since version 4.
    pub fn report_unnamed_match(&mut self, span: Span) {
        if self.version >= 4 {
            self.report(
                codes::MATCH_UNNAMED,
                format!(
                    "'match … {{ }}' on its own gates nothing since {}: a miss is absent, not the end of the scope. Bind it and test the name — `existing = match … {{ … }}` then `if existing != null {{ … }}`",
                    version::describe(4)
                ),
                span,
            );
        }
    }

    // ── refresh, delete ──

    /// `checkRefresh`: `refresh` re-fetches a stored record.
    pub fn check_refresh_rules(&mut self, name: &str, span: Span, scope: ScopeId) {
        let Resolution::Found(id) = self.scopes.resolve(scope, name) else { return };
        if self.scopes.symbol(id).kind == SymbolKind::Param {
            self.report(
                codes::REFRESH_UNSTABLE,
                format!("'{name}' is the event payload — 'refresh' re-fetches a stored record by its id, and the event has none. Refresh a write handle or a traversed record instead."),
                span,
            );
            return;
        }
        let position = match self.record_of_name(name, scope) {
            Some(RecordOf::Value(what)) => {
                self.report(
                    codes::REFRESH_UNSTABLE,
                    format!("'{name}' is {what} — 'refresh' re-fetches a stored record by its id. Refresh a write handle or a traversed record instead."),
                    span,
                );
                return;
            }
            Some(RecordOf::Record(position)) => position,
            _ => return,
        };
        let what = match &position {
            Position::Handle(_) | Position::Position(_) | Position::Union(_) | Position::Local(_) => return,
            Position::Extract { .. } => "an extracted node — synthesized during extraction, not a stored record".to_string(),
            other => format!("{} — not a re-fetchable record", describe_position(other)),
        };
        self.report(
            codes::REFRESH_UNSTABLE,
            format!("'{name}' is {what}. 'refresh' re-fetches a stored record by its id — refresh a write handle or a traversed record instead."),
            span,
        );
    }
}

struct Selected {
    root: Option<WritableRootSchema>,
    description: String,
    variant: Option<WritableRootSchema>,
}

#[derive(Clone, Copy)]
struct FieldFit<'h> {
    relationship: bool,
    declared: bool,
    held: Option<&'h HeldHandle>,
}

/// `recordOfName` over what a symbol is typed as.
pub fn record_of(types: &SymbolTypes, kind: SymbolKind) -> RecordOf {
    if let Some(position) = &types.pos {
        return RecordOf::Record(position.clone());
    }
    if let Some(field) = &types.field {
        if let Ty::Record(Some(position)) = strip_absent(field) {
            let position = (**position).clone();
            return RecordOf::Record(if is_maybe_absent(Some(field)) { Position::MaybeEmpty(Box::new(position)) } else { position });
        }
        return if holds_records(Some(field)) { RecordOf::Unknown } else { RecordOf::Value(describe_field_type(field)) };
    }
    match kind {
        SymbolKind::Alias | SymbolKind::Param | SymbolKind::Binding | SymbolKind::Instance | SymbolKind::Shape => RecordOf::Unknown,
        other => RecordOf::Value(other.describe().to_string()),
    }
}

fn target_span(target: &WriteTarget) -> Span {
    match target {
        WriteTarget::Linked { span, .. } | WriteTarget::Tuple { span, .. } | WriteTarget::Position { span, .. } => *span,
    }
}

pub fn path_root_name(path: &PathHead) -> Option<&str> {
    match &path.root {
        Some(PathRoot::Name { name }) => Some(name),
        _ => None,
    }
}

/// `spellPathRoot`.
fn spell_path_root(root: &PathRoot) -> String {
    match root {
        PathRoot::Name { name } => spell_name(name),
        PathRoot::Expression { expr } => expr.raw.clone(),
    }
}

/// `rawPath`: a path head as written.
fn raw_path(path: &PathHead) -> String {
    let root = path.root.as_ref().map(spell_path_root).unwrap_or_default();
    format!("{root}{}", path.hops_raw)
}

/// `memberPathBindingName`: `m.k` for a root that is one member path.
fn member_path_binding_name(raw: &str) -> Option<String> {
    let mut names = Vec::new();
    for part in raw.trim().split('.') {
        let part = part.trim();
        let name = part.strip_prefix('`').and_then(|p| p.strip_suffix('`')).unwrap_or(part);
        if name.is_empty() || (!part.starts_with('`') && !is_bare_ident(part)) {
            return None;
        }
        names.push(name.to_string());
    }
    (names.len() > 1).then(|| names.join("."))
}

/// `surfaceNotEnumerated`.
fn surface_not_enumerated(schema: &PositionSchema) -> bool {
    schema.open_properties == Some(true) || schema.undescribed == Some(true) || schema.pending == Some(true)
}

/// `writableEdgesOf`: every edge a write may land on, as (parent, edge).
fn writable_edges_of(instance: &InstanceRef) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (parent, position) in instance.schema.positions.iter() {
        for (edge, schema) in position.edges.iter() {
            if schema.writable == Some(true) {
                out.push((parent.clone(), edge.clone()));
            }
        }
    }
    out
}

/// `readableMatchRoot`: a match on a position nobody writes reads its properties.
fn readable_match_root(position: Option<&PositionSchema>) -> Option<WritableRootSchema> {
    let position = position?;
    let text = || SchemaFieldType::Scalar(movement_parser::catalog::types::Scalar::Text);
    let mut entries = vec![("externalId".to_string(), text()), ("url".to_string(), text())];
    for (k, v) in position.properties.iter() {
        match entries.iter_mut().find(|(key, _)| key == k) {
            Some(slot) => slot.1 = v.clone(),
            None => entries.push((k.clone(), v.clone())),
        }
    }
    let result_shape = entries.into_iter().collect();
    Some(WritableRootSchema { fields: position.properties.clone(), result_shape, ..empty_writable_root() })
}

/// `runBuiltWriteShape`: what a record this run built may set in place —
/// an extracted record's declared fields, or the fields its landing type
/// carries — and whether a node declaration types it.
struct RunBuiltShape {
    fields: movement_parser::catalog::types::JsMap<SchemaFieldType>,
    declared: bool,
}

fn run_built_write_shape(position: &Position) -> Option<RunBuiltShape> {
    if let Position::Local(local) = position
        && let Some(extracted) = &local.extracted
    {
        return Some(RunBuiltShape { fields: extracted.iter().map(|(k, v)| (k.clone(), v.to_schema())).collect(), declared: true });
    }
    let landing = match position {
        Position::Position(p) if p.run_built => position,
        Position::Local(local) => local.run_built.as_deref()?,
        _ => return None,
    };
    let schema = position_schema_of_ref(landing)?;
    let instance = crate::types::position::instance_of_ref(Some(landing))?;
    Some(RunBuiltShape { fields: schema.properties.clone(), declared: instance.declared.is_some() })
}

fn empty_writable_root() -> WritableRootSchema {
    serde_json::from_value(serde_json::json!({ "fields": {}, "resultShape": {} })).unwrap_or_else(|_| unreachable!("a write shape needs only its fields"))
}

fn empty_position_schema() -> PositionSchema {
    serde_json::from_value(serde_json::json!({ "properties": {}, "edges": {} })).unwrap_or_else(|_| unreachable!("a position schema needs only properties and edges"))
}

/// `withSetFields`: the fields the body set outright, on a handle a write produced.
fn with_set_fields(handle: Option<Position>, fields: &[Field]) -> Option<Position> {
    match handle {
        Some(Position::Handle(mut h)) if h.written => {
            h.set_fields = Some(fields.iter().filter(|f| f.semantics.is_none()).map(|f| f.name.clone()).collect());
            h.identity = Default::default();
            Some(Position::Handle(h))
        }
        other => other,
    }
}

/// `foundHandle`: a match's handle, without the write-outcome facts.
fn found_handle(handle: Option<Position>, version: u32) -> Option<Position> {
    match handle {
        Some(Position::Handle(mut h)) => {
            h.written = false;
            h.identity = Default::default();
            if version < 4 {
                h.result_shape.shift_remove("created");
                h.result_shape.shift_remove("committed");
            }
            Some(Position::Handle(h))
        }
        other => other,
    }
}

/// `nestedLocalEdges`: a declared landing's nested nodes, as the landing's
/// own appendable edges.
fn nested_local_edges(instance: &crate::types::position::InstanceRef, schema: &PositionSchema) -> Option<indexmap::IndexMap<String, crate::types::position::LocalEdge>> {
    let mut edges = indexmap::IndexMap::new();
    for (name, declared) in schema.edges.iter() {
        let Some(target) = crate::types::position::position_ref_in(instance, &declared.target) else { continue };
        edges.insert(
            name.clone(),
            crate::types::position::LocalEdge {
                schema: crate::families::nodes::local_edge_schema(name, declared.sequenced),
                target: Some(crate::types::declared::run_built_landing(target)),
                structural: true,
                deferred: false,
                references: false,
            },
        );
    }
    (!edges.is_empty()).then_some(edges)
}

/// `knownFieldsOf`: a record's fields, where this program spells them out.
fn known_fields_of(position: &Position) -> Option<Vec<String>> {
    match position {
        Position::Extract { node, .. } => (!node.declared).then(|| node.properties.keys().cloned().collect()),
        Position::Local(local) => Some(local.reads.keys().cloned().collect()),
        Position::MaybeEmpty(of) => known_fields_of(of),
        Position::Handle(h) => Some(match position_schema_of_ref(position) {
            Some(schema) => schema.properties.keys().cloned().collect(),
            None => h.result_shape.keys().cloned().collect(),
        }),
        // A system's position: its fields are the system's to say. (A
        // declared node's position is the nodes family's to type.)
        Position::Position(p) if p.instance.declared.is_some() => p.instance.schema.positions.get(&p.position).map(|s| s.properties.keys().cloned().collect()),
        Position::Position(_) | Position::Meta { .. } | Position::Union(_) | Position::Closure(_) => None,
    }
}

/// `staticStringLiteralOf`: the value of a slot that is one string literal.
fn static_string_literal_of(slot: &movement_parser::ast::ExprSlot) -> Option<String> {
    match expression_of_slot(slot).ok()? {
        Expression::Static { value: StaticValue::String(value) } => Some(value),
        _ => None,
    }
}

/// `literalStringValuesOf` (generics.ts): a string literal or a list of them.
fn literal_string_values_of(raw: &str) -> Option<Vec<String>> {
    match crate::slots::expression_of_text(raw).ok()? {
        Expression::Static { value: StaticValue::String(value) } => Some(vec![value]),
        Expression::List { elements } => elements
            .into_iter()
            .map(|e| match e {
                movement_parser::lowering::expression::ListElement::Expression(Expression::Static { value: StaticValue::String(v) }) => Some(v),
                _ => None,
            })
            .collect(),
        _ => None,
    }
}

/// `genericLandingKey` (generics.ts).
fn generic_landing_key(target: &str, values: &[String]) -> String {
    serde_json::to_string(&("generic-landing", target, values)).unwrap_or_default()
}

/// `literalExampleFor`.
fn literal_example_for(field: &str, ty: Option<&SchemaFieldType>) -> String {
    match ty.map(Ty::from_schema) {
        Some(Ty::Enum { options, .. }) if !options.is_empty() => format!(" (e.g. {field}: \"{}\")", options[0]),
        _ => String::new(),
    }
}

/// `joinList`: `a`, `a or b`, `a, b, or c`.
fn join_list(items: &[String], conjunction: &str) -> String {
    match items.len() {
        0 => String::new(),
        1 => items[0].clone(),
        2 => format!("{} {conjunction} {}", items[0], items[1]),
        n => {
            let separator = if conjunction == "or" { ", or " } else { " and " };
            format!("{}{separator}{}", items[..n - 1].join(", "), items[n - 1])
        }
    }
}

/// `writeUnionClash`.
fn write_union_clash(conflict: &[String]) -> String {
    match conflict.len() {
        2 => format!("{} and {} can't both be set", conflict[0], conflict[1]),
        n if n > 2 => format!("{} can't be set together", join_list(conflict, "and")),
        _ => format!("{} fits none of them", join_list(conflict, "and")),
    }
}

/// `writeBindRetiredMessage`.
fn write_bind_retired_message(name: &str) -> String {
    format!(
        "'bind {name}' is retired — a write no longer keeps a hidden link to a record in another system, which no system could show or change. Store the link explicitly, in the system that holds it: a field there that carries {name}'s identity, which the next write finds the record by ('write crm-[:Companies]-> {{ unique by (`Source Id`), `Source Id`: …, … }}'), or an edge there. Then drop 'bind {name}'"
    )
}

/// `textRepair` (conformance.ts).
fn text_repair(have: &Ty, want: &Ty) -> &'static str {
    if !matches!(strip_absent(want), Ty::Text) {
        return "";
    }
    match strip_absent(have) {
        Ty::Number => " — write the text it should be: `TOSTRING(…)`",
        Ty::Boolean => " — write the text it should be: `IF … THEN \"Yes\" ELSE \"No\" END`",
        _ => "",
    }
}

/// `handleInFieldSaid`.
fn handle_in_field_said(field_name: &str, subject: &str, target: &Ty, value: Option<&Ty>, held: &HeldHandle) -> String {
    let direct = held.steps.is_empty();
    let verb = if held.may { "may be" } else { "is" };
    let what = match value {
        Some(value) if direct && !held.may => value,
        _ => &held.handle,
    };
    let place = if direct { "this".to_string() } else { format!("'{field_name}{}'", spell_held_steps(&held.steps)) };
    format!("'{field_name}' on {subject} is {}, and {place} {verb} {}", describe_field_type(target), describe_field_type(what))
}

/// `repairAt`.
fn repair_at(place: Option<&str>, held: Option<&HeldHandle>, repair: &str) -> String {
    let place = place.map(str::to_string).or_else(|| match held?.steps.last()? {
        crate::types::field::HeldStep::Key(key) => Some(key.clone()),
        _ => None,
    });
    match place {
        Some(place) => format!("'{place}: {repair}'"),
        None => format!("'{repair}'"),
    }
}

/// `recordInFieldMessage`.
fn record_in_field_message(field_name: &str, subject: &str, target: &Ty, value: Option<&Ty>, held: &HeldHandle) -> String {
    let repair = if held.steps.is_empty() { repair_at(Some(field_name), None, "r.`Name`") } else { repair_at(None, Some(held), "r.`Name`") };
    format!(
        "{} — a record, not a value. Write a field off it ({repair}), or join the two records with a link ('link … -[:edge]-> r').",
        handle_in_field_said(field_name, subject, target, value, held)
    )
}

/// `handleInFieldMessage`: `None` where the field's own mismatch says it better.
fn handle_in_field_message(field_name: &str, subject: &str, target: &Ty, value: Option<&Ty>, held: &HeldHandle) -> Option<String> {
    if !held.is_file() {
        return Some(record_in_field_message(field_name, subject, target, value, held));
    }
    let direct = held.steps.is_empty();
    let takes_data = field_type_compatible(&Ty::Json, target);
    let repair_text = if takes_data && !direct {
        Some("READ(f)")
    } else if takes_data || matches!(strip_absent(target), Ty::Text) {
        Some("COALESCE(READ(f), \"\")")
    } else {
        None
    };
    if repair_text.is_none() && value.is_some() {
        return None;
    }
    let repair = match repair_text {
        Some(text) => {
            let at = if direct { repair_at(Some(field_name), None, text) } else { repair_at(None, Some(held), text) };
            format!("; {}put its text in its place ({at})", if direct { "" } else { "inside a value, " })
        }
        None => String::new(),
    };
    Some(format!(
        "{} — a file, not a value. A file goes only into a field that holds files{repair}.",
        handle_in_field_said(field_name, subject, target, value, held)
    ))
}

// ── write-only reads (typing.ts `reportWriteOnlyEdge`, `reportWriteOnlyProperty`) ──
//
// Raised inside the walk's typing, at the points the walks family's hooks
// observe (`walks::observe_step`, `walks::observe_read`): each hook calls
// the matching function here.

/// A hop along an edge its system offers nothing to read along.
pub fn report_write_only_edge(typing: &mut Typing, from: Option<&Position>, step: &movement_parser::lowering::expression::EdgeStep, landing: Option<&crate::types::position::EdgeLanding>) {
    let (Some(from), Some(crate::types::position::EdgeLanding::Untyped { edge: Some(schema) })) = (from, landing) else { return };
    let from = match from {
        Position::MaybeEmpty(of) => &**of,
        other => other,
    };
    let unreadable = schema.readable == Some(false) && (matches!(from, Position::Union(_)) || schema.awaitable != Some(true));
    if !unreadable || !matches!(from, Position::Position(_) | Position::Handle(_) | Position::Union(_)) {
        return;
    }
    let edge = &step.edge_type_id;
    let why = if schema.writable == Some(true) {
        format!("it writes (write …-[:{edge}]-> {{ … }}); the system offers nothing to read back along it")
    } else {
        "the system offers nothing to read along it".to_string()
    };
    typing.report(codes::WRITE_ONLY_EDGE, format!("'-[:{edge}]->' on {} is write-only — {why}", describe_position(from)));
}

/// A dot read of a field the type declares on its write shape only.
pub fn report_write_only_property(typing: &mut Typing, position: Option<&Position>, property: &str, ty: Option<&Ty>) {
    if ty.is_some() {
        return;
    }
    let Some(position) = position else { return };
    let position = match position {
        Position::MaybeEmpty(of) => &**of,
        other => other,
    };
    let (instance, type_name, schema) = match position {
        Position::Position(p) => (&p.instance, Some(p.position.clone()), position_schema_of_ref(position).map(|s| s.into_owned())),
        Position::Handle(h) => (&h.instance, h.position.clone(), position_schema_of_ref(position).map(|s| s.into_owned())),
        Position::Union(u) => {
            if u.variants.iter().any(|v| u.instance.schema.positions.get(v).is_some_and(|p| p.properties.contains_key(property))) {
                return;
            }
            let Some(variant) =
                u.variants.iter().find(|v| u.instance.schema.positions.get(*v).and_then(|p| p.write_only_properties.as_ref()).is_some_and(|w| w.iter().any(|f| f == property)))
            else {
                return;
            };
            (&u.instance, Some(variant.clone()), u.instance.schema.positions.get(variant).cloned())
        }
        _ => return,
    };
    let Some(schema) = schema else { return };
    if schema.properties.contains_key(property) || !schema.write_only_properties.as_ref().is_some_and(|w| w.iter().any(|f| f == property)) {
        return;
    }
    let shown = match (position, &type_name) {
        (Position::Union(_), Some(variant)) => describe_position(&Position::record(instance.clone(), variant.clone())),
        _ => describe_position(position),
    };
    let doc = type_name
        .as_ref()
        .and_then(|t| instance.schema.writable_roots.get(t).or_else(|| instance.schema.create_shapes.as_ref().and_then(|c| c.get(t))))
        .and_then(|shape| shape.field_docs.as_ref())
        .and_then(|docs| docs.get(property))
        .map(|doc| format!(" {doc}"))
        .unwrap_or_default();
    typing.report(codes::WRITE_ONLY_PROPERTY, format!("'{property}' on {shown} is write-only — a value a write sets, not one to read.{doc}"));
}

/// `MOV_LINKED_HOP_RETIRED`'s message: raised where a walk's hops are read
/// (`checkWalkKeepsWhatIsWritten`), for a `-[#linked …]->` hop.
pub fn linked_hop_retired_message(version: u32) -> String {
    let instead = if version >= 5 {
        "or store the link in the system that holds it — a field or an edge there"
    } else {
        "or tie a write to a record you hold with 'write … bind other { … }'"
    };
    format!(
        "the '-[#linked …]->' hop is retired — it looked a record up by the id another system gave it, not by the record this run wrote. Keep the write's handle and read from it: 'rec = write crm-[:Companies]-> {{ … }}', then 'rec.<field>' or 'rec-[:…]->'; {instead}"
    )
}
