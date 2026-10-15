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
//!
//! What the file declares for the constructs that read it — its shapes, its
//! `type`s, the plugins it imports — is gathered once (`Declarations`); the
//! checker writes nothing on a declaration, so the parse is all there is.

use std::collections::BTreeMap;

use movement_parser::ast;
use serde_json::{Value as Json, json};

/// The AST node at `path` in `file`, as the TypeScript holds it: the
/// parser's JSON (its keys in the order the parser writes them, which is
/// sorted) with the checker's stamps on it after (`stampsIn` writes keys no
/// parser writes, so the TypeScript appends them).
pub fn code_at(file: &File, path: &str) -> Option<crate::js::Js> {
    let node = node_at(file, path)?;
    let mut code = crate::env::js_of_json(&node);
    for (at, stamp) in &file.stamps {
        let Some(rest) = at.strip_prefix(path) else { continue };
        if !(rest.is_empty() || rest.starts_with('/')) {
            continue;
        }
        let steps: Vec<String> = rest.split('/').skip(1).map(|t| t.replace("~1", "/").replace("~0", "~")).collect();
        let (key, value) = match stamp {
            Stamp::SpreadFields(fields) => ("fields", crate::js::Js::array(fields.iter().map(|f| crate::js::Js::str(f.clone())).collect())),
            Stamp::Copy(copy) => ("copy", copy_plan_js(copy)),
            Stamp::Reference => ("reference", crate::js::Js::Bool(true)),
        };
        code = stamped(&code, &steps, key, value);
    }
    Some(code)
}

/// A copy plan as the checker writes it: `{ fields, edges }` in that order
/// (`copyPlanOf`), each edge's plan likewise. The plan reaches Rust through
/// serde_json with its keys sorted (`edges` before `fields`), and a parked
/// closure holding the plan must hold the same bytes the TypeScript parks.
/// (The edge names inside `edges` keep the sorted order; the wire does not
/// carry the declaration order.)
fn copy_plan_js(plan: &Json) -> crate::js::Js {
    let Json::Object(map) = plan else { return crate::env::js_of_json(plan) };
    let mut object = crate::js::JsObject::new();
    for key in ["fields", "edges"] {
        let Some(value) = map.get(key) else { continue };
        let value = match (key, value) {
            ("edges", Json::Object(edges)) => {
                let mut nested = crate::js::JsObject::new();
                for (name, edge) in edges {
                    nested.set(name.clone(), copy_plan_js(edge));
                }
                crate::js::Js::object(nested)
            }
            _ => crate::env::js_of_json(value),
        };
        object.set(key.to_string(), value);
    }
    for (key, value) in map {
        if key != "fields" && key != "edges" {
            object.set(key.clone(), crate::env::js_of_json(value));
        }
    }
    crate::js::Js::object(object)
}

/// The node at `path` in `file`'s tree. A call nested in an expression
/// (language version 3) has a place of its own, through the slot it is
/// written in: `<slot>/nested/<start>-<end>` is `{ value: <the right-hand
/// side the call reads as> }`, `start` and `end` its extent in the slot's
/// text (program_check.ts), re-read from the slot as the TypeScript read it
/// for the check (`parseNestedCall`).
pub fn node_at(file: &File, path: &str) -> Option<Json> {
    if path.is_empty() {
        return Some(file.tree.clone());
    }
    let mut tokens = path.strip_prefix('/')?.split('/');
    let mut node = std::borrow::Cow::Borrowed(&file.tree);
    while let Some(token) = tokens.next() {
        let step = token.replace("~1", "/").replace("~0", "~");
        if step == "nested" && let Some(slot) = slot_of(&node) {
            let (start, end) = tokens.next()?.split_once('-')?;
            let at = movement_parser::tree::At { start: start.parse().ok()?, end: end.parse().ok()? };
            let value = crate::nested::nested_call(&slot, at, file.version).ok()?;
            node = std::borrow::Cow::Owned(json!({ "value": serde_json::to_value(&value).expect("an AST is always JSON") }));
            continue;
        }
        node = match node {
            std::borrow::Cow::Borrowed(of) => std::borrow::Cow::Borrowed(step_into(of, &step)?),
            std::borrow::Cow::Owned(of) => std::borrow::Cow::Owned(step_into(&of, &step)?.clone()),
        };
    }
    Some(node.into_owned())
}

