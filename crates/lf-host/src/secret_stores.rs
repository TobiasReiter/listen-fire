//! lf's secrets stores, as the TypeScript lf keeps them (apps/cli/src/
//! secrets.ts): a secrets file (plain YAML, rewritten in place with its
//! comments and order kept; or SOPS, read with `sops -d` and changed with
//! `sops set` / `sops unset`, never decrypted onto disk), the environment
//! (read-only: a write-back is kept for this process and reported once), and
//! one loaded credential over both (its file's fields with the environment's
//! over them). Whole entries — what `lf connect` and `lf credential` write —
//! are created, replaced and deleted under the same lock a refresh takes.

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;

use crate::project::Project;
use crate::secrets::{Credential, Credentials, SecretsFile, apply_environment, parse_entry, read_secrets_file, secrets_paths};
use crate::secrets_family::{FileLock, Fields, Record, SecretsBackend, SecretsFamily, WriteBack, redact_secrets};

// ── A secrets file ──────────────────────────────────────────────────────────

/// One credential's fields in a secrets file, without its binding keys.
fn entry_fields(file: &SecretsFile, name: &str) -> Result<Option<Fields>, String> {
    let (content, _) = read_secrets_file(&file.path)?;
    Ok(content.into_iter().find(|(n, _)| n == name).and_then(|(_, raw)| parse_entry(raw).ok()).map(|(_, _, fields)| fields))
}

/// A secrets file as a store (secrets.ts `fileSecrets`).
pub struct FileSecrets {
    pub file: SecretsFile,
}

impl FileSecrets {
    pub fn at(path: &Path) -> Result<FileSecrets, String> {
        let (_, encrypted) = read_secrets_file(path)?;
        Ok(FileSecrets { file: SecretsFile { path: path.to_path_buf(), encrypted } })
    }
}

impl SecretsBackend for FileSecrets {
    fn resolve(&self, reference: &str) -> Result<Option<Record>, String> {
        Ok(entry_fields(&self.file, reference)?.map(Record::of))
    }

    fn write_back(&self, reference: &str, fields: &Fields, expected: &str) -> Result<WriteBack, String> {
        let Some(now) = self.resolve(reference)? else { return Ok(WriteBack::Missing) };
        if now.version != expected {
            return Ok(WriteBack::Conflict(now));
        }
        let path = &self.file.path;
        if self.file.encrypted {
            for (field, value) in fields {
                let key = format!("[{}][{}]", json_string(reference), json_string(field));
                let set = Command::new("sops").arg("set").arg(path).arg(&key).arg(json_string(value)).output().map_err(|e| sops_refusal(reference, path, &e.to_string()))?;
                if !set.status.success() {
                    let stderr = String::from_utf8_lossy(&set.stderr);
                    return Err(format!(
                        "credential \"{reference}\": sops set on {} failed: {}",
                        path.display(),
                        redact_secrets(stderr.trim(), fields.values())
                    ));
                }
            }
        } else {
            let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
            write_staged(path, reference, &set_fields(&text, reference, fields))?;
        }
        let mut merged = now.fields;
        merged.extend(fields.clone());
        Ok(WriteBack::Written(Record::of(merged)))
    }

    fn locked_file(&self) -> Option<PathBuf> {
        Some(self.file.path.clone())
    }

    fn assert_writable(&self, reference: &str) -> Result<(), String> {
        assert_sops_runs(reference, &self.file)
    }
}

pub fn assert_sops_runs(reference: &str, file: &SecretsFile) -> Result<(), String> {
    if !file.encrypted {
        return Ok(());
    }
    Command::new("sops").arg("--version").output().map(drop).map_err(|e| sops_refusal(reference, &file.path, &e.to_string()))
}

fn sops_refusal(reference: &str, path: &Path, why: &str) -> String {
    format!(
        "credential \"{reference}\" was refreshed but {} is encrypted with SOPS and `sops` could not be run ({why}); install sops (the refreshed token was not saved)",
        path.display()
    )
}

