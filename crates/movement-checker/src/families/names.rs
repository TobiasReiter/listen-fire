//! Names and scopes: what a name resolves to, and the rules on declaring one.
//!
//! Codes: MOV_NAME_UNRESOLVED, MOV_USE_BEFORE_BIND, MOV_SHADOWED_NAME,
//! MOV_NAME_PROTO, MOV_DUPLICATE_DECL, MOV_REBOUND_NAME, MOV_RESERVED_NAME,
//! MOV_CREDENTIAL_NOT_A_VALUE, MOV_FUNCTION_NAME_COLLISION,
//! MOV_IMPORT_UNKNOWN, MOV_IMPORT_DUPLICATE (and MOV_IMPORT_FILE_UNSUPPORTED,
//! raised by the import statement this module checks).
//!
//! TypeScript: check.ts `resolveName`, `resolveReference`,
//! `reportResolutionFailure`, `declareAuthored`, `checkFunctionName`,
//! `checkImport`, `checkAssign`; scopes.ts.

use movement_parser::ast::{CallArg, CallStatement, ImportSource, ImportStatement, Loc, Span};
use movement_parser::surface::SpellingFinding;
use movement_parser::catalog::helpers::credential_arg_of;
use movement_parser::surface::phrase::{Connection, connection};
use movement_parser::version::{before, since};
use serde_json::json;

use crate::checker::Checker;
use crate::codes;
use crate::diagnostic::Diagnostic;
use crate::scope::{Resolution, ScopeId, Shadowing, Symbol, SymbolId, SymbolKind};
use crate::slots::is_bare_ident;
use crate::version::see_handbook;

/// `RESERVED_NAME_PREFIX`: the engine's own names start with it.
const RESERVED_NAME_PREFIX: &str = "#";

/// The flat built-ins (no namespace) a function may not be named after, in
/// any letter case (standard_library.ts).
const FLAT_BUILTINS: &[&str] = &[
    "ISNULL", "COALESCE", "TRIM", "LOWER", "UPPER", "LENGTH", "ABS", "ROUND", "FLOOR", "CEIL", "TOSTRING", "TONUMBER", "MULTI",
    "SPLIT", "DATE", "DATETIME", "NUMBER", "FIRST", "LAST", "ONLY", "COUNT", "SUM", "AVG", "MIN", "MAX", "JOIN", "COLLECT",
    "LLM_AGG", "AI", "CONCAT", "KG_EXISTS", "KG_VALUE", "EXTRACT_VALUE", "AT", "SORT", "FILE", "READ", "CHUNKS", "EXISTS", "MAP",
    "FILTER", "REDUCE", "GROUPBY", "KEYBY", "MEMBERS", "EXTRACT", "EXTRACTONE",
];

/// Whether `name` calls a built-in: a flat one in any letter case, or a
/// namespaced one (`TEXT.SLUG`).
pub fn is_builtin_name(name: &str) -> bool {
    name.contains('.') || FLAT_BUILTINS.contains(&name.to_uppercase().as_str())
}

/// `spellName`: a name as source text, backticked when it is not bare.
pub fn spell_name(name: &str) -> String {
    if is_bare_ident(name) { name.to_string() } else { format!("`{name}`") }
}

/// `importLine`.
pub fn import_line(name: &str, namespace: &str) -> String {
    format!("import {{ {} }} from {namespace}", spell_name(name))
}

/// `insertLineAtTop`.
fn insert_line_at_top(line: &str) -> serde_json::Value {
    json!({ "span": { "start": { "line": 1, "col": 1 }, "end": { "line": 1, "col": 1 } }, "text": format!("{line}\n") })
}

/// A name that hides a core word or a namespace (language version 5, §4.2).
/// The design allows it with a warning, a call going to the name; refused for
/// now, because the spelling rewrite reads a core word's or a namespace's call
/// before any name is bound (movement_parser::surface::canonical), so a call
/// written with the name would still run the built-in.
fn hides_builtin_message(name: &str, hidden: &str) -> String {
    format!(
        "'{name}' would hide {hidden} — not yet allowed: inside an expression a call written with '{name}' is read as {hidden} before any name is bound, so it would not reach this binding. Name it something else"
    )
}