/// One pointer step into `node`.
fn step_into<'j>(node: &'j Json, step: &str) -> Option<&'j Json> {
    match node {
        Json::Object(object) => object.get(step),
        Json::Array(list) => list.get(step.parse::<usize>().ok()?),
        _ => None,
    }
}

/// The expression slot a node of the tree is, when it is one.
pub(crate) fn slot_of(node: &Json) -> Option<ast::ExprSlot> {
    let raw = node.get("raw")?.as_str()?;
    let span = node.get("span")?;
    let loc = |at: &Json| -> Option<ast::Loc> { Some(ast::Loc { line: at.get("line")?.as_u64()? as usize, col: at.get("col")?.as_u64()? as usize }) };
    Some(ast::ExprSlot {
        raw: raw.to_string(),
        span: ast::Span { start: loc(span.get("start")?)?, end: loc(span.get("end")?)? },
        eager: node.get("__slot").and_then(Json::as_bool).unwrap_or(false),
    })
}

/// `node` with `key: value` set on the object `steps` lead to.
fn stamped(node: &crate::js::Js, steps: &[String], key: &str, value: crate::js::Js) -> crate::js::Js {
    use crate::js::{Js, JsObject};
    match (node, steps.split_first()) {
        (Js::Object(object), None) => {
            let mut copy = JsObject::clone_of(object);
            copy.set(key.to_string(), value);
            Js::object(copy)
        }
        (Js::Object(object), Some((step, rest))) => {
            let mut copy = JsObject::clone_of(object);
            if let Some(child) = object.get(step) {
                copy.set(step.clone(), stamped(child, rest, key, value));
            }
            Js::object(copy)
        }
        (Js::Array(list), Some((step, rest))) => {
            let mut items = list.items().clone();
            if let Some(child) = step.parse::<usize>().ok().and_then(|i| items.get_mut(i)) {
                *child = stamped(child, rest, key, value);
            }
            Js::array(items)
        }
        (other, _) => other.clone(),
    }
}

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
    /// The language version it was parsed under: what its nested calls are
    /// re-read under (`node_at`).
    pub version: u32,
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
    /// What the root file declares, and the shapes it imports.
    pub declarations: Declarations,
    /// The code a resume rebuilt from its parked state (a closure, a kept
    /// walk), each its own file (`DeclaringFile::Parked`), in the order the
    /// resume read it.
    pub parked: std::cell::RefCell<Vec<std::rc::Rc<File>>>,
}

impl Checked {
    /// A file of the program, by who wrote it: the root, or a linked
    /// library (a parked piece of code is no file of the program).
    pub fn file(&self, file: &DeclaringFile) -> Option<&File> {
        match file {
            DeclaringFile::Root => Some(&self.root),
            DeclaringFile::Library(path) => self.files.get(path).map(|(file, _)| file),
            DeclaringFile::Parked(_) => None,
        }
    }

    /// `read` over any file of the run, a parked piece of code's included.
    pub fn with_file<R>(&self, file: &DeclaringFile, read: impl FnOnce(&File) -> R) -> Option<R> {
        match file {
            DeclaringFile::Parked(index) => self.parked.borrow().get(*index).map(|file| read(file)),
            other => self.file(other).map(read),
        }
    }