/// Through a staging file beside it, readable by its owner only.
fn write_staged(path: &Path, name: &str, text: &str) -> Result<(), String> {
    let staging = path.parent().unwrap_or(Path::new(".")).join(format!(".{name}.secrets.tmp"));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut out = options.open(&staging).map_err(|e| format!("{}: {e}", staging.display()))?;
    std::io::Write::write_all(&mut out, text.as_bytes()).map_err(|e| format!("{}: {e}", staging.display()))?;
    std::fs::rename(&staging, path).map_err(|e| format!("{}: {e}", path.display()))
}

// ── The environment ─────────────────────────────────────────────────────────

fn env_not_persisted(name: &str) -> String {
    format!("credential \"{name}\" has fields from the environment; its refreshed token is used for this run only and cannot be written back")
}

/// The environment (`LF_SECRET__…`) as a store (secrets.ts `envSecrets`).
pub struct EnvSecrets {
    pub env: Rc<RefCell<Vec<(String, String)>>>,
    kept: RefCell<HashMap<String, Fields>>,
}

impl EnvSecrets {
    pub fn new(env: Rc<RefCell<Vec<(String, String)>>>) -> EnvSecrets {
        EnvSecrets { env, kept: RefCell::new(HashMap::new()) }
    }
}

impl SecretsBackend for EnvSecrets {
    fn resolve(&self, reference: &str) -> Result<Option<Record>, String> {
        let mut credentials: Credentials = Vec::new();
        apply_environment(&mut credentials, &self.env.borrow())?;
        let Some(credential) = credentials.into_iter().find(|c| c.name == reference) else { return Ok(None) };
        let mut fields = credential.fields;
        fields.extend(self.kept.borrow().get(reference).cloned().unwrap_or_default());
        Ok(Some(Record::of(fields)))
    }

    fn write_back(&self, reference: &str, fields: &Fields, expected: &str) -> Result<WriteBack, String> {
        let Some(now) = self.resolve(reference)? else { return Ok(WriteBack::Missing) };
        if now.version != expected {
            return Ok(WriteBack::Conflict(now));
        }
        self.kept.borrow_mut().entry(reference.to_string()).or_default().extend(fields.clone());
        let mut merged = now.fields;
        merged.extend(fields.clone());
        Ok(WriteBack::NotPersisted { record: Record::of(merged), why: env_not_persisted(reference) })
    }
}

// ── One loaded credential ───────────────────────────────────────────────────

/// One loaded credential as a store (secrets.ts `credentialSecrets`): its
/// secrets file's fields, read through to the file, with the fields the
/// environment supplied over them. A write-back goes to the file for the
/// fields that came from it, and is kept for this process (reported once)
/// for the ones the environment supplied.
struct CredentialSecrets {
    name: String,
    file: Option<FileSecrets>,
    env_fields: BTreeSet<String>,
    /// The credential's fields as last read or written.
    fields: RefCell<Fields>,
}

impl CredentialSecrets {
    fn env_overlay(&self) -> Fields {
        let fields = self.fields.borrow();
        self.env_fields.iter().filter_map(|f| fields.get(f).map(|v| (f.clone(), v.clone()))).collect()
    }

    /// The fields now, and the file's own version of its part.
    fn read(&self) -> Result<Option<(Record, Option<String>)>, String> {
        let Some(file) = &self.file else {
            // Nothing to read through to: the fields as loaded or last written.
            return Ok(Some((Record::of(self.fields.borrow().clone()), None)));
        };
        let from_file = file.resolve(&self.name)?;
        if from_file.is_none() && self.env_fields.is_empty() {
            return Ok(None);
        }
        let file_version = from_file.as_ref().map(|r| r.version.clone());
        let mut fields = from_file.map(|r| r.fields).unwrap_or_default();
        fields.extend(self.env_overlay());
        *self.fields.borrow_mut() = fields.clone();
        Ok(Some((Record::of(fields), file_version)))
    }
}

