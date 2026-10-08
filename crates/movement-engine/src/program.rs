//! The program a segment runs: the pinned source parsed by movement-parser,
//! joined with what the TypeScript checker found (the `check.program` host
//! call): its diagnostics, its import link, and its STAMPS.
//!
//! The checker mutates the program it checks — a write's spread gains the
//! fields it stands for (`WriteSpread.fields`), a graph's spread what it copies
//! (`MapSpread.copy`), a graph entry holding a record that it is a reference
//! (`NodeEntry.reference`) — and the engine reads all three. The answer carries each as
//! a stamp keyed by the node's AST path: a JSON Pointer (RFC 6901) from the
//! `Program` object through the keys and indices of the program's JSON as the
//! parser emits it (`/statements/2/body/0/write/spreads/1`), with `file`
//! naming the library file for a stamp outside the program run
//! (apps/api/src/services/movement_engine/program_check.ts writes them). A
//! re-parse of the pinned source is the same tree, so the pointer names the
//! same node; each is checked to land on a node of the stamped kind.

use std::collections::BTreeMap;

use movement_parser::ast;
use serde_json::{Value as Json, json};

/// One checker fact.
#[derive(Debug, Clone, PartialEq)]
pub enum Stamp {
    /// A write spread's fields (`WriteSpread.fields`).
    SpreadFields(Vec<String>),
    /// A graph spread's copy plan (`MapSpread.copy`), as data.
    Copy(Json),
    /// A graph entry whose value is a record: an edge holding it
    /// (`NodeEntry.reference`).
    Reference,
}

/// One parsed file: its typed AST, the same tree as JSON (what AST paths
/// point into), and the checker's stamps on it by path.
#[derive(Debug, Clone)]
pub struct File {
    pub program: ast::Program,
    pub tree: Json,
    pub stamps: BTreeMap<String, Stamp>,
}

/// A name the program (or a library) imports from a file, its declaration
/// an AST path into that file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Import {
    pub local: String,
    pub kind: String,
    pub name: String,
    pub file: String,
    pub declaration: String,
}

#[derive(Debug, Clone)]
pub struct Checked {
    pub root: File,
    /// The root's file imports.
    pub imports: Vec<Import>,
    /// Every library file the link resolved, by path, with its own imports.
    pub files: BTreeMap<String, (File, Vec<Import>)>,
    /// Every diagnostic: none blocks (the host ended the run for those).
    pub diagnostics: Vec<Json>,
    /// The run's warning for a deprecated pin (`{code, message}`), as the
    /// host's engine reads its release.
    pub version_warning: Option<(String, String)>,
}

/// `parseProgram`: the typed AST and its JSON, or the parser's refusal as
/// `{message, loc}`.
pub fn parse(source: &str, language_version: u32) -> Result<File, Json> {
    let program = movement_parser::stmt::parse_program(source, language_version, false).map_err(|e| json!(e))?;
    let tree = serde_json::to_value(&program).expect("an AST is always JSON");
    Ok(File { program, tree, stamps: BTreeMap::new() })
}

/// The program joined with the check's answer: its link's files parsed under
/// the program's version, and every stamp placed.
pub fn join_check(root: File, answer: &Json, language_version: u32) -> Result<Checked, String> {
    let diagnostics = answer.get("diagnostics").and_then(Json::as_array).cloned().ok_or("the check answer has no diagnostics")?;
    let version_warning = match answer.get("versionWarning") {
        None => None,
        Some(warning) => {
            let text = |key: &str| warning.get(key).and_then(Json::as_str).map(String::from);
            Some((text("code").ok_or("a version warning has no code")?, text("message").ok_or("a version warning has no message")?))
        }
    };
    let mut checked = Checked { root, imports: Vec::new(), files: BTreeMap::new(), diagnostics, version_warning };
    if let Some(link) = answer.get("link") {
        checked.imports = imports_of(link.get("imports"))?;
        for file in link.get("files").and_then(Json::as_array).ok_or("the link has no files")? {
            let path = text(file, "path")?;
            let parsed = parse(&text(file, "source")?, language_version)
                .map_err(|e| format!("the library \"{path}\" does not parse as it did for the check: {e}"))?;
            checked.files.insert(path, (parsed, imports_of(file.get("imports"))?));
        }
    }
    for stamp in answer.get("stamps").and_then(Json::as_array).ok_or("the check answer has no stamps")? {
        let path = text(stamp, "path")?;
        let file = match stamp.get("file") {
            None => &mut checked.root,
            Some(Json::String(name)) => {
                &mut checked.files.get_mut(name).ok_or_else(|| format!("a stamp names the unlinked file \"{name}\""))?.0
            }
            Some(other) => return Err(format!("a stamp's file is a path, not {other}")),
        };
        let node = file.tree.pointer(&path).ok_or_else(|| format!("no node at {path}"))?;
        let stamped = match (stamp.get("spreadFields"), stamp.get("copy"), stamp.get("reference")) {
            (Some(fields), None, None) if is_write_spread(&path, node) => Stamp::SpreadFields(
                serde_json::from_value(fields.clone()).map_err(|e| format!("the fields stamped at {path}: {e}"))?,
            ),
            (None, Some(copy), None) if is_map_spread(node) => Stamp::Copy(copy.clone()),
            (None, None, Some(Json::Bool(true))) if is_value_entry(node) => Stamp::Reference,
            _ => return Err(format!("the stamp at {path} does not fit the node there: {stamp}")),
        };
        file.stamps.insert(path, stamped);
    }
    Ok(checked)
}