    /// The code a parked state carries (docs/contracts/park-state.md, "Code
    /// is carried as a name, or as its syntax tree"), as a file of its own:
    /// `tree` as the typed AST writes it, `stamped` the same tree as it was
    /// parked, the checker's facts on it (`code_at` writes them so). The
    /// same tree parked twice is one file.
    pub fn park_code(&self, tree: Json, stamped: &Json) -> DeclaringFile {
        let mut parked = self.parked.borrow_mut();
        let mut stamps = BTreeMap::new();
        stamps_in(stamped, &mut String::new(), &mut stamps);
        if let Some(index) = parked.iter().position(|file| file.tree == tree && file.stamps == stamps) {
            return DeclaringFile::Parked(index);
        }
        parked.push(std::rc::Rc::new(File { program: ast::Program { statements: Vec::new() }, tree, stamps, version: self.root.version }));
        DeclaringFile::Parked(parked.len() - 1)
    }

    /// A file's own file imports.
    pub fn imports_of(&self, file: &DeclaringFile) -> &[Import] {
        match file {
            DeclaringFile::Root => &self.imports,
            DeclaringFile::Library(path) => self.files.get(path).map_or(&[], |(_, imports)| imports.as_slice()),
            DeclaringFile::Parked(_) => &[],
        }
    }

    /// The stamp at an engine AST path.
    pub fn stamp(&self, path: &str) -> Option<Stamp> {
        let (file, rest) = file_of_path(path);
        self.with_file(&file, |file| file.stamps.get(rest).cloned()).flatten()
    }

    /// `code_at` at an engine AST path.
    pub fn code_at(&self, path: &str) -> Option<crate::js::Js> {
        let (file, rest) = file_of_path(path);
        self.with_file(&file, |file| code_at(file, rest)).flatten()
    }
}

/// An AST path as the engine carries it: the root file's paths as the
/// checker writes them (`/statements/2/body`), a library's after its path,
/// pointer-escaped, behind an `@` (`@lib~1deals/statements/1/body`), a
/// parked piece of code's after its number behind a `%` (`%0/body/1`), so a
/// path names its file wherever it travels.
pub fn in_file(file: &DeclaringFile, path: &str) -> String {
    match file {
        DeclaringFile::Root => path.to_string(),
        DeclaringFile::Library(name) => format!("@{}{path}", name.replace('~', "~0").replace('/', "~1")),
        DeclaringFile::Parked(index) => format!("%{index}{path}"),
    }
}

/// The file an engine AST path names (`in_file`), and the path within it.
pub fn file_of_path(path: &str) -> (DeclaringFile, &str) {
    if let Some(rest) = path.strip_prefix('%') {
        let end = rest.find('/').unwrap_or(rest.len());
        if let Ok(index) = rest[..end].parse() {
            return (DeclaringFile::Parked(index), &rest[end..]);
        }
    }
    let Some(rest) = path.strip_prefix('@') else { return (DeclaringFile::Root, path) };
    let end = rest.find('/').unwrap_or(rest.len());
    (DeclaringFile::Library(rest[..end].replace("~1", "/").replace("~0", "~")), &rest[end..])
}

/// The checker's facts on a tree as a park carries it (`code_at` writes
/// them there), by their paths in it: the keys no parser writes, on the
/// nodes `join_check` places each kind of stamp on.
fn stamps_in(node: &Json, at: &mut String, stamps: &mut BTreeMap<String, Stamp>) {
    match node {
        Json::Object(map) => {
            if let Some(fields) = map.get("fields").filter(|_| is_write_spread(at, node))
                && let Ok(fields) = serde_json::from_value(fields.clone())
            {
                stamps.insert(at.clone(), Stamp::SpreadFields(fields));
            } else if let Some(copy) = map.get("copy").filter(|_| is_map_spread(node)) {
                stamps.insert(at.clone(), Stamp::Copy(copy.clone()));
            } else if map.get("reference") == Some(&Json::Bool(true)) && is_value_entry(node) {
                stamps.insert(at.clone(), Stamp::Reference);
            }
            for (key, child) in map {
                let before = at.len();
                at.push('/');
                at.push_str(&key.replace('~', "~0").replace('/', "~1"));
                stamps_in(child, at, stamps);
                at.truncate(before);
            }
        }
        Json::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                let before = at.len();
                at.push('/');
                at.push_str(&index.to_string());
                stamps_in(child, at, stamps);
                at.truncate(before);
            }
        }
        _ => {}
    }
}

