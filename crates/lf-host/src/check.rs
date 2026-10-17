//! `lf-host check`: every diagnostic the project's files have, by the Rust
//! checker natively (the same `check_source` the engine artifact's
//! `check_program` export runs), against the catalog the externals answer.
//! Output and exit code are the TypeScript `lf check`'s (apps/cli/src/main.rs).

use std::io::Write;

use indexmap::IndexMap;
use movement_checker::host::native::NativeZones;
use movement_checker::{CheckOptions, Severity};
use movement_parser::ast::Program;
use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::util::form::{external_text, form_of_text, read_json_text};
use serde_json::json;

use crate::catalog::catalog_of;
use crate::externals::{RunningExternal, rpc, scan_externals, start_externals};
use crate::json::Js;
use crate::project::Project;
use crate::protocol::shape_error;
use crate::schema::describe_external_schema;
use crate::secrets::{Credentials, load_secrets, missing_credentials};
use crate::sources::{MovementFile, scan_movements};

/// The one tenant a local project is (`LOCAL_TENANT`).
pub const LOCAL_TENANT: &str = "local";

/// A parse refusal, worded as `MovementParseError` words it.
pub struct ParseError {
    pub message: String,
    pub line: usize,
    pub column: usize,
}

/// The program, parsed as the TypeScript `parseProgram` parses it (eagerly,
/// over the engine's text form).
pub fn parse(source: &str, language_version: u32) -> Result<Program, ParseError> {
    movement_parser::stmt::parse_program(&form_of_text(source), language_version, true).map_err(|e| ParseError {
        message: format!("{} (line {}, col {})", external_text(&e.message), e.loc.line, e.loc.col),
        line: e.loc.line,
        column: e.loc.col,
    })
}

pub struct FileDiagnostic {
    pub line: usize,
    pub column: usize,
    pub code: String,
    pub message: String,
    pub severity: &'static str,
}

/// Every diagnostic one file has. A file that does not parse has one, its parse refusal.
pub fn check_file(file: &MovementFile, catalog: &CatalogSnapshot, language_version: u32) -> Result<Vec<FileDiagnostic>, String> {
    if let Err(refused) = parse(&file.source, language_version) {
        return Ok(vec![FileDiagnostic { line: refused.line, column: refused.column, code: "MOV_PARSE".into(), message: refused.message, severity: "error" }]);
    }
    let options = CheckOptions { language_version, upgrading_from: None, parse_version: None, zones: &NativeZones };
    let diagnostics = movement_checker::check_source(&file.source, catalog, options)
        .map_err(|refusal| format!("the Rust checker refused {}: {}", file.path.display(), refusal.message))?;
    Ok(diagnostics
        .into_iter()
        .map(|d| FileDiagnostic {
            line: d.span.start.line,
            column: d.span.start.col,
            message: external_text(&d.message).into_owned(),
            code: d.code,
            severity: match d.severity {
                None => "error",
                Some(Severity::Warning) => "warning",
                Some(Severity::Info) => "info",
            },
        })
        .collect())
}

/// What `check` reads: the project's files and the catalog they check against.
pub struct Checking {
    pub files: Vec<MovementFile>,
    pub catalog: Js,
    /// Held so the started externals live until the check is done.
    pub _running: Vec<RunningExternal>,
}

pub enum Opened {
    Ready(Checking),
    /// Credentials the files name that the secrets lack, printed as the check's errors.
    MissingCredentials(Vec<String>),
}

pub async fn open_checking(project: &Project) -> Result<Opened, String> {
    let env: Vec<(String, String)> = std::env::vars().collect();
    let credentials = load_secrets(project, &env)?;
    let files = scan_movements(project)?;
    let missing = missing_credentials(project, &files, &credentials, &env);
    if !missing.is_empty() {
        let lines = missing.iter().map(|m| format!("{}:{}:{} error MISSING_CREDENTIAL {}", m.file.display(), m.line, m.column, m.message)).collect();
        return Ok(Opened::MissingCredentials(lines));
    }
    let externals = scan_externals(project)?;
    let running = start_externals(project, &externals, &credentials, LOCAL_TENANT).await?;
    let mut schemas = IndexMap::new();
    for r in &running {
        schemas.insert(r.external.manifest.name.clone(), describe_external(r, &credentials).await?);
    }
    // Scanned again after the externals start, as the TypeScript session does.
    let files = scan_movements(project)?;
    let catalog = catalog_of(&running, &schemas, &credentials, &files);
    Ok(Opened::Ready(Checking { files, catalog, _running: running }))
}