impl Checker<'_> {
    /// `declareAuthored`: binds a name the author wrote, refusing one that
    /// hides a binding of an enclosing scope. The same-scope binding it
    /// replaced comes back, for the caller's own duplicate rule.
    pub fn declare_authored(&mut self, scope: ScopeId, symbol: Symbol, span: Span) -> Option<SymbolId> {
        if symbol.name == "__proto__" {
            self.report(
                codes::NAME_PROTO,
                "'__proto__' cannot be a name — JavaScript reads that key as an object's prototype, so the engine would lose what it names; give it another name",
                span,
            );
        }
        if since(self.version, 5)
            && let Some(hidden) = movement_parser::surface::table::hidden_by(&symbol.name)
        {
            self.report(codes::V5_HIDES_BUILTIN, hides_builtin_message(&symbol.name, &hidden), span);
        }
        if let Some(shadowing) = self.scopes.shadowing(scope, &symbol.name) {
            let place = match shadowing {
                Shadowing::Bound(id) => {
                    let other = self.scopes.symbol(id);
                    format!("{} at line {}", other.kind.describe(), other.span.start.line)
                }
                Shadowing::Pending => "bound further down this file".to_string(),
            };
            self.report(
                codes::SHADOWED_NAME,
                format!(
                    "'{}' is already {place} — a name means one thing everywhere it is visible, so this one would hide it. Rename it.",
                    symbol.name
                ),
                span,
            );
        }
        let id = self.scopes.add_symbol(symbol);
        self.scopes.declare(scope, id)
    }

    /// `resolveName`: every name a program reads comes through here, so this
    /// is where a credential used as a value is refused.
    pub fn resolve_name(&mut self, name: &str, span: Span, scope: ScopeId) -> Option<SymbolId> {
        let symbol = self.resolve_reference(name, span, scope)?;
        if self.scopes.symbol(symbol).kind != SymbolKind::Credential {
            return Some(symbol);
        }
        self.report(
            codes::CREDENTIAL_NOT_A_VALUE,
            format!(
                "'{name}' is a credential, which is never a value in a program — it is only named {}, and the host resolves it there",
                if since(self.version, 5) {
                    let connect = connection(&Connection { adapter: "…", args: &[("credentials", name)], credential: Some("credentials") }, self.version);
                    format!("after 'using' where an adapter is connected ('{connect}')")
                } else {
                    "as the 'credentials:' argument where an integration is set up".to_string()
                }
            ),
            span,
        );
        None
    }

    /// `resolveReference`: a name resolved without the credential rule.
    pub fn resolve_reference(&mut self, name: &str, span: Span, scope: ScopeId) -> Option<SymbolId> {
        match self.scopes.resolve(scope, name) {
            Resolution::Found(symbol) => Some(symbol),
            failure => {
                self.report_resolution_failure(name, span, failure);
                None
            }
        }
    }

    pub fn report_resolution_failure(&mut self, name: &str, span: Span, resolution: Resolution) {
        match resolution {
            Resolution::Found(_) => {}
            Resolution::Pending => self.report(
                codes::USE_BEFORE_BIND,
                format!(
                    "'{name}' is read before its binding statement — statements run in source order, so move this after the statement that binds '{name}'"
                ),
                span,
            ),
            Resolution::Escaped { block_name } => {
                let hint = match block_name {
                    Some(block) => format!(" — return it from the block instead ('{block} = … {{ … return {name} }}')"),
                    None => format!(" — return it from the block and bind the block ('names = … {{ … return {name} }}')"),
                };
                self.report(
                    codes::NAME_UNRESOLVED,
                    format!("'{name}' is not in scope — it was bound inside a traversal block, and a block's bindings do not escape it{hint}"),
                    span,
                );
            }
            Resolution::Unknown => {
                if self.catalog.adapter(name).is_some() {
                    let message = format!(
                        "'{name}' is not in scope — import it and construct an instance first: {}{}",
                        self.import_and_construct_lines(name),
                        see_handbook("front#systems")
                    );
                    self.report(codes::NAME_UNRESOLVED, message, span);
                } else if self.catalog.credential(name).is_some() {
                    let line = import_line(name, "credentials");
                    let mut diagnostic = Diagnostic::error(
                        codes::NAME_UNRESOLVED,
                        format!("'{name}' is a credential — import it: add '{line}' at the top of the file"),
                        span,
                    );
                    diagnostic.fix = Some(json!({ "edits": [insert_line_at_top(&line)] }));
                    self.push(diagnostic);
                } else if self.catalog.plugin(name).is_some() {
                    self.report(codes::NAME_UNRESOLVED, format!("'{name}' is a plugin — import it: import {{ {name} }} from plugins"), span);
                } else {
                    self.report(
                        codes::NAME_UNRESOLVED,
                        format!(
                            "Unknown name '{name}' — every name must be imported, bound by '=', a movement parameter, or a traversal alias in scope"
                        ),
                        span,
                    );
                }
            }
        }
    }

    /// `constructionCall`: `attio(credentials: …)` with the required
    /// arguments, as the program's version writes it (`connect attio using …`
    /// from 5).
    pub fn construction_call(&self, adapter: &str) -> String {
        let spec = self.catalog.adapter(adapter);
        let required: Vec<(&str, &str)> = spec
            .map(|spec| spec.construction_args.iter().filter(|a| a.required).map(|a| (a.name.as_str(), "…")).collect())
            .unwrap_or_default();
        let credential = spec.and_then(credential_arg_of).map(|a| a.name.as_str());
        connection(&Connection { adapter, args: &required, credential }, self.version)
    }

    /// `importAndConstructLines`.
    fn import_and_construct_lines(&self, adapter: &str) -> String {
        let adapter_import = import_line(adapter, "adapters");
        let general = format!("{adapter_import}, then '<name> = {}'", self.construction_call(adapter));
        let Some(spec) = self.catalog.adapter(adapter) else { return general };
        let Some(credential_arg) = credential_arg_of(spec) else { return general };
        if !credential_arg.required {
            return general;
        }
        let serving: Vec<&str> = self
            .catalog
            .credential_names()
            .into_iter()
            .filter(|name| self.catalog.credential(name).is_some_and(|c| c.adapters.iter().any(|a| a == adapter)))
            .collect();
        let [credential] = serving.as_slice() else { return general };
        let credential_name = spell_name(credential);
        let call: Vec<(&str, &str)> = spec
            .construction_args
            .iter()
            .filter(|a| a.required)
            .map(|a| (a.name.as_str(), if a.name == credential_arg.name { credential_name.as_str() } else { "…" }))
            .collect();
        format!(
            "{general} — with the one {adapter} connection here: '{}' and '<name> = {}'",
            import_line(credential, "credentials"),
            connection(&Connection { adapter, args: &call, credential: Some(&credential_arg.name) }, self.version)
        )
    }

    /// `checkFunctionName`: from version 3 function names are case-insensitive.
    pub fn check_function_name(&mut self, name: &str, span: Span, scope: ScopeId) {
        if before(self.version, 3) {
            return;
        }
        let folded = name.to_uppercase();
        // From version 5 letter case counts: a built-in the spelling table
        // respells is no longer named `upper` in any case, and a name that
        // hides a core word or a namespace is `declare_authored`'s to report.
        let respelled = |builtin: &str| {
            since(self.version, 5)
                && (movement_parser::surface::table::by_canonical(builtin).is_some() || movement_parser::surface::table::hidden_by(name).is_some())
        };
        if let Some(builtin) = FLAT_BUILTINS.iter().find(|b| **b == folded)
            && !respelled(builtin)
        {
            self.report(
                codes::FUNCTION_NAME_COLLISION,
                format!(
                    "'{name}' is the built-in {builtin} — function names are case-insensitive, so a function cannot share a built-in's name in any letter case. Name it something else (an import can rename one: `import {{ x as y }}`)"
                ),
                span,
            );
            return;
        }
        if let Some(other) = self.scopes.resolve_function(scope, name) {
            let other = self.scopes.symbol(other).name.clone();
            if other != name {
                self.report(
                    codes::FUNCTION_NAME_COLLISION,
                    format!(
                        "'{name}' and '{other}' differ only by letter case — function names are case-insensitive, so they would be one name. Rename one of them"
                    ),
                    span,
                );
            }
        }
    }

    /// Notes a call written `written(…)` at `at` where the program binds
    /// `written` itself (language version 5, §4.2: a call goes to what is in
    /// scope), so the spelling finding about that name does not stand there.
    pub fn note_callee(&self, written: &str, at: Loc, scope: ScopeId) {
        if since(self.version, 5) && !matches!(self.scopes.resolve(scope, written), Resolution::Unknown) {
            self.bound_callees.borrow_mut().insert((self.imports.current_path().map(str::to_string), at.line, at.col));
        }
    }

    /// `note_callee` for a call statement and every call among its arguments,
    /// which are read in the same scope.
    pub fn note_call_statement(&self, call: &CallStatement, scope: ScopeId) {
        self.note_callee(&call.callee, call.span.start, scope);
        for arg in &call.args {
            if let CallArg::Call { call: nested, .. } = arg {
                self.note_call_statement(nested, scope);
            }
        }
    }

    /// Whether a spelling finding of the file at `path` (none for the root)
    /// stands: one about a call's bare name does not where the program binds
    /// that name.
    pub fn spelling_stands(&self, finding: &SpellingFinding, path: Option<&str>) -> bool {
        finding.unless_bound.is_none()
            || !self.bound_callees.borrow().contains(&(path.map(str::to_string), finding.span.start.line, finding.span.start.col))
    }

    /// `checkImport`.
    pub fn check_import(&mut self, statement: &ImportStatement, scope: ScopeId) {
        if let ImportSource::File { path } = &statement.source
            && !self.resolves_files
        {
            self.report(
                codes::IMPORT_FILE_UNSUPPORTED,
                format!("File imports are not resolved here — \"{path}\" needs a file resolver; its names are treated as opaque"),
                statement.span,
            );
        }
        for imported in &statement.names {
            let local = imported.alias.clone().unwrap_or_else(|| imported.name.clone());
            let mut library = None;
            let kind = match &statement.source {
                ImportSource::File { .. } => {
                    let (symbol, from) = self.file_import_symbol(&local, &imported.name, statement.span);
                    library = from;
                    symbol.kind
                }
                ImportSource::Builtin { namespace } => {
                    let (kind, known, what) = match namespace.as_str() {
                        "adapters" => (SymbolKind::Adapter, self.catalog.adapter(&imported.name).is_some(), "adapter"),
                        "credentials" => (SymbolKind::Credential, self.catalog.credential(&imported.name).is_some(), "credential"),
                        _ => (SymbolKind::Plugin, self.catalog.plugin(&imported.name).is_some(), "plugin"),
                    };
                    if !known {
                        // From version 5 a plugin is imported by its camelCase
                        // name, read into the catalog's key: the message names
                        // it as written.
                        let named = if what == "plugin" && since(self.version, 5) {
                            movement_parser::surface::table::plugin_name(&imported.name)
                        } else {
                            imported.name.clone()
                        };
                        self.report(codes::IMPORT_UNKNOWN, format!("Unknown {what} '{named}' in '{namespace}'"), statement.span);
                    }
                    kind
                }
            };
            let mut symbol = Symbol::new(local.clone(), kind, statement.span);
            symbol.imported_name = Some(imported.name.clone());
            if symbol.is_function() {
                self.check_function_name(&local, statement.span, scope);
            }
            let existing = self.declare_authored(scope, symbol, statement.span);
            if let Some(library) = library
                && let Some(id) = self.scopes.scope(scope).symbols.get(&local).copied()
            {
                self.adopt_library_symbol(id, library);
            }
            if let Some(existing) = existing {
                let what = self.scopes.symbol(existing).kind.describe();
                self.report(codes::IMPORT_DUPLICATE, format!("Duplicate import '{local}' — already declared as {what}"), statement.span);
            }
        }
    }

    /// The name rules of `checkAssign` that come before its value is checked.
    pub fn check_reserved_name(&mut self, name: &str, span: Span) {
        if name.starts_with(RESERVED_NAME_PREFIX) {
            self.report(
                codes::RESERVED_NAME,
                format!("'{name}' starts with '{RESERVED_NAME_PREFIX}', which marks the engine's own names — pick a name of your own"),
                span,
            );
        }
    }

    /// The binding `checkAssign` declares once its value is checked.
    pub fn declare_binding(&mut self, name: &str, span: Span, bound: &crate::checker::Bound, scope: ScopeId) {
        let kind = if bound.is_instance { SymbolKind::Instance } else { SymbolKind::Binding };
        let mut symbol = Symbol::new(name, kind, span);
        symbol.is_closure = bound.is_closure;
        symbol.adapter = bound.adapter.clone();
        symbol.instance = bound.instance.clone();
        if symbol.is_function() {
            self.check_function_name(name, span, scope);
        }
        if let Some(existing) = self.declare_authored(scope, symbol, span) {
            let existing = self.scopes.symbol(existing);
            let message = format!(
                "'{name}' is already {} at line {} — a binding never changes, so this second one would make the name mean two things. Give it a different name.",
                existing.kind.describe(),
                existing.span.start.line
            );
            self.report(codes::REBOUND_NAME, message, span);
        }
    }

    /// `DUPLICATE_DECL` for a declaration hoisted into a list that already binds the name.
    pub fn report_duplicate_declaration(&mut self, name: &str, existing: SymbolId, span: Span) {
        let what = self.scopes.symbol(existing).kind.describe();
        self.report(codes::DUPLICATE_DECL, format!("'{name}' is already declared as {what}"), span);
    }

    pub fn declare_param(&mut self, scope: ScopeId, name: &str, span: Span, is_closure: bool) {
        let mut symbol = Symbol::new(name, SymbolKind::Param, span);
        symbol.is_closure = is_closure;
        if self.declare_authored(scope, symbol, span).is_some() {
            self.report(codes::DUPLICATE_DECL, format!("Duplicate parameter '{name}'"), span);
        }
    }

    /// `reportUnimportedAdapterConstruction`: `crm = attio(…)` with `attio`
    /// never imported — the import line is the fix.
    pub fn report_unimported_adapter_construction(&mut self, callee: &str, credential_slot: Option<&movement_parser::ast::ExprSlot>, span: Span, scope: ScopeId) {
        let adapter_import = import_line(callee, "adapters");
        let repair = credential_slot.and_then(|slot| self.credential_arg_repair(slot, scope));
        let mut edits = vec![insert_line_at_top(&adapter_import)];
        let mut message = format!("'{callee}' is not in scope — import it: add '{adapter_import}' at the top of the file");
        if let Some((instruction, more)) = repair {
            message.push_str(&format!(", and {instruction}"));
            edits.extend(more);
        }
        let mut diagnostic = Diagnostic::error(codes::NAME_UNRESOLVED, message, span);
        diagnostic.fix = Some(json!({ "edits": edits }));
        self.push(diagnostic);
    }

    /// `credentialArgRepair`.
    pub(crate) fn credential_arg_repair(&self, slot: &movement_parser::ast::ExprSlot, scope: ScopeId) -> Option<(String, Vec<serde_json::Value>)> {
        let raw = slot.raw.trim();
        let quoted = raw
            .strip_prefix('"')
            .and_then(|r| r.strip_suffix('"'))
            .filter(|inner| !inner.contains('"') && !inner.contains('\\'))
            .map(str::to_string);
        let name = match &quoted {
            Some(inner) => inner.clone(),
            None => movement_parser::catalog::helpers::unwrap_credential_arg(raw)?,
        };
        self.catalog.credential(&name)?;
        let imported = matches!(self.scopes.resolve(scope, &name), Resolution::Found(_));
        if quoted.is_none() && imported {
            return None;
        }
        let line = import_line(&name, "credentials");
        let mut steps = Vec::new();
        if quoted.is_some() {
            let keyword = if since(self.version, 5) { "using" } else { "credentials:" };
            steps.push(format!("write the credential as a name, not a string: '{keyword} {}'", spell_name(&name)));
        }
        if !imported {
            steps.push(format!("add '{line}' at the top of the file"));
        }
        let mut edits = Vec::new();
        if !imported {
            edits.push(insert_line_at_top(&line));
        }
        if quoted.is_some() {
            edits.push(json!({ "span": slot.span, "text": spell_name(&name) }));
        }
        Some((steps.join(", and "), edits))
    }
}