/// The file that wrote a declaration: the scope its words are evaluated in,
/// the `type`s its fields read and the names its `extends` resolves against
/// (run.ts keeps a shape binding's `fileEnv` or `library` for the same).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum DeclaringFile {
    Root,
    /// A linked library, by its path.
    Library(String),
    /// A piece of code a resume rebuilt from its parked tree, by its number
    /// (`Checked::park_code`): code written somewhere the parked state does
    /// not say, run as it was parked.
    Parked(usize),
}

/// `node <Name> { … }` as written, and the file that wrote it.
#[derive(Debug, Clone, PartialEq)]
pub struct DeclaredShape {
    pub declaration: ast::ShapeDeclaration,
    pub file: DeclaringFile,
}

/// What one file declares for the constructs that read it, each by the name
/// the file binds.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FileDeclarations {
    /// `node <Name> { … }`: the file's own, and those it imports from a file.
    pub shapes: BTreeMap<String, DeclaredShape>,
    /// `type <Name> = <"a" | "b">`: its options, in order.
    pub types: BTreeMap<String, Vec<String>>,
}

/// The declarations a program's constructs read: a graph's or an
/// extraction's shape, a field's declared type, a plugin's registered name
/// (its spec is the catalog snapshot's).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Declarations {
    pub root: FileDeclarations,
    /// `import { … } from plugins`: the local name, the plugin as registered.
    pub plugins: BTreeMap<String, String>,
    /// Each linked library's, by path: where a library declaration's base
    /// and `type`s are found (run.ts `libraryShape`, `typesOfLibrary`).
    pub libraries: BTreeMap<String, FileDeclarations>,
}

impl Declarations {
    /// The declarations visible in `file`.
    pub fn of_file(&self, file: &DeclaringFile) -> Option<&FileDeclarations> {
        match file {
            DeclaringFile::Root => Some(&self.root),
            DeclaringFile::Library(path) => self.libraries.get(path),
            DeclaringFile::Parked(_) => None,
        }
    }

    fn of(program: &ast::Program, imports: &[Import], files: &BTreeMap<String, (File, Vec<Import>)>) -> Result<Declarations, String> {
        let mut declarations = Declarations { root: file_declarations(program, &DeclaringFile::Root, imports, files)?, ..Declarations::default() };
        for statement in &program.statements {
            if let ast::Statement::Import(import) = statement
                && matches!(&import.source, ast::ImportSource::Builtin { namespace } if namespace == "plugins")
            {
                for name in &import.names {
                    declarations.plugins.insert(name.alias.clone().unwrap_or_else(|| name.name.clone()), name.name.clone());
                }
            }
        }
        for (path, (file, imports)) in files {
            declarations.libraries.insert(path.clone(), file_declarations(&file.program, &DeclaringFile::Library(path.clone()), imports, files)?);
        }
        Ok(declarations)
    }
}

