//! Systems: constructing an adapter instance, the credential it names, and
//! an adapter used where only an instance will do.
//!
//! Codes: MOV_CONSTRUCT_NOT_ADAPTER, MOV_CONSTRUCT_BAD_ARG,
//! MOV_CONSTRUCT_MISSING_CRED, MOV_CONSTRUCT_UNKNOWN_OPTION,
//! MOV_CRED_WRONG_ADAPTER, MOV_ADAPTER_NOT_CONSTRUCTED, MOV_AI_TIER_LEGACY.
//! Not ported: MOV_OPTION_INVALID (typing.ts `typeOptionsMap`), which types
//! each option of a built-in's options map and needs expression typing.
//!
//! TypeScript: check.ts `checkConstruction`, `checkCredentialArg`,
//! `importedCredentialName`, `callInConstructPosition`, the parameter loop of
//! `checkMovement`, `checkPathHead`; typing.ts `aiTierDiagnostics`.

use indexmap::IndexMap;
use movement_parser::ast::{CallArg, CallStatement, ConstructionCall, ExprSlot, ParamTypeRef, Span, TypeRef};
use movement_parser::catalog::helpers::{credential_arg_of, unwrap_credential_arg};
use movement_parser::catalog::snapshot::Args;
use movement_parser::catalog::types::{InstanceSchema, JsMap};
use movement_parser::lowering::expression::{Expression, StaticValue};
use serde_json::json;

use crate::checker::Checker;
use crate::codes;
use crate::diagnostic::{Diagnostic, Severity};
use crate::meta::closest_by_edit_distance;
use crate::scope::{Resolution, ScopeId, SymbolId, SymbolKind};
use crate::slots::expression_of_slot;

/// `DRY_RUN_ARG`: the platform argument every construction accepts.
pub const DRY_RUN_ARG: &str = "dry_run";

/// `AI_TIERS`, and the spellings that predate them (`AI_TIER_ALIASES`).
const AI_TIERS: &[&str] = &["quick", "careful", "thorough"];
const AI_TIER_ALIASES: &[(&str, &str)] = &[("smart", "careful")];

/// `BOOLEAN_LITERAL`.
pub fn is_boolean_literal(raw: &str) -> bool {
    raw.eq_ignore_ascii_case("true") || raw.eq_ignore_ascii_case("false")
}

/// What a constructed instance carries on its symbol: the adapter, the
/// credential it was built with, the schema that pair instantiates, and its
/// other arguments raw (the entry position rides there).
// TODO(type-core): instance identity (`addressToken`) and the instance
// reference positions are typed against belong to the type core; this holds
// only what the listen and construction rules read.
#[derive(Debug, Default)]
pub struct Instance {
    pub adapter: Option<String>,
    pub credential: Option<String>,
    pub schema: Option<InstanceSchema>,
    pub construction_args: IndexMap<String, String>,
}

/// What `checkConstruction` learned.
#[derive(Default)]
pub struct Constructed {
    pub adapter: Option<String>,
    pub credential: Option<String>,
    pub schema: Option<InstanceSchema>,
}

