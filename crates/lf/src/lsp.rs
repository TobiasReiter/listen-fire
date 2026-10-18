//! `lf lsp`: the language server, over stdio (LSP 3.17, full-text sync,
//! UTF-16 positions). Every answer is the language service's
//! (movement_language, docs/contracts/language-service.md), checked against
//! the project's catalog as `lf check` builds it. Diagnostics are published
//! per file, 200 ms after its last change.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use indexmap::IndexMap;
use movement_language::{DiagSeverity, ItemKind, Pos, Range, Service};
use movement_parser::catalog::types::{CatalogSnapshot, SnapshotFile};
use movement_parser::util::form::read_json_text;
use serde_json::{Value, json};

use crate::check::{Opened, open_checking};
use crate::project::{Project, load_project};

const DEBOUNCE: Duration = Duration::from_millis(200);

/// One framed message from the client, or the end of its input.
fn read_message(input: &mut impl BufRead) -> Option<Value> {
    let mut length: Option<usize> = None;
    loop {
        let mut header = String::new();
        if input.read_line(&mut header).ok()? == 0 {
            return None;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some(value) = header.strip_prefix("Content-Length:") {
            length = value.trim().parse().ok();
        }
    }
    let mut body = vec![0u8; length?];
    input.read_exact(&mut body).ok()?;
    serde_json::from_slice(&body).ok()
}

fn write_message(out: &mut impl Write, message: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(message).map_err(|e| e.to_string())?;
    write!(out, "Content-Length: {}\r\n\r\n", body.len()).map_err(|e| e.to_string())?;
    out.write_all(&body).map_err(|e| e.to_string())?;
    out.flush().map_err(|e| e.to_string())
}

/// `file:///a%20b/c.mvt` → `/a b/c.mvt`.
fn path_of_uri(uri: &str) -> Option<PathBuf> {
    let raw = uri.strip_prefix("file://")?;
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(byte) = raw.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).ok().map(PathBuf::from)
}