/// One file's shapes and `type`s: what it imports, and its own declarations
/// over them (`libraryShape` looks at a library's own first; the checker
/// refuses a file that both declares and imports one name).
fn file_declarations(
    program: &ast::Program,
    file: &DeclaringFile,
    imports: &[Import],
    files: &BTreeMap<String, (File, Vec<Import>)>,
) -> Result<FileDeclarations, String> {
    let imported = |local: &str| -> Result<Option<DeclaredShape>, String> {
        let Some(import) = imports.iter().find(|i| i.kind == "shape" && i.local == local) else { return Ok(None) };
        let (linked, _) = files.get(&import.file).ok_or_else(|| format!("the shape \"{}\" is imported from the unlinked file \"{}\"", import.local, import.file))?;
        let declared = declaration_at(&linked.program, &import.declaration)
            .ok_or_else(|| format!("no shape declaration at {} in \"{}\"", import.declaration, import.file))?;
        Ok(Some(DeclaredShape { declaration: declared.clone(), file: DeclaringFile::Library(import.file.clone()) }))
    };
    let mut declarations = FileDeclarations::default();
    let mut own = BTreeMap::new();
    for statement in &program.statements {
        match statement {
            ast::Statement::Shape(shape) => {
                own.insert(shape.name.clone(), DeclaredShape { declaration: shape.clone(), file: file.clone() });
            }
            ast::Statement::Type(declared) => {
                declarations.types.insert(declared.name.clone(), declared.options.clone());
            }
            _ => {}
        }
    }
    for import in imports.iter().filter(|i| i.kind == "shape") {
        if let Some(shape) = imported(&import.local)? {
            declarations.shapes.insert(import.local.clone(), shape);
        }
    }
    declarations.shapes.extend(own);
    Ok(declarations)
}

/// The shape declaration a link's `/statements/<i>` names.
fn declaration_at<'p>(program: &'p ast::Program, path: &str) -> Option<&'p ast::ShapeDeclaration> {
    let index: usize = path.strip_prefix("/statements/")?.parse().ok()?;
    match program.statements.get(index)? {
        ast::Statement::Shape(shape) => Some(shape),
        _ => None,
    }
}

