//! The edge-only statements: `link`, `unlink` and `delete` (check.ts
//! `checkLink`, `checkBareLinkEdge`, `checkDeleteDeclared`).

use movement_parser::ast::{LinkExpression, LinkTarget, Span};

use super::{RecordOf, record_of};
use crate::checker::Checker;
use crate::codes;
use crate::scope::{Resolution, ScopeId};
use crate::types::field::{Ty, describe_field_type, strip_absent, union_members};
use crate::types::position::{InstanceRef, Position, describe_position, display_name_of, instance_of_ref, position_schema_of_ref};
use crate::version;

#[derive(Clone, Copy)]
pub enum LinkVerb {
    Link,
    Unlink,
}

impl Checker<'_> {
    /// `checkLink`, the rules half: a body form is a match then the link.
    pub fn check_link_rules(&mut self, link: &LinkExpression, scope: ScopeId, binding: Option<&str>) -> Option<Position> {
        let from_type = self.symbol_position(&link.from, scope);
        let retired_body = matches!(link.to, LinkTarget::Match { .. }) && self.version >= 4;
        if let Some(Position::Local(local)) = &from_type {
            match &link.to {
                LinkTarget::Match { r#match, .. } if retired_body => self.report_link_body_retired(link, r#match.span),
                LinkTarget::Match { r#match, .. } => self.report_local_link_body(link, &local.label, r#match.span),
                LinkTarget::Handle { name } => self.check_local_link(link, name, local, scope),
            }
            return None;
        }
        let found = match &link.to {
            LinkTarget::Match { r#match, implied_identity } => {
                self.check_match_rules(r#match, scope, if retired_body { None } else { binding }, *implied_identity)
            }
            LinkTarget::Handle { .. } => None,
        };
        self.check_bare_link_edge(&link.from, &link.edge, link.span, LinkVerb::Link, scope);
        if let LinkTarget::Match { r#match, .. } = &link.to
            && retired_body
        {
            self.report_link_body_retired(link, r#match.span);
            return None;
        }
        found
    }

    fn report_link_body_retired(&mut self, link: &LinkExpression, span: Span) {
        self.report(
            codes::LINK_MATCH_BODY_RETIRED,
            format!(
                "a 'link' no longer finds its record in its own body since {}: find it first and test it — `to = match … {{ … }}` then `if to != null {{ link {} -[:{}]-> to }}`",
                version::describe(4),
                link.from,
                link.edge
            ),
            span,
        );
    }

    /// `checkBareLinkEdge`: an edge its system only creates along cannot be
    /// linked or unlinked between two records that already exist.
    pub fn check_bare_link_edge(&mut self, from: &str, edge: &str, span: Span, verb: LinkVerb, scope: ScopeId) {
        let Some(from_type) = self.symbol_position(from, scope) else { return };
        let Some(instance) = instance_of_ref(Some(&from_type)).cloned() else { return };
        if matches!(from_type, Position::MaybeEmpty(_)) {
            return;
        }
        let linkable = position_schema_of_ref(&from_type).and_then(|s| s.edges.get(edge).map(|e| e.linkable));
        if linkable != Some(Some(false)) {
            return;
        }
        let verb = match verb {
            LinkVerb::Link => "link",
            LinkVerb::Unlink => "unlink",
        };
        self.report(
            codes::LINK_UNSUPPORTED_EDGE,
            format!(
                "'{}' makes '-[:{edge}]->' on {} by WRITING along it — 'write {from}-[:{edge}]-> {{ … }}' creates the record and the relationship together — so there is nothing to {verb} two records that already exist with",
                instance.name,
                describe_position(&from_type)
            ),
            span,
        );
    }

    /// `symbolPositionType` of the name `name` resolves to.
    fn symbol_position(&self, name: &str, scope: ScopeId) -> Option<Position> {
        let Resolution::Found(id) = self.scopes.resolve(scope, name) else { return None };
        let types = &self.scopes.symbol(id).types;
        types.pos.clone().or_else(|| match types.field.as_ref() {
            Some(Ty::Record(Some(position))) => Some((**position).clone()),
            _ => None,
        })
    }

    /// `checkDeleteDeclared`: since version 5 `delete x` needs one stored
    /// record whose type declares that its system deletes one.
    pub fn check_delete_rules(&mut self, name: &str, span: Span, scope: ScopeId) {
        if self.version < 5 {
            return;
        }
        let Resolution::Found(id) = self.scopes.resolve(scope, name) else { return };
        let symbol = self.scopes.symbol(id);
        let (types, kind) = (symbol.types.clone(), symbol.kind);
        let not_record = |what: String| {
            format!(
                "'{name}' is {what} — 'delete' removes one record a system stores. Delete a record you walked to or wrote ('delete r' inside 'crm-[r:Companies]-> {{ … }}', or 'rec = write …' then 'delete rec')."
            )
        };
        let mut held: Vec<Position> = Vec::new();
        if types.pos.is_none() && types.field.is_none() {
            let Some(may_hold) = &types.may_hold else { return };
            for member in union_members(may_hold) {
                match strip_absent(&member) {
                    Ty::Record(Some(position)) => held.push((**position).clone()),
                    Ty::Record(None) => {}
                    _ => {
                        self.report(codes::DELETE_NOT_RECORD, not_record("a value that may hold something other than one record".to_string()), span);
                        return;
                    }
                }
            }
        } else {
            match record_of(&types, kind) {
                RecordOf::Value(what) => {
                    self.report(codes::DELETE_NOT_RECORD, not_record(what), span);
                    return;
                }
                RecordOf::Unknown => {
                    if let Some(field) = &types.field
                        && !matches!(strip_absent(field), Ty::Record(_))
                    {
                        self.report(
                            codes::DELETE_NOT_RECORD,
                            not_record(format!("{}, which may hold something other than one record", describe_field_type(field))),
                            span,
                        );
                    }
                    return;
                }
                RecordOf::Record(position) => held.push(position),
            }
        }
        let mut undeclared: Vec<String> = Vec::new();
        for position in &held {
            if !self.visit_deletable(position, &mut undeclared, &not_record, span) {
                return;
            }
        }
        if undeclared.is_empty() {
            return;
        }
        let one = undeclared.len() == 1;
        self.report(
            codes::DELETE_NOT_DECLARED,
            format!(
                "'{name}' is {}, and its system does not declare that it can delete {} — 'delete' is checked against the system's own promise ('deletable' on the type it describes). Change the record instead ('write {name} {{ … }}'), or delete it in a system that can.",
                if one { undeclared[0].clone() } else { format!("one of {}", undeclared.join(", ")) },
                if one { "one" } else { "every one of them" }
            ),
            span,
        );
    }

    fn visit_deletable(&mut self, position: &Position, undeclared: &mut Vec<String>, not_record: &dyn Fn(String) -> String, span: Span) -> bool {
        match position {
            Position::MaybeEmpty(of) => self.visit_deletable(of, undeclared, not_record, span),
            // Every record it may be is deleted as that record, each reported
            // (so every member is visited before the answer is read).
            Position::OneOf(members) => {
                let each: Vec<bool> = members.iter().map(|member| self.visit_deletable(member, undeclared, not_record, span)).collect();
                each.into_iter().all(|deletable| deletable)
            }
            Position::Position(p) => {
                if p.run_built {
                    self.report(
                        codes::DELETE_NOT_RECORD,
                        not_record(format!("{}, a record on a node this run built — the run's own graph, which nothing stores", describe_position(position))),
                        span,
                    );
                    return false;
                }
                collect_undeclared_delete(&p.instance, &p.position, describe_position(position), undeclared);
                true
            }
            Position::Handle(h) => {
                match &h.position {
                    None => undeclared.push(describe_position(position)),
                    Some(name) => collect_undeclared_delete(&h.instance, name, describe_position(position), undeclared),
                }
                true
            }
            Position::Union(u) => {
                for variant in &u.variants {
                    collect_undeclared_delete(&u.instance, variant, format!("{}.{}", u.instance.name, display_name_of(&u.instance, variant)), undeclared);
                }
                true
            }
            Position::Extract { .. } => {
                self.report(
                    codes::DELETE_NOT_RECORD,
                    not_record(format!("{}, an extracted node — a transient graph the extraction built, which nothing stores", describe_position(position))),
                    span,
                );
                false
            }
            Position::Meta { .. } | Position::Closure(_) | Position::Local(_) => {
                self.report(codes::DELETE_NOT_RECORD, not_record(describe_position(position)), span);
                false
            }
        }
    }
}

/// `collectUndeclaredDelete`.
fn collect_undeclared_delete(instance: &InstanceRef, position: &str, shown: String, into: &mut Vec<String>) {
    let Some(schema) = instance.schema.positions.get(position) else { return };
    if schema.undescribed == Some(true) || schema.pending == Some(true) {
        return;
    }
    if schema.deletable != Some(true) {
        into.push(shown);
    }
}
