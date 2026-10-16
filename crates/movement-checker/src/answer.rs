//! The check as data for the engine: the TypeScript's `checkAnswer`
//! (packages/movement-engine/services/movement_engine/program_check.ts).
//! Besides its diagnostics, the check settles facts on nodes that the engine
//! reads when it runs them, and the TypeScript records them by mutating its
//! AST:
//!
//! - on a write's spread, the fields it writes (`spreadFields`);
//! - on a graph's spread of a record, what it copies (`copy`, a copy plan);
//! - on a graph entry whose value is a record, that the entry is an edge
//!   holding it (`reference`).
//!
//! The engine re-parses the source, so these cross as STAMPS keyed by the
//! node's place in the program's JSON (a JSON Pointer; through a nested
//! call's read, `<slot>/nested/<start>-<end>/value`). This checker never
//! mutates its AST: it records each fact by the node's span, with the
//! nested calls it was checked inside, and places it in the tree after the
//! walk. With the stamps goes the import link: each imported name's
//! declaration as a path into its library, and each library's source.

use serde_json::{Value as Json, json};

use movement_parser::ast::{Program, Span, Statement};
use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::tree::At;

use crate::checker::Checker;
use crate::families::imports::{LinkedExport, ProgramLink};
use crate::{CheckOptions, Diagnostic};

/// A fact the check settles on one node.
#[derive(Debug, Clone, PartialEq)]
pub enum StampKind {
    SpreadFields(Vec<String>),
    /// A copy plan: `{fields, edges: {name: plan}}`.
    Copy(Json),
    Reference,
}

impl StampKind {
    fn same_kind(&self, other: &StampKind) -> bool {
        std::mem::discriminant(self) == std::mem::discriminant(other)
    }
}

/// One stamp as recorded: the file (none for the program checked), the
/// nested calls it was checked inside (each the slot's span and the call's
/// extent in its text, outermost first), and the node's span.
#[derive(Debug, Clone)]
struct Recorded {
    file: Option<String>,
    nested: Vec<(Span, At)>,
    span: Span,
    kind: StampKind,
}

/// What a walk of a movement's body replaced: the file a stamp was in
/// (none: no such walk) and the nested calls.
type Outer = (Option<Option<String>>, Vec<(Span, At)>);

/// The stamps the walk records, and the nested calls it is inside now.
#[derive(Default)]
pub struct Stamps {
    nested: Vec<(Span, At)>,
    recorded: Vec<Recorded>,
    /// The file each movement is declared in (none: the program checked).
    declared_in: std::collections::HashMap<crate::scope::SymbolId, Option<String>>,
    /// A movement's body walked from elsewhere (to learn what a call to it
    /// returns) is still its declaration's: the state each such walk
    /// replaced, innermost last.
    walking: Vec<Outer>,
    /// Inside such a walk, the file it is in (none: the program checked).
    file: Option<Option<String>>,
}

impl Checker<'_> {
    /// Records `kind` on the node at `span`. A node stamped again keeps the
    /// later fact, as the TypeScript's mutation does.
    pub fn stamp(&mut self, span: Span, kind: StampKind) {
        let file = match &self.stamps.file {
            Some(file) => file.clone(),
            None => self.imports.current_path().map(str::to_string),
        };
        let nested = self.stamps.nested.clone();
        let recorded = &mut self.stamps.recorded;
        if let Some(earlier) = recorded.iter_mut().find(|r| r.span == span && r.kind.same_kind(&kind) && r.file == file && r.nested == nested) {
            earlier.kind = kind;
            return;
        }
        recorded.push(Recorded { file, nested, span, kind });
    }

    /// Checking the call at `at` in the slot at `slot`: a stamp recorded
    /// until `leave_nested_call` is in its read.
    pub fn enter_nested_call(&mut self, slot: Span, at: At) {
        self.stamps.nested.push((slot, at));
    }

    pub fn leave_nested_call(&mut self) {
        self.stamps.nested.pop();
    }

    /// Movement `id` is declared in the file being checked now.
    pub fn note_declared_file(&mut self, id: crate::scope::SymbolId) {
        let file = self.imports.current_path().map(str::to_string);
        self.stamps.declared_in.entry(id).or_insert(file);
    }

    /// Walking movement `id`'s body: a stamp is in the file it is declared
    /// in, outside any nested call of the walk that reached it.
    pub fn enter_declared_file(&mut self, id: crate::scope::SymbolId) {
        let file = self.stamps.declared_in.get(&id).cloned().unwrap_or(None);
        let outer_nested = std::mem::take(&mut self.stamps.nested);
        let outer_file = self.stamps.file.replace(file);
        self.stamps.walking.push((outer_file, outer_nested));
    }

    pub fn leave_declared_file(&mut self) {
        if let Some((file, nested)) = self.stamps.walking.pop() {
            self.stamps.file = file;
            self.stamps.nested = nested;
        }
    }
}