/// `parseProgram`: the typed AST and its JSON, or the parser's refusal as
/// `{message, loc}`.
pub fn parse(source: &str, language_version: u32) -> Result<File, Json> {
    let program = movement_parser::stmt::parse_program(source, language_version, false).map_err(|e| json!(e))?;
    let tree = serde_json::to_value(&program).expect("an AST is always JSON");
    Ok(File { program, tree, stamps: BTreeMap::new(), version: language_version })
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
    let mut checked = Checked { root, imports: Vec::new(), files: BTreeMap::new(), diagnostics, version_warning, declarations: Declarations::default(), parked: Default::default() };
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
        let node = node_at(file, &path).ok_or_else(|| format!("no node at {path}"))?;
        let node = &node;
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
    checked.declarations = Declarations::of(&checked.root.program, &checked.imports, &checked.files)?;
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
    fn a_call_nested_in_an_expression_has_a_place_of_its_own() {
        let source = "movement m() {\n  x = FIRST(MAP([1], (v) => {\n    g = graph { ...v }\n    return g\n  }))\n}";
        let root = parse(source, 3).unwrap();
        let slot = "/statements/0/body/0/value/call/expression";
        let raw = root.tree.pointer(&format!("{slot}/raw")).and_then(Json::as_str).unwrap().to_string();
        let nested = format!("{slot}/nested/6-{}", raw.encode_utf16().count() - 1);
        assert_eq!(node_at(&root, &format!("{nested}/value/call/callee")), Some(json!("MAP")));
        let spread = format!("{nested}/value/call/args/1/closure/body/0/value/node/spreads/0");
        assert_eq!(node_at(&root, &format!("{spread}/source")), Some(json!("v")));
        // The checker's stamp on it lands there, and on what a park writes.
        let answer = json!({ "diagnostics": [], "stamps": [{ "path": spread, "copy": { "kind": "map" } }] });
        let checked = join_check(root, &answer, 3).unwrap();
        assert_eq!(checked.root.stamps.get(&spread), Some(&Stamp::Copy(json!({ "kind": "map" }))));
        let code = code_at(&checked.root, &format!("{nested}/value/call/args/1/closure")).unwrap();
        assert!(format!("{code:?}").contains("copy"));
        // An extent that is no call there is no node.
        assert_eq!(node_at(&checked.root, &format!("{slot}/nested/0-3/value")), None);
    }

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
        // The imported shape is among the root's declarations, by its local
        // name, and knows the file that wrote it.
        let deal = &checked.declarations.root.shapes["Deal"];
        assert_eq!(deal.declaration.root.fields[0].name, "name");
        assert_eq!(deal.file, DeclaringFile::Library("deals".into()));
        assert_eq!(checked.declarations.libraries["deals"].shapes["Deal"].file, DeclaringFile::Library("deals".into()));
    }

    #[test]
    fn the_declarations_are_the_files_shapes_types_and_plugins_by_local_name() {
        let source = "import { attio } from adapters\nimport { fetch_url as fetch, research } from plugins\ncrm = attio()\ntype Stage = <\"lead\" | \"won\">\nnode Lead: \"a lead\" {\n  name: <text> \"its name\"\n  stage: <Stage>\n  node founder: \"each founder\" { first: <text> }\n}\nmovement m(e: <crm>) {\n  x = 1\n}";
        let checked = join_check(parse(source, 3).unwrap(), &json!({ "diagnostics": [], "stamps": [] }), 3).unwrap();
        let declarations = &checked.declarations;
        assert_eq!(declarations.root.types["Stage"], ["lead", "won"]);
        assert_eq!(declarations.plugins.iter().map(|(l, p)| (l.as_str(), p.as_str())).collect::<Vec<_>>(), [("fetch", "fetch_url"), ("research", "research")]);
        let lead = &declarations.root.shapes["Lead"].declaration;
        assert_eq!(lead.root.fields.iter().map(|f| (f.name.as_str(), f.type_.as_str())).collect::<Vec<_>>(), [("name", "text"), ("stage", "Stage")]);
        assert_eq!(lead.root.children[0].name, "founder");
        let unlinked = json!({
            "diagnostics": [],
            "link": { "imports": [{ "local": "Deal", "kind": "shape", "name": "Deal", "file": "deals", "declaration": "/statements/0" }], "files": [] },
            "stamps": [],
        });
        assert!(join_check(parse(SOURCE, 3).unwrap(), &unlinked, 3).unwrap_err().contains("unlinked file"));
    }

    /// Parked code is a file of its own: the checker's facts its tree
    /// carries are its stamps, and it writes back as it was parked.
    #[test]
    fn parked_code_is_a_file_of_its_own_with_the_facts_its_tree_carries() {
        let source = "import { attio } from adapters\ncrm = attio()\nmovement m(e: <crm>) {\n  f = (d) => {\n    write crm-[:companies]-> { ...d }\n  }\n}";
        let closure = "/statements/2/body/0/value/closure";
        let spread = format!("{closure}/body/0/write/spreads/0");
        let answer = json!({ "diagnostics": [], "stamps": [{ "path": spread, "spreadFields": ["name"] }] });
        let checked = join_check(parse(source, 3).unwrap(), &answer, 3).unwrap();
        let parked = crate::env::json_of_js(&checked.code_at(closure).unwrap());
        assert_eq!(parked.pointer("/body/0/write/spreads/0/fields"), Some(&json!(["name"])));
        let typed = serde_json::to_value(serde_json::from_value::<ast::ClosureExpression>(parked.clone()).unwrap()).unwrap();
        assert_eq!(checked.park_code(typed.clone(), &parked), DeclaringFile::Parked(0));
        // The same tree parked again is the same file.
        assert_eq!(checked.park_code(typed, &parked), DeclaringFile::Parked(0));
        assert_eq!(checked.stamp("%0/body/0/write/spreads/0"), Some(Stamp::SpreadFields(vec!["name".into()])));
        assert_eq!(crate::env::json_of_js(&checked.code_at("%0").unwrap()), parked);
        assert_eq!(file_of_path("%0/body"), (DeclaringFile::Parked(0), "/body"));
    }
}