impl SecretsBackend for CredentialSecrets {
    fn resolve(&self, _reference: &str) -> Result<Option<Record>, String> {
        Ok(self.read()?.map(|(record, _)| record))
    }

    fn write_back(&self, _reference: &str, fields: &Fields, expected: &str) -> Result<WriteBack, String> {
        let Some((now, file_version)) = self.read()? else { return Ok(WriteBack::Missing) };
        if now.version != expected {
            return Ok(WriteBack::Conflict(now));
        }
        let to_file: Fields = fields.iter().filter(|(f, _)| !self.env_fields.contains(*f)).map(|(k, v)| (k.clone(), v.clone())).collect();
        if let (Some(file), Some(file_version)) = (&self.file, &file_version)
            && !to_file.is_empty()
        {
            match file.write_back(&self.name, &to_file, file_version)? {
                WriteBack::Conflict(current) => return Ok(WriteBack::Conflict(current)),
                WriteBack::Missing => return Ok(WriteBack::Missing),
                WriteBack::Written(_) | WriteBack::NotPersisted { .. } => {}
            }
        }
        self.fields.borrow_mut().extend(fields.clone());
        let record = Record::of(self.fields.borrow().clone());
        if to_file.len() < fields.len() {
            return Ok(WriteBack::NotPersisted { record, why: env_not_persisted(&self.name) });
        }
        if self.file.is_none() && !to_file.is_empty() {
            let why = format!("credential \"{}\" has no secrets file; its refreshed token is used for this run only", self.name);
            return Ok(WriteBack::NotPersisted { record, why });
        }
        Ok(WriteBack::Written(record))
    }

    fn locked_file(&self) -> Option<PathBuf> {
        self.file.as_ref().map(|f| f.file.path.clone())
    }

    fn assert_writable(&self, reference: &str) -> Result<(), String> {
        match &self.file {
            Some(file) => assert_sops_runs(reference, &file.file),
            None => Ok(()),
        }
    }
}

thread_local! {
    /// One family per loaded credential, so its single flight covers every call.
    static FAMILIES: RefCell<HashMap<(String, Option<PathBuf>), Rc<SecretsFamily>>> = RefCell::new(HashMap::new());
}

/// The secrets family a loaded credential is refreshed and written back through.
pub fn secrets_of(credential: &Credential) -> Rc<SecretsFamily> {
    let key = (credential.name.clone(), credential.origin.file.as_ref().map(|f| f.path.clone()));
    FAMILIES.with(|families| {
        families
            .borrow_mut()
            .entry(key)
            .or_insert_with(|| {
                let backend = CredentialSecrets {
                    name: credential.name.clone(),
                    file: credential.origin.file.clone().map(|file| FileSecrets { file }),
                    env_fields: credential.origin.env_fields.clone(),
                    fields: RefCell::new(credential.fields.clone()),
                };
                Rc::new(SecretsFamily::new(Box::new(backend), Box::new(|message| eprintln!("lf: {message}"))))
            })
            .clone()
    })
}

/// The credential's fields as they stand now: as this process last read or
/// wrote them through its secrets family, else as loaded.
pub fn current_fields(credential: &Credential) -> Fields {
    secrets_of(credential).cached(&credential.name).map(|r| r.fields).unwrap_or_else(|| credential.fields.clone())
}

// ── Whole entries: what `lf connect` and `lf credential` write ──────────────

/// The file new entries go to: the one secrets are read from, else the
/// project's `.lf/secrets.yaml` (created, readable by its owner only).
pub fn secrets_file_for_writes(project: &Project, env: &[(String, String)]) -> Result<SecretsFile, String> {
    let paths = secrets_paths(project, env);
    if let Some(path) = paths.iter().find(|p| p.exists()) {
        let (_, encrypted) = read_secrets_file(path)?;
        return Ok(SecretsFile { path: path.clone(), encrypted });
    }
    if let Some((_, named)) = env.iter().find(|(k, v)| k == "LF_SECRETS_FILE" && !v.is_empty()) {
        return Err(format!("LF_SECRETS_FILE points at {named}, which does not exist"));
    }
    let created = project.lf_dir.join("secrets.yaml");
    write_staged(&created, "secrets", "# Written by `lf connect` and `lf credential`; not edited by hand.\n")?;
    Ok(SecretsFile { path: created, encrypted: false })
}