fn uri_of_path(path: &Path) -> String {
    let mut out = String::from("file://");
    for byte in path.to_string_lossy().bytes() {
        if byte.is_ascii_alphanumeric() || b"/-_.~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The catalog the project's files check against: `lf check`'s, or, when
/// its externals cannot start, one of the host units, the credentials and
/// the files alone.
async fn catalog_of_project(project: Option<&Project>, log: &mut Vec<String>) -> CatalogSnapshot {
    let built = match project {
        Some(project) => match open_checking(project).await {
            Ok(Opened::Ready(checking)) => Some(checking.catalog),
            Ok(Opened::MissingCredentials(lines)) => {
                log.push(format!("the externals did not start: {}", lines.join("; ")));
                None
            }
            Err(message) => {
                log.push(format!("the externals did not start: {message}"));
                None
            }
        },
        None => None,
    };
    let js = built.unwrap_or_else(|| {
        let env: Vec<(String, String)> = std::env::vars().collect();
        let credentials = project.and_then(|p| crate::secrets::load_secrets(p, &env).ok()).unwrap_or_default();
        let files = project.and_then(|p| crate::sources::scan_movements(p).ok()).unwrap_or_default();
        crate::catalog::catalog_of(&[], &IndexMap::new(), &credentials, &files)
    });
    CatalogSnapshot::load(&read_json_text(&js.to_json())).unwrap_or_else(|e| {
        log.push(format!("the catalog does not load: {e}"));
        CatalogSnapshot::load(r#"{"adapters":{},"credentials":{},"plugins":{}}"#).expect("an empty catalog loads")
    })
}

struct Server {
    service: Service,
    project: Option<Project>,
    documents: HashMap<String, String>,
    /// Files whose diagnostics are due, and when.
    due: HashMap<String, Instant>,
}

impl Server {
    /// The catalog's key for a document: its path under the movements folder, no extension.
    fn file_key(&self, uri: &str) -> Option<String> {
        let path = path_of_uri(uri)?;
        let relative = path.strip_prefix(&self.project.as_ref()?.movements_dir).ok()?;
        Some(relative.with_extension("").to_string_lossy().replace('\\', "/"))
    }

    fn uri_of_key(&self, key: &str) -> Option<String> {
        Some(uri_of_path(&self.project.as_ref()?.movements_dir.join(format!("{key}.mvt"))))
    }

    /// An open buffer stands in for its file when another file imports it.
    fn track(&mut self, uri: &str, text: String) {
        if let Some(key) = self.file_key(uri) {
            let files = self.service.catalog.files.get_or_insert_with(Default::default);
            files.0.insert(key, SnapshotFile { source: text.clone() });
        }
        self.documents.insert(uri.to_string(), text);
    }

    fn text(&self, params: &Value) -> Option<(String, &str)> {
        let uri = params.pointer("/textDocument/uri")?.as_str()?.to_string();
        let text = self.documents.get(&uri)?;
        Some((uri, text.as_str()))
    }

    fn publish(&self, uri: &str, out: &mut impl Write) -> Result<(), String> {
        let diagnostics: Vec<Value> = match self.documents.get(uri) {
            Some(text) => self
                .service
                .diagnostics(text)
                .into_iter()
                .map(|d| {
                    json!({
                        "range": range_json(d.range),
                        "severity": match d.severity { DiagSeverity::Error => 1, DiagSeverity::Warning => 2, DiagSeverity::Info => 3 },
                        "code": d.code,
                        "source": "lf",
                        "message": d.message,
                    })
                })
                .collect(),
            None => Vec::new(),
        };
        write_message(out, &json!({ "jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": { "uri": uri, "diagnostics": diagnostics } }))
    }

    fn request(&self, method: &str, params: &Value) -> Result<Value, (i64, String)> {
        let pos = || -> Option<Pos> {
            Some(Pos { line: params.pointer("/position/line")?.as_u64()? as u32, character: params.pointer("/position/character")?.as_u64()? as u32 })
        };
        match method {
            "textDocument/completion" => {
                let (Some((_, text)), Some(pos)) = (self.text(params), pos()) else { return Ok(Value::Null) };
                let items: Vec<Value> = self.service.complete(text, pos).into_iter().map(item_json).collect();
                Ok(json!({ "isIncomplete": false, "items": items }))
            }
            "textDocument/hover" => {
                let (Some((_, text)), Some(pos)) = (self.text(params), pos()) else { return Ok(Value::Null) };
                Ok(self.service.hover(text, pos).map_or(Value::Null, |h| json!({ "contents": { "kind": "markdown", "value": h.contents }, "range": range_json(h.range) })))
            }
            "textDocument/definition" => {
                let (Some((uri, text)), Some(pos)) = (self.text(params), pos()) else { return Ok(Value::Null) };
                let Some(found) = self.service.definition(text, pos) else { return Ok(Value::Null) };
                let target = match &found.file {
                    None => Some(uri.clone()),
                    Some(key) => self.uri_of_key(key),
                };
                Ok(target.map_or(Value::Null, |target| json!({ "uri": target, "range": range_json(found.range) })))
            }
            "textDocument/codeAction" => {
                let Some((uri, text)) = self.text(params) else { return Ok(json!([])) };
                let Some(range) = params.get("range").and_then(range_of_json) else { return Ok(json!([])) };
                let actions: Vec<Value> = self
                    .service
                    .code_actions(text, range)
                    .into_iter()
                    .map(|a| {
                        let edits: Vec<Value> = a.edits.iter().map(|e| json!({ "range": range_json(e.range), "newText": e.new_text })).collect();
                        json!({ "title": a.title, "kind": "quickfix", "isPreferred": a.preferred, "edit": { "changes": { uri.clone(): edits } } })
                    })
                    .collect();
                Ok(Value::Array(actions))
            }
            other => Err((-32601, format!("lf lsp does not answer {other}"))),
        }
    }
}

fn range_json(range: Range) -> Value {
    json!({ "start": { "line": range.start.line, "character": range.start.character }, "end": { "line": range.end.line, "character": range.end.character } })
}

fn range_of_json(value: &Value) -> Option<Range> {
    let pos = |v: &Value| Some(Pos { line: v.get("line")?.as_u64()? as u32, character: v.get("character")?.as_u64()? as u32 });
    Some(Range { start: pos(value.get("start")?)?, end: pos(value.get("end")?)? })
}

fn item_json(item: movement_language::Item) -> Value {
    let kind = match item.kind {
        ItemKind::Variable => 6,
        ItemKind::Function => 3,
        ItemKind::Field => 5,
        ItemKind::Edge => 18,
        ItemKind::Module | ItemKind::Namespace => 9,
        ItemKind::Keyword => 14,
        ItemKind::Property => 10,
        ItemKind::Credential => 21,
        ItemKind::Type => 22,
    };
    let mut value = json!({ "label": item.label, "kind": kind });
    if let Some(detail) = item.detail {
        value["detail"] = json!(detail);
    }
    let written = item.insert.unwrap_or_else(|| item.label.clone());
    match item.replace {
        Some(range) => value["textEdit"] = json!({ "range": range_json(range), "newText": written }),
        None if written != item.label => value["insertText"] = json!(written),
        None => {}
    }
    value
}

const CAPABILITIES: &str = r#"{
  "textDocumentSync": { "openClose": true, "change": 1 },
  "completionProvider": { "triggerCharacters": [".", "`", ":", "[", "{", " "] },
  "hoverProvider": true,
  "definitionProvider": true,
  "codeActionProvider": { "codeActionKinds": ["quickfix"] }
}"#;

pub async fn run(dir: &Path, out: &mut impl Write) -> Result<i32, String> {
    let (send, messages) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        let mut input = std::io::BufReader::new(std::io::stdin().lock());
        while let Some(message) = read_message(&mut input) {
            if send.send(message).is_err() {
                return;
            }
        }
    });
    let mut server: Option<Server> = None;
    let mut shut_down = false;
    loop {
        let wait = server.as_ref().and_then(|s| s.due.values().min().copied()).map(|due| due.saturating_duration_since(Instant::now()));
        let message = match wait {
            Some(wait) => match messages.recv_timeout(wait) {
                Ok(message) => Some(message),
                Err(mpsc::RecvTimeoutError::Timeout) => None,
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(if shut_down { 0 } else { 1 }),
            },
            None => match messages.recv() {
                Ok(message) => Some(message),
                Err(_) => return Ok(if shut_down { 0 } else { 1 }),
            },
        };
        if let Some(server) = server.as_mut() {
            let now = Instant::now();
            let ready: Vec<String> = server.due.iter().filter(|(_, due)| **due <= now).map(|(uri, _)| uri.clone()).collect();
            for uri in ready {
                server.due.remove(&uri);
                server.publish(&uri, out)?;
            }
        }
        let Some(message) = message else { continue };
        let method = message.get("method").and_then(Value::as_str).unwrap_or_default().to_string();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let id = message.get("id").cloned();
        match method.as_str() {
            "initialize" => {
                let root = params
                    .get("rootUri")
                    .and_then(Value::as_str)
                    .and_then(path_of_uri)
                    .or_else(|| params.get("rootPath").and_then(Value::as_str).map(PathBuf::from))
                    .unwrap_or_else(|| dir.to_path_buf());
                let mut log = Vec::new();
                let project = load_project(&root).map_err(|e| log.push(format!("no project at {}: {e}", root.display()))).ok();
                let catalog = catalog_of_project(project.as_ref(), &mut log).await;
                let version = project.as_ref().map_or(movement_parser::version::CURRENT_LANGUAGE_VERSION, |p| p.language_version);
                server = Some(Server { service: Service::new(catalog, version), project, documents: HashMap::new(), due: HashMap::new() });
                let capabilities: Value = serde_json::from_str(CAPABILITIES).expect("the capabilities are JSON");
                write_message(out, &json!({ "jsonrpc": "2.0", "id": id, "result": { "capabilities": capabilities, "serverInfo": { "name": "lf", "version": env!("CARGO_PKG_VERSION") } } }))?;
                for line in log {
                    write_message(out, &json!({ "jsonrpc": "2.0", "method": "window/logMessage", "params": { "type": 2, "message": line } }))?;
                }
            }
            "shutdown" => {
                shut_down = true;
                write_message(out, &json!({ "jsonrpc": "2.0", "id": id, "result": null }))?;
            }
            "exit" => return Ok(if shut_down { 0 } else { 1 }),
            _ => {
                let Some(server) = server.as_mut() else {
                    if id.is_some() {
                        write_message(out, &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32002, "message": "not initialized" } }))?;
                    }
                    continue;
                };
                match method.as_str() {
                    "textDocument/didOpen" => {
                        let (Some(uri), Some(text)) = (params.pointer("/textDocument/uri").and_then(Value::as_str), params.pointer("/textDocument/text").and_then(Value::as_str)) else { continue };
                        server.track(uri, text.to_string());
                        server.due.insert(uri.to_string(), Instant::now());
                    }
                    "textDocument/didChange" => {
                        let uri = params.pointer("/textDocument/uri").and_then(Value::as_str).unwrap_or_default().to_string();
                        let text = params.get("contentChanges").and_then(Value::as_array).and_then(|c| c.last()).and_then(|c| c.get("text")).and_then(Value::as_str);
                        if let Some(text) = text {
                            server.track(&uri, text.to_string());
                            server.due.insert(uri, Instant::now() + DEBOUNCE);
                        }
                    }
                    "textDocument/didClose" => {
                        if let Some(uri) = params.pointer("/textDocument/uri").and_then(Value::as_str) {
                            server.documents.remove(uri);
                            server.due.remove(uri);
                            // The file on disk stands for it again.
                            if let Some(on_disk) = path_of_uri(uri).and_then(|p| std::fs::read_to_string(p).ok()) {
                                server.track(uri, on_disk);
                                server.documents.remove(uri);
                            }
                            server.publish(uri, out)?;
                        }
                    }
                    _ if id.is_some() => {
                        let reply = match server.request(&method, &params) {
                            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                            Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
                        };
                        write_message(out, &reply)?;
                    }
                    _ => {}
                }
            }
        }
    }
}