impl Checker<'_> {
    /// `callInConstructPosition`: `doc = email_to_doc(m: msg)` is a call when
    /// the name it invokes is a function, not a construction.
    pub fn call_in_construct_position(&self, construct: &ConstructionCall, scope: ScopeId) -> Option<CallStatement> {
        let Resolution::Found(id) = self.scopes.resolve(scope, &self.callee_name(&construct.callee, scope)) else { return None };
        let symbol = self.scopes.symbol(id);
        let value = self.version >= 5 && matches!(symbol.kind, SymbolKind::Binding | SymbolKind::Param);
        // TODO(type-core): `calledClosure` reads the symbol's closure type; the
        // flag is its stand-in (a closure is called from version 3).
        let closure = self.version >= 3 && symbol.is_closure;
        if !matches!(symbol.kind, SymbolKind::Movement | SymbolKind::Plugin) && !value && !closure {
            return None;
        }
        let args = construct.args.iter().map(|a| CallArg::Expr { name: Some(a.name.clone()), expr: a.value.clone() }).collect();
        Some(CallStatement { callee: construct.callee.clone(), args, expression: None, span: construct.span })
    }

    /// `checkConstruction`: the adapter, credential and schema a construction
    /// builds, its arguments checked against the adapter's signature.
    pub fn check_construction(&mut self, construct: &ConstructionCall, scope: ScopeId) -> Constructed {
        let callee = match self.scopes.resolve(scope, &construct.callee) {
            Resolution::Found(id) => id,
            Resolution::Unknown if self.catalog.adapter(&construct.callee).is_some() => {
                let credential = self.catalog.adapter(&construct.callee).and_then(credential_arg_of).map(|a| a.name.clone());
                let slot = credential.and_then(|name| construct.args.iter().find(|a| a.name == name)).map(|a| &a.value);
                self.report_unimported_adapter_construction(&construct.callee, slot, construct.span, scope);
                return Constructed::default();
            }
            failure => {
                self.report_resolution_failure(&construct.callee, construct.span, failure);
                return Constructed::default();
            }
        };
        let symbol = self.scopes.symbol(callee);
        if symbol.kind != SymbolKind::Adapter {
            let message = if symbol.kind == SymbolKind::FileImport {
                format!("'{}' is imported from a file (a movement or a node declaration) — only adapter types are constructed", construct.callee)
            } else {
                format!("'{}' is {}, not an adapter type — only adapter types are constructed", construct.callee, symbol.kind.describe())
            };
            self.report(codes::CONSTRUCT_NOT_ADAPTER, message, construct.span);
            return Constructed::default();
        }
        let adapter = symbol.imported_name.clone().unwrap_or_else(|| construct.callee.clone());
        let Some(spec) = self.catalog.adapter(&adapter) else {
            return Constructed { adapter: Some(adapter), ..Constructed::default() };
        };
        let credential_arg = credential_arg_of(spec).cloned();
        let credential = credential_arg
            .as_ref()
            .and_then(|c| construct.args.iter().find(|a| a.name == c.name))
            .map(|a| self.imported_credential_name(a.value.raw.trim(), scope));
        let accepted: Vec<String> = spec.construction_args.iter().map(|a| a.name.clone()).collect();
        let mut saw_credential = false;
        for arg in &construct.args {
            if arg.name == DRY_RUN_ARG {
                if !is_boolean_literal(arg.value.raw.trim()) {
                    self.report(
                        codes::CONSTRUCT_BAD_ARG,
                        format!("'{DRY_RUN_ARG}' takes a boolean literal — write {DRY_RUN_ARG}: true (or false)"),
                        arg.value.span,
                    );
                }
                continue;
            }
            if !accepted.contains(&arg.name) {
                self.report(
                    codes::CONSTRUCT_BAD_ARG,
                    format!(
                        "'{}' does not accept a construction argument '{}' — it accepts: {}",
                        construct.callee,
                        arg.name,
                        accepted.join(", ")
                    ),
                    arg.value.span,
                );
                continue;
            }
            if credential_arg.as_ref().is_some_and(|c| c.name == arg.name) {
                saw_credential = true;
                self.check_credential_arg(&adapter, &arg.value, scope);
                continue;
            }
            self.check_expr_slot(&arg.value, scope);
            let options = self.catalog.construction_arg_options(&adapter, credential.as_deref(), &arg.name);
            if let (Some(options), Some(literal)) = (options, static_string_literal_of(&arg.value))
                && !options.is_empty()
                && !options.contains(&literal)
            {
                let tried: Vec<String> = options.iter().map(|o| format!("\"{o}\"")).collect();
                let mut warning = Diagnostic::error(
                    codes::CONSTRUCT_UNKNOWN_OPTION,
                    format!("'{}' value \"{literal}\" isn't one this connection can see — try: {}", arg.name, tried.join(", ")),
                    arg.value.span,
                );
                warning.severity = Some(Severity::Warning);
                self.push(warning);
            }
        }
        if let Some(credential_arg) = &credential_arg
            && credential_arg.required
            && !saw_credential
        {
            self.report(
                codes::CONSTRUCT_MISSING_CRED,
                format!(
                    "'{}' requires a '{}' argument naming an imported {} credential",
                    construct.callee, credential_arg.name, construct.callee
                ),
                construct.span,
            );
        }
        let mut args = IndexMap::new();
        for arg in construct.args.iter().filter(|a| a.name != DRY_RUN_ARG) {
            let raw = arg.value.raw.trim();
            let value = if credential_arg.as_ref().is_some_and(|c| c.name == arg.name) {
                self.imported_credential_name(raw, scope)
            } else {
                raw.to_string()
            };
            args.insert(arg.name.clone(), value);
        }
        let schema = self.catalog.instantiate(&adapter, &Args::from(JsMap(args))).cloned();
        Constructed { adapter: Some(adapter), credential, schema }
    }

    /// The instance a construction bound to a name declares.
    pub fn instance_of(&self, construct: &ConstructionCall, constructed: Constructed) -> Instance {
        let credential_arg = self
            .catalog
            .adapter(constructed.adapter.as_deref().unwrap_or(&construct.callee))
            .and_then(credential_arg_of)
            .map_or("credentials", |a| a.name.as_str());
        let construction_args =
            construct.args.iter().filter(|a| a.name != credential_arg).map(|a| (a.name.clone(), a.value.raw.clone())).collect();
        Instance { adapter: constructed.adapter, credential: constructed.credential, schema: constructed.schema, construction_args }
    }

    /// `importedCredentialName`: the catalog's name for a credential named locally.
    pub(crate) fn imported_credential_name(&self, local: &str, scope: ScopeId) -> String {
        let name = unwrap_credential_arg(local).unwrap_or_else(|| local.to_string());
        match self.scopes.resolve(scope, &name) {
            Resolution::Found(id) if self.scopes.symbol(id).kind == SymbolKind::Credential => {
                self.scopes.symbol(id).imported_name.clone().unwrap_or(name)
            }
            _ => name,
        }
    }

    /// `checkCredentialArg`.
    fn check_credential_arg(&mut self, adapter: &str, slot: &ExprSlot, scope: ScopeId) {
        let Some(name) = unwrap_credential_arg(slot.raw.trim()) else {
            let repair = self.credential_arg_repair(slot, scope);
            let mut message = "The credential argument must be an imported credential name, not an expression".to_string();
            if let Some((instruction, _)) = &repair {
                message.push_str(&format!(" — {instruction}"));
            }
            let mut diagnostic = Diagnostic::error(codes::CRED_WRONG_ADAPTER, message, slot.span);
            if let Some((_, edits)) = repair {
                diagnostic.fix = Some(json!({ "edits": edits }));
            }
            self.push(diagnostic);
            return;
        };
        let symbol = match self.scopes.resolve(scope, &name) {
            Resolution::Found(id) => self.scopes.symbol(id),
            failure => return self.report_resolution_failure(&name, slot.span, failure),
        };
        if symbol.kind != SymbolKind::Credential {
            let message = format!("'{name}' is {}, not a credential", symbol.kind.describe());
            return self.report(codes::CRED_WRONG_ADAPTER, message, slot.span);
        }
        let imported = symbol.imported_name.clone().unwrap_or_else(|| name.clone());
        if let Some(served) = self.catalog.credential(&imported).map(|c| c.adapters)
            && !served.iter().any(|a| a == adapter)
        {
            self.report(
                codes::CRED_WRONG_ADAPTER,
                format!("'{name}' is a {} credential — '{adapter}' needs a {adapter} credential", served.join(", ")),
                slot.span,
            );
        }
    }

    /// A movement parameter typed against an adapter rather than an instance
    /// (the parameter loop of `checkMovement`). `graph` is what the type's
    /// name resolved to.
    pub fn check_param_source(&mut self, type_: &TypeRef, graph: Option<SymbolId>) {
        let Some(symbol) = graph.map(|id| self.scopes.symbol(id)) else { return };
        if symbol.kind != SymbolKind::Adapter {
            return;
        }
        let adapter = symbol.imported_name.clone().unwrap_or_else(|| symbol.name.clone());
        let position = type_.position.clone().unwrap_or_else(|| if adapter == "cron" { "tick".into() } else { "invocation".into() });
        let message = format!(
            "'{}' is an adapter, not an instance — construct an instance and name it first: 'go = {}', then type the parameter against the name ('<go-[:{position}]->>') and listen to it ('listen to go {{}}')",
            type_.graph,
            self.construction_call(&adapter)
        );
        self.report(codes::ADAPTER_NOT_CONSTRUCTED, message, type_.span);
    }

    /// A bare adapter as a path's root (`checkPathHead`).
    pub fn check_path_root_constructed(&mut self, root: &str, root_symbol: Option<SymbolId>, hops_raw: &str, span: Span) {
        let Some(symbol) = root_symbol.map(|id| self.scopes.symbol(id)) else { return };
        if symbol.kind != SymbolKind::Adapter {
            return;
        }
        let adapter = symbol.imported_name.clone().unwrap_or_else(|| symbol.name.clone());
        let message = format!(
            "'{root}' is an adapter, not an instance — construct and name an instance first, then walk or write from the name: 'go = {}' … 'go{hops_raw}'",
            self.construction_call(&adapter)
        );
        self.report(codes::ADAPTER_NOT_CONSTRUCTED, message, span);
    }

    /// `aiTierDiagnostics` at an `extract` statement, which carries its tier.
    pub fn check_ai_tier(&mut self, written: Option<&str>, span: Span) {
        let Some(written) = written else { return };
        if AI_TIERS.contains(&written) {
            return;
        }
        let tiers = AI_TIERS.iter().map(|t| format!("\"{t}\"")).collect::<Vec<_>>().join(" | ");
        if let Some((_, tier)) = AI_TIER_ALIASES.iter().find(|(old, _)| *old == written) {
            let mut info = Diagnostic::error(
                codes::AI_TIER_LEGACY,
                format!(
                    "\"{written}\" is the old spelling of the \"{tier}\" tier and still means it — write `\"{tier}\"` instead, which is the word the tiers are named in ({tiers})."
                ),
                span,
            );
            info.severity = Some(Severity::Info);
            return self.push(info);
        }
        let mut message = format!("\"{written}\" isn't a tier — expected one of: {tiers}.");
        if let Some(closest) = closest_by_edit_distance(written, AI_TIERS) {
            message.push_str(&format!(" Did you mean \"{closest}\"?"));
        }
        self.report(codes::ENUM_UNKNOWN_VALUE, message, span);
    }
}

/// `staticStringLiteralOf`: the value of a slot that is one string literal.
pub fn static_string_literal_of(slot: &ExprSlot) -> Option<String> {
    match expression_of_slot(slot).ok()? {
        Expression::Static { value: StaticValue::String(value) } => Some(value),
        _ => None,
    }
}

/// Whether a parameter's written type names a value rather than a position
/// (`movementParamValueType` is defined).
// TODO(type-core): the TypeScript asks whether a declared `type` is an enum;
// any declared type stands in for that here.
pub fn is_value_param_type(checker: &Checker<'_>, type_: &ParamTypeRef, scope: ScopeId) -> bool {
    if checker.version < 3 {
        return false;
    }
    let ParamTypeRef::Name(reference) = type_ else { return true };
    if reference.hops_raw.is_some() {
        return false;
    }
    if movement_parser::catalog::helpers::parse_field_type_name(Some(&reference.graph)).is_some() {
        return true;
    }
    matches!(checker.scopes.resolve(scope, &reference.graph), Resolution::Found(id) if checker.scopes.symbol(id).kind == SymbolKind::Type)
}