/// An element of a `spreads` list naming its source: a write's spread.
fn is_write_spread(path: &str, node: &Json) -> bool {
    let mut tokens = path.rsplit('/');
    tokens.next().is_some_and(|i| i.parse::<usize>().is_ok())
        && tokens.next() == Some("spreads")
        && node.get("source").is_some_and(Json::is_string)
        && node.get("after").is_none()
}

/// A graph's spread: it says where among the entries it stands.
fn is_map_spread(node: &Json) -> bool {
    node.get("source").is_some_and(Json::is_string) && node.get("after").is_some_and(Json::is_u64)
}

/// A graph literal's `name: value` entry.
fn is_value_entry(node: &Json) -> bool {
    node.get("kind").and_then(Json::as_str) == Some("value") && node.get("name").is_some_and(Json::is_string)
}

fn imports_of(list: Option<&Json>) -> Result<Vec<Import>, String> {
    list.and_then(Json::as_array)
        .ok_or("an import list is missing")?
        .iter()
        .map(|i| {
            Ok(Import {
                local: text(i, "local")?,
                kind: text(i, "kind")?,
                name: text(i, "name")?,
                file: text(i, "file")?,
                declaration: text(i, "declaration")?,
            })
        })
        .collect()
}

fn text(json: &Json, key: &str) -> Result<String, String> {
    json.get(key).and_then(Json::as_str).map(str::to_string).ok_or_else(|| format!("{json} has no `{key}`"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const SOURCE: &str = "import { attio } from adapters\ncrm = attio()\nfunction f(d: <Deal>) {\n  write crm-[:companies]-> { ...d }\n}\nmovement m(e: <crm>) {\n  x = 1\n}";

    #[test]
    fn stamps_land_on_the_nodes_their_paths_name() {
        let root = parse(SOURCE, 3).unwrap();
        assert_eq!(root.tree.pointer("/statements/2/body/0/write/spreads/0/source"), Some(&json!("d")));
        let answer = json!({
            "diagnostics": [{ "code": "MOV_X", "severity": "warning" }],
            "stamps": [{ "path": "/statements/2/body/0/write/spreads/0", "spreadFields": ["name", "stage"] }],
        });
        let checked = join_check(root, &answer, 3).unwrap();
        assert_eq!(
            checked.root.stamps.get("/statements/2/body/0/write/spreads/0"),
            Some(&Stamp::SpreadFields(vec!["name".into(), "stage".into()]))
        );
        assert_eq!(checked.diagnostics.len(), 1);
    }

    #[test]
    fn a_reference_stamp_lands_on_a_graph_entry() {
        let source = "import { attio } from adapters\ncrm = attio()\nmovement m(e: <crm>) {\n  if 1 == 1 {\n    g = graph { owner: e }\n  }\n}";
        let path = "/statements/2/body/0/arms/0/body/0/value/node/entries/0";
        let answer = json!({ "diagnostics": [], "stamps": [{ "path": path, "reference": true }] });
        let checked = join_check(parse(source, 3).unwrap(), &answer, 3).unwrap();
        assert_eq!(checked.root.stamps.get(path), Some(&Stamp::Reference));
        let spread = json!({ "diagnostics": [], "stamps": [{ "path": "/statements/2/body/0/arms/0/body/0/value/node", "reference": true }] });
        assert!(join_check(parse(source, 3).unwrap(), &spread, 3).unwrap_err().contains("does not fit"));
    }

    #[test]
    fn a_stamp_that_does_not_fit_is_refused() {
        let wrong_kind = json!({ "diagnostics": [], "stamps": [{ "path": "/statements/2/body/0/write/spreads/0", "copy": {} }] });
        assert!(join_check(parse(SOURCE, 3).unwrap(), &wrong_kind, 3).unwrap_err().contains("does not fit"));
        let nowhere = json!({ "diagnostics": [], "stamps": [{ "path": "/statements/9", "spreadFields": [] }] });
        assert_eq!(join_check(parse(SOURCE, 3).unwrap(), &nowhere, 3).unwrap_err(), "no node at /statements/9");
        let unlinked = json!({ "diagnostics": [], "stamps": [{ "file": "lib", "path": "", "spreadFields": [] }] });
        assert!(join_check(parse(SOURCE, 3).unwrap(), &unlinked, 3).unwrap_err().contains("unlinked file"));
    }

    #[test]
    fn the_link_parses_its_files_and_keeps_declarations_as_paths() {
        let answer = json!({
            "diagnostics": [],
            "link": {
                "imports": [{ "local": "Deal", "kind": "shape", "name": "Deal", "file": "deals", "declaration": "/statements/0" }],
                "files": [{ "path": "deals", "source": "export node Deal {\n  name: <text>\n}", "imports": [], "exports": [] }],
            },
            "stamps": [],
        });
        let checked = join_check(parse(SOURCE, 3).unwrap(), &answer, 3).unwrap();
        assert_eq!(checked.imports[0].declaration, "/statements/0");
        let (deals, _) = &checked.files["deals"];
        assert_eq!(deals.tree.pointer("/statements/0/name"), Some(&json!("Deal")));
    }
}