/// `describeExternal`: its entry points and one `describe` per entry point,
/// projected as the hosted product projects them.
pub async fn describe_external(running: &RunningExternal, credentials: &Credentials) -> Result<Js, String> {
    let name = &running.external.manifest.name;
    let entries = rpc(running, credentials, LOCAL_TENANT, "listEntryPoints", json!({})).await?;
    let entry_list = entries
        .as_array()
        .filter(|list| list.iter().all(is_entry_point))
        .ok_or_else(|| shape_error("listEntryPoints", name, &entries, "expected an array of { typeId, displayName, writable, readable }"))?
        .to_vec();
    let mut descriptors = IndexMap::new();
    for entry in &entry_list {
        let type_id = entry.get("typeId").and_then(Js::as_str).unwrap_or_default().to_string();
        let descriptor = rpc(running, credentials, LOCAL_TENANT, "describe", json!({ "typeId": type_id })).await?;
        match &descriptor {
            Js::Null => {}
            d if is_type_descriptor(d) => {
                descriptors.insert(type_id, descriptor);
            }
            _ => return Err(shape_error("describe", name, &descriptor, "expected null or { typeId, displayName, fields, references }")),
        }
    }
    Ok(describe_external_schema(name, &entry_list, &descriptors))
}

/// `WireSchemaEntryPoint`'s envelope (the rest passes through).
fn is_entry_point(entry: &Js) -> bool {
    let string = |k: &str| entry.get(k).and_then(Js::as_str).is_some();
    let boolean = |k: &str| matches!(entry.get(k), Some(Js::Bool(_)));
    string("typeId") && string("displayName") && boolean("writable") && boolean("readable")
}

/// `WireSchemaTypeDescriptor`'s envelope (the rest passes through).
fn is_type_descriptor(descriptor: &Js) -> bool {
    let string = |v: Option<&Js>| v.and_then(Js::as_str).is_some();
    let all_have_field_id = |k: &str| descriptor.get(k).and_then(Js::as_array).is_some_and(|items| items.iter().all(|i| string(i.get("fieldId"))));
    string(descriptor.get("typeId"))
        && string(descriptor.get("displayName"))
        && all_have_field_id("fields")
        && all_have_field_id("references")
        && descriptor.get("deletable").is_none_or(|d| matches!(d, Js::Bool(_)))
}

/// The command: prints each diagnostic and the count, as `lf check` does.
pub async fn run(project: &Project, out: &mut impl Write) -> Result<i32, String> {
    let checking = match open_checking(project).await? {
        Opened::MissingCredentials(lines) => {
            for line in &lines {
                writeln!(out, "{line}").map_err(|e| e.to_string())?;
            }
            writeln!(out, "{} error(s)", lines.len()).map_err(|e| e.to_string())?;
            return Ok(1);
        }
        Opened::Ready(checking) => checking,
    };
    let catalog = CatalogSnapshot::load(&read_json_text(&checking.catalog.to_json())).map_err(|e| format!("the catalog does not load: {e}"))?;
    let mut errors = 0;
    for file in &checking.files {
        for d in check_file(file, &catalog, project.language_version)? {
            if d.severity == "error" {
                errors += 1;
            }
            writeln!(out, "{}:{}:{} {} {} {}", file.path.display(), d.line, d.column, d.severity, d.code, d.message).map_err(|e| e.to_string())?;
        }
    }
    writeln!(out, "{} file(s), {errors} error(s)", checking.files.len()).map_err(|e| e.to_string())?;
    Ok(if errors > 0 { 1 } else { 0 })
}