/// `checkAnswer`: `{diagnostics, stamps, link?}` for `program`, as the
/// TypeScript's check answers the engine. A stamp whose node is not where
/// the walk recorded it is left out, and named in `unplaced` for a test to
/// find (never sent).
pub fn check_answer(program: &Program, catalog: &CatalogSnapshot, options: CheckOptions) -> Answer {
    let (diagnostics, checker) = crate::run_check(program, catalog, options);
    let version = options.parse_version.unwrap_or(options.language_version);
    let link = checker.imports.link();
    let root = serde_json::to_value(program).expect("an AST is always JSON");
    let mut library_trees: std::collections::HashMap<&str, Json> = std::collections::HashMap::new();
    if let Some(link) = link {
        for (path, file) in &link.files {
            library_trees.insert(path.as_str(), serde_json::to_value(&file.program).expect("an AST is always JSON"));
        }
    }
    let mut stamps = Vec::new();
    let mut unplaced = Vec::new();
    for recorded in &checker.stamps.recorded {
        let tree = match &recorded.file {
            None => Some(&root),
            Some(path) => library_trees.get(path.as_str()),
        };
        match tree.and_then(|tree| place(tree, &recorded.nested, &recorded.span, &recorded.kind, version)) {
            Some(path) => stamps.push(stamp_json(recorded, path)),
            None => unplaced.push(format!("{:?} at {:?} in {:?} (nested {:?})", recorded.kind, recorded.span, recorded.file, recorded.nested)),
        }
    }
    let link = link.map(|link| link_json(link, catalog));
    Answer { diagnostics, stamps, link, unplaced }
}

/// What `check_answer` answers.
pub struct Answer {
    pub diagnostics: Vec<Diagnostic>,
    pub stamps: Vec<Json>,
    pub link: Option<Json>,
    pub unplaced: Vec<String>,
}

impl Answer {
    /// As the TypeScript's `CheckAnswer` is written.
    pub fn to_json(&self) -> Json {
        let mut answer = json!({ "diagnostics": self.diagnostics, "stamps": self.stamps });
        if let Some(link) = &self.link {
            answer["link"] = link.clone();
        }
        answer
    }
}

fn stamp_json(recorded: &Recorded, path: String) -> Json {
    let mut stamp = json!({ "path": path });
    if let Some(file) = &recorded.file {
        stamp["file"] = json!(file);
    }
    match &recorded.kind {
        StampKind::SpreadFields(fields) => stamp["spreadFields"] = json!(fields),
        StampKind::Copy(plan) => stamp["copy"] = plan.clone(),
        StampKind::Reference => stamp["reference"] = json!(true),
    }
    stamp
}

/// The path of the node `kind` stamps at `span`, inside the nested calls
/// `nested` reads, in `tree`.
fn place(tree: &Json, nested: &[(Span, At)], span: &Span, kind: &StampKind, version: u32) -> Option<String> {
    let mut prefix = String::new();
    let mut read: std::borrow::Cow<'_, Json> = std::borrow::Cow::Borrowed(tree);
    for (slot_span, at) in nested {
        let slot_span = serde_json::to_value(slot_span).expect("a span is JSON");
        let (slot_path, slot) = find(&read, "", &|node, _| is_slot(node) && node.get("span") == Some(&slot_span))?;
        let value = nested_call(slot, *at, version)?;
        prefix = format!("{prefix}{slot_path}/nested/{}-{}/value", at.start, at.end);
        read = std::borrow::Cow::Owned(value);
    }
    let span = serde_json::to_value(span).expect("a span is JSON");
    let fits = |node: &Json, path: &str| {
        node.get("span") == Some(&span)
            && match kind {
                StampKind::SpreadFields(_) => is_write_spread(node, path),
                StampKind::Copy(_) => is_map_spread(node),
                StampKind::Reference => is_value_entry(node),
            }
    };
    let (path, _) = find(&read, "", &fits)?;
    Some(format!("{prefix}{path}"))
}