pub enum EntryChange<'a> {
    /// Create the entry; refused when it exists.
    Create(Vec<(String, String)>),
    /// Replace it by what the function makes of it as stored now (None: it is gone).
    Replace(&'a dyn Fn(Option<Vec<(String, String)>>) -> Result<Vec<(String, String)>, String>),
    Delete,
}

/// Change one whole entry of a secrets file, under its lock (secrets.ts `changeEntry`).
pub async fn change_entry(file: &SecretsFile, name: &str, change: EntryChange<'_>) -> Result<(), String> {
    let path = &file.path;
    if name == "sops" {
        return Err("\"sops\" is the SOPS metadata of a secrets file, not an entry name".into());
    }
    let _lock = FileLock::acquire(path).await?;
    if file.encrypted {
        assert_sops_runs(name, file)?;
    }
    let (content, _) = read_secrets_file(path)?;
    let current: Option<Vec<(String, String)>> = content.into_iter().find(|(n, _)| n == name).and_then(|(_, raw)| match raw {
        serde_yaml::Value::Mapping(map) => Some(map.into_iter().filter_map(|(k, v)| Some((scalar_text(&k)?, scalar_text(&v)?))).collect()),
        _ => None,
    });
    let entry = match change {
        EntryChange::Create(entry) => {
            if current.is_some() {
                return Err(format!("{} already has an entry \"{name}\"", path.display()));
            }
            Some(entry)
        }
        EntryChange::Replace(next) => Some(next(current)?),
        EntryChange::Delete => {
            if current.is_none() {
                return Err(format!("{} has no entry \"{name}\"", path.display()));
            }
            None
        }
    };
    let key = format!("[{}]", json_string(name));
    if file.encrypted {
        let mut sops = Command::new("sops");
        match &entry {
            None => sops.arg("unset").arg(path).arg(&key),
            Some(entry) => sops.arg("set").arg(path).arg(&key).arg(json_object(entry)),
        };
        let run = sops.output().map_err(|e| format!("{} is encrypted with SOPS and `sops` could not be run ({e}); install sops", path.display()))?;
        if !run.status.success() {
            let values: Vec<String> = entry.iter().flatten().map(|(_, v)| v.clone()).collect();
            let verb = if entry.is_some() { "set" } else { "unset" };
            let stderr = String::from_utf8_lossy(&run.stderr);
            return Err(format!("sops {verb} on {} failed: {}", path.display(), redact_secrets(stderr.trim(), values.iter())));
        }
        return Ok(());
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let next = match &entry {
        None => delete_entry(&text, name),
        Some(entry) => replace_entry(&text, name, entry),
    };
    write_staged(path, name, &next)
}

fn scalar_text(value: &serde_yaml::Value) -> Option<String> {
    match value {
        serde_yaml::Value::String(s) => Some(s.clone()),
        serde_yaml::Value::Number(n) => Some(n.to_string()),
        serde_yaml::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn json_string(text: &str) -> String {
    serde_json::Value::String(text.to_string()).to_string()
}

/// An entry as JSON, its keys in order.
fn json_object(entry: &[(String, String)]) -> String {
    let parts: Vec<String> = entry.iter().map(|(k, v)| format!("{}:{}", json_string(k), json_string(v))).collect();
    format!("{{{}}}", parts.join(","))
}

// ── Editing a secrets file in place ─────────────────────────────────────────
// A secrets file is a mapping of entry names to mappings of string fields. It
// is edited by lines, as the `yaml` package's document edits it: a changed
// field keeps its line, a new field goes after the entry's last, a new entry
// at the end, and every comment and blank line elsewhere stays.

struct Block {
    /// The entry's key line.
    head: usize,
    /// Its lines after the head (children, their continuation lines, blank
    /// lines and comments inside it), end exclusive and trailing blanks trimmed.
    end: usize,
    /// Whether the head holds a value inline (`acme: { … }`).
    inline: bool,
}

/// The key a line at column 0 (or at `indent`) begins with.
fn key_of(line: &str, indent: usize) -> Option<(String, &str)> {
    let rest = line.get(indent..)?;
    if line[..indent].chars().any(|c| c != ' ') || rest.starts_with([' ', '#', '-', '\t']) || rest.is_empty() {
        return None;
    }
    let (key, after) = if let Some(quoted) = rest.strip_prefix('"') {
        let mut escaped = false;
        let close = quoted.char_indices().find(|&(_, c)| {
            let ends = !escaped && c == '"';
            escaped = !escaped && c == '\\';
            ends
        })?;
        (serde_json::from_str::<String>(&rest[..close.0 + 2]).ok()?, &quoted[close.0 + 1..])
    } else if let Some(quoted) = rest.strip_prefix('\'') {
        let at = quoted.find('\'')?;
        (quoted[..at].to_string(), &quoted[at + 1..])
    } else {
        let at = rest.find(':')?;
        (rest[..at].trim_end().to_string(), &rest[at..])
    };
    let after = after.trim_start_matches(' ');
    let value = after.strip_prefix(':')?;
    if !(value.is_empty() || value.starts_with([' ', '\t'])) {
        return None;
    }
    Some((key, value))
}

fn is_blank_or_comment(line: &str) -> bool {
    let t = line.trim_start();
    t.is_empty() || t.starts_with('#')
}

fn find_block(lines: &[&str], name: &str) -> Option<Block> {
    let head = lines.iter().position(|l| key_of(l, 0).is_some_and(|(k, _)| k == name))?;
    let (_, value) = key_of(lines[head], 0)?;
    let inline = !is_blank_or_comment(value);
    let mut end = head + 1;
    while end < lines.len() && (lines[end].starts_with([' ', '\t']) || lines[end].trim().is_empty()) {
        end += 1;
    }
    while end > head + 1 && lines[end - 1].trim().is_empty() {
        end -= 1;
    }
    Some(Block { head, end, inline })
}

/// A plain scalar when it reads back as the same string, else double quoted.
fn scalar(text: &str) -> String {
    let plain_safe = !text.is_empty()
        && !text.starts_with([' ', '-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"', '%', '@', '`'])
        && !text.ends_with(' ')
        && !text.contains(": ")
        && !text.contains(" #")
        && !text.contains(['\n', '\r', '\t'])
        && matches!(serde_yaml::from_str::<serde_yaml::Value>(&format!("k: {text}")), Ok(serde_yaml::Value::Mapping(m)) if m.get("k") == Some(&serde_yaml::Value::String(text.to_string())));
    if plain_safe { text.to_string() } else { json_string(text) }
}

fn key_text(key: &str) -> String {
    let plain = !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.') && !key.starts_with('-');
    if plain { key.to_string() } else { json_string(key) }
}

fn render_entry(name: &str, entry: &[(String, String)]) -> Vec<String> {
    let mut out = vec![format!("{}:", key_text(name))];
    out.extend(entry.iter().map(|(k, v)| format!("  {}: {}", key_text(k), scalar(v))));
    out
}

fn join(lines: Vec<String>, trailing_newline: bool) -> String {
    let mut text = lines.join("\n");
    if trailing_newline || !text.is_empty() {
        text.push('\n');
    }
    text
}

/// The document's lines, unless it is not a block mapping this editor can
/// edit (a flow mapping such as `{}`), in which case its entries.
fn editable(text: &str) -> Result<Vec<&str>, Vec<(String, serde_yaml::Value)>> {
    let lines: Vec<&str> = text.lines().collect();
    let flow = lines.iter().any(|l| l.starts_with(['{', '[']));
    if !flow {
        return Ok(lines);
    }
    let entries = match serde_yaml::from_str::<serde_yaml::Value>(text) {
        Ok(serde_yaml::Value::Mapping(m)) => m.into_iter().filter_map(|(k, v)| Some((scalar_text(&k)?, v))).collect(),
        _ => Vec::new(),
    };
    Err(entries)
}

/// Every entry rendered afresh: a document this editor cannot edit line by line.
fn rerender(entries: Vec<(String, serde_yaml::Value)>, name: &str, entry: Option<&[(String, String)]>) -> String {
    let mut lines = Vec::new();
    let mut placed = false;
    for (key, value) in entries {
        if key == name {
            placed = true;
            if let Some(entry) = entry {
                lines.extend(render_entry(name, entry));
            }
            continue;
        }
        let fields: Vec<(String, String)> = match value {
            serde_yaml::Value::Mapping(m) => m.into_iter().filter_map(|(k, v)| Some((scalar_text(&k)?, scalar_text(&v)?))).collect(),
            _ => Vec::new(),
        };
        lines.extend(render_entry(&key, &fields));
    }
    if !placed && let Some(entry) = entry {
        lines.extend(render_entry(name, entry));
    }
    join(lines, true)
}

/// Set fields of one entry, each on its own line.
pub fn set_fields(text: &str, name: &str, fields: &Fields) -> String {
    let lines = match editable(text) {
        Ok(lines) => lines,
        Err(entries) => {
            let mut entry = entries
                .iter()
                .find(|(k, _)| k == name)
                .and_then(|(_, v)| match v {
                    serde_yaml::Value::Mapping(m) => Some(m.iter().filter_map(|(k, v)| Some((scalar_text(k)?, scalar_text(v)?))).collect::<Vec<_>>()),
                    _ => None,
                })
                .unwrap_or_default();
            merge_into(&mut entry, fields);
            return rerender(entries, name, Some(&entry));
        }
    };
    let Some(block) = find_block(&lines, name) else {
        let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        let entry: Vec<(String, String)> = fields.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        out.extend(render_entry(name, &entry));
        return join(out, true);
    };
    if block.inline {
        let mut entry = current_entry(text, name);
        merge_into(&mut entry, fields);
        return replace_entry(text, name, &entry);
    }
    let indent = (block.head + 1..block.end)
        .find(|&i| !is_blank_or_comment(lines[i]))
        .map(|i| lines[i].len() - lines[i].trim_start_matches(' ').len())
        .unwrap_or(2)
        .max(1);
    let mut out: Vec<String> = lines[..block.end].iter().map(|l| l.to_string()).collect();
    let mut appended = Vec::new();
    for (field, value) in fields {
        let line = format!("{}{}: {}", " ".repeat(indent), key_text(field), scalar(value));
        let at = (block.head + 1..block.end).find(|&i| key_of(lines[i], indent).is_some_and(|(k, _)| k == *field));
        match at {
            Some(at) => {
                // The field's value may run on over deeper-indented lines.
                let mut last = at + 1;
                while last < block.end && (lines[last].len() - lines[last].trim_start_matches(' ').len() > indent || lines[last].trim().is_empty()) {
                    last += 1;
                }
                out[at] = line;
                for slot in out.iter_mut().take(last).skip(at + 1) {
                    *slot = String::from("\u{0}");
                }
            }
            None => appended.push(line),
        }
    }
    out.retain(|l| l != "\u{0}");
    out.extend(appended);
    out.extend(lines[block.end..].iter().map(|l| l.to_string()));
    join(out, true)
}

fn merge_into(entry: &mut Vec<(String, String)>, fields: &Fields) {
    for (k, v) in fields {
        match entry.iter_mut().find(|(ek, _)| ek == k) {
            Some(slot) => slot.1 = v.clone(),
            None => entry.push((k.clone(), v.clone())),
        }
    }
}

fn current_entry(text: &str, name: &str) -> Vec<(String, String)> {
    match serde_yaml::from_str::<serde_yaml::Value>(text) {
        Ok(serde_yaml::Value::Mapping(m)) => match m.get(name) {
            Some(serde_yaml::Value::Mapping(entry)) => entry.iter().filter_map(|(k, v)| Some((scalar_text(k)?, scalar_text(v)?))).collect(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// Replace (or add at the end) one whole entry.
pub fn replace_entry(text: &str, name: &str, entry: &[(String, String)]) -> String {
    let lines = match editable(text) {
        Ok(lines) => lines,
        Err(entries) => return rerender(entries, name, Some(entry)),
    };
    let mut out: Vec<String> = Vec::new();
    match find_block(&lines, name) {
        Some(block) => {
            out.extend(lines[..block.head].iter().map(|l| l.to_string()));
            out.extend(render_entry(name, entry));
            out.extend(lines[block.end..].iter().map(|l| l.to_string()));
        }
        None => {
            out.extend(lines.iter().map(|l| l.to_string()));
            out.extend(render_entry(name, entry));
        }
    }
    join(out, true)
}

pub fn delete_entry(text: &str, name: &str) -> String {
    let lines = match editable(text) {
        Ok(lines) => lines,
        Err(entries) => return rerender(entries, name, None),
    };
    match find_block(&lines, name) {
        Some(block) => {
            let mut out: Vec<String> = lines[..block.head].iter().map(|l| l.to_string()).collect();
            out.extend(lines[block.end..].iter().map(|l| l.to_string()));
            join(out, false)
        }
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(pairs: &[(&str, &str)]) -> Fields {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn a_field_is_set_in_place_and_a_new_one_after_the_entry_with_comments_kept() {
        let text = "# keep this comment\nacme:\n  external: acme_crm\n  access_token: stale-token # inline\n\nother:\n  external: x\n";
        let next = set_fields(text, "acme", &fields(&[("access_token", "fresh-token"), ("expires_at", "2026-01-01T00:00:00.000Z")]));
        assert_eq!(
            next,
            "# keep this comment\nacme:\n  external: acme_crm\n  access_token: fresh-token\n  expires_at: 2026-01-01T00:00:00.000Z\n\nother:\n  external: x\n"
        );
        let added = set_fields("", "new", &fields(&[("a", "b")]));
        assert_eq!(added, "new:\n  a: b\n");
    }

    #[test]
    fn values_that_would_read_back_as_another_type_are_quoted() {
        assert_eq!(scalar("8765"), "\"8765\"");
        assert_eq!(scalar("true"), "\"true\"");
        assert_eq!(scalar(""), "\"\"");
        assert_eq!(scalar("a: b"), "\"a: b\"");
        assert_eq!(scalar("dev-acme-token"), "dev-acme-token");
        assert_eq!(scalar("http://127.0.0.1:9/token"), "http://127.0.0.1:9/token");
        let entry = vec![("module".to_string(), "acme_crm".to_string()), ("redirect_port".to_string(), "0".to_string())];
        let text = replace_entry("# head\n", "acme_crm", &entry);
        let back: serde_yaml::Value = serde_yaml::from_str(&text).unwrap();
        assert_eq!(back["acme_crm"]["redirect_port"], serde_yaml::Value::String("0".into()));
    }

    #[test]
    fn whole_entries_are_replaced_and_deleted_in_place() {
        let text = "# lf's app\nacme:\n  external: acme_crm\n  token: t\n# about b\nb:\n  module: m\n";
        let replaced = replace_entry(text, "acme", &[("module".into(), "acme_crm".into()), ("credential".into(), "acme".into()), ("token".into(), "t".into())]);
        assert_eq!(replaced, "# lf's app\nacme:\n  module: acme_crm\n  credential: acme\n  token: t\n# about b\nb:\n  module: m\n");
        assert_eq!(delete_entry(&replaced, "acme"), "# lf's app\n# about b\nb:\n  module: m\n");
        assert_eq!(replace_entry("{}\n", "x", &[("a".into(), "b".into())]), "x:\n  a: b\n");
    }
}