/// The first node in `node` (at `path`), depth first, that `fits`.
fn find<'j>(node: &'j Json, path: &str, fits: &dyn Fn(&Json, &str) -> bool) -> Option<(String, &'j Json)> {
    if fits(node, path) {
        return Some((path.to_string(), node));
    }
    match node {
        Json::Object(object) => object.iter().find_map(|(key, child)| find(child, &format!("{path}/{}", key.replace('~', "~0").replace('/', "~1")), fits)),
        Json::Array(items) => items.iter().enumerate().find_map(|(index, child)| find(child, &format!("{path}/{index}"), fits)),
        _ => None,
    }
}

/// An expression slot as the parser writes one.
fn is_slot(node: &Json) -> bool {
    node.get("raw").is_some_and(Json::is_string) && node.get("span").is_some_and(Json::is_object)
}

/// An element of a `spreads` list naming its source: a write's spread.
fn is_write_spread(node: &Json, path: &str) -> bool {
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

/// The nested call at `at` in the slot `slot` (its JSON), read as the
/// check read it (`hoist_nested_calls`), as JSON.
fn nested_call(slot: &Json, at: At, version: u32) -> Option<Json> {
    let raw = slot.get("raw")?.as_str()?;
    let start: movement_parser::ast::Loc = loc(slot.get("span")?.get("start")?)?;
    let units: Vec<u16> = raw.encode_utf16().collect();
    let head = String::from_utf16_lossy(units.get(..at.end)?);
    let value = movement_parser::stmt::Parser::new(&head, version, start, true).parse_nested_call_value(at.start).ok()?;
    Some(serde_json::to_value(&value).expect("an AST is always JSON"))
}

fn loc(at: &Json) -> Option<movement_parser::ast::Loc> {
    Some(movement_parser::ast::Loc { line: usize::try_from(at.get("line")?.as_u64()?).ok()?, col: usize::try_from(at.get("col")?.as_u64()?).ok()? })
}

/// `LinkData`: the program's imports, and each library with its source,
/// imports and exports, every declaration a path into its file.
fn link_json(link: &ProgramLink, catalog: &CatalogSnapshot) -> Json {
    let mut paths: Vec<&String> = link.files.keys().collect();
    paths.sort();
    let files: Vec<Json> = paths
        .into_iter()
        .filter_map(|path| {
            let file = &link.files[path];
            let source = catalog.files.as_ref()?.get(path)?.source.clone();
            let exports: Vec<Json> = file
                .program
                .statements
                .iter()
                .enumerate()
                .filter_map(|(index, statement)| {
                    let (name, kind) = exported(statement)?;
                    Some(json!({ "name": name, "kind": kind, "declaration": format!("/statements/{index}") }))
                })
                .collect();
            Some(json!({ "path": path, "source": movement_parser::util::form::form_of_text(&source), "imports": imports_json(&file.imports, link), "exports": exports }))
        })
        .collect();
    json!({ "imports": imports_json(&link.imports, link), "files": files })
}

fn imports_json(imports: &indexmap::IndexMap<String, LinkedExport>, link: &ProgramLink) -> Vec<Json> {
    imports
        .iter()
        .filter_map(|(local, exported_as)| {
            let file = link.files.get(&exported_as.file)?;
            let kind = if exported_as.is_movement { "movement" } else { "shape" };
            let index = file.program.statements.iter().position(|s| exported(s) == Some((exported_as.name.as_str(), kind)))?;
            Some(json!({ "local": local, "kind": kind, "name": exported_as.name, "file": exported_as.file, "declaration": format!("/statements/{index}") }))
        })
        .collect()
}

/// A movement or node declaration marked `export`: its name and kind.
fn exported(statement: &Statement) -> Option<(&str, &'static str)> {
    match statement {
        Statement::Movement(m) if m.exported == Some(true) => Some((m.name.as_str(), "movement")),
        Statement::Shape(s) if s.exported == Some(true) => Some((s.name.as_str(), "shape")),
        _ => None,
    }
}
