//! Externals: the project's installed modules (a folder each under the
//! externals folder, with an `lf-external.yaml`), read and started as the
//! TypeScript lf does (apps/cli/src/externals.ts). An adapter external is a
//! process speaking adapter protocol 2 over HTTP: started with `PORT=0`, it
//! prints `listening <port>`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::json::{Js, Obj};
use crate::project::Project;
use crate::protocol::{Call, post_rpc, shape_error};
use crate::secrets::{Credential, Credentials, credential_for, refuse_stale};

pub const EXTERNAL_MANIFEST: &str = "lf-external.yaml";

/// The manifest protocol version (`MANIFEST_PROTOCOL_VERSION`).
const MANIFEST_PROTOCOL_VERSION: u64 = 2;

/// The trigger types a manifest may name (`triggerTypeSchema`).
const TRIGGER_TYPES: &[&str] = &["snapshot", "poll", "changes-feed", "webhook", "mutation", "extraction"];

#[derive(Debug, Clone, Deserialize)]
pub struct ExternalManifest {
    pub name: String,
    #[serde(default = "adapter_kind")]
    pub kind: String,
    #[serde(default = "protocol_2")]
    pub protocol: u64,
    pub command: Option<Vec<String>>,
    pub url: Option<String>,
    pub auth: Option<Auth>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Auth {
    pub kind: String,
    pub field: String,
}

fn adapter_kind() -> String {
    "adapter".into()
}

fn protocol_2() -> u64 {
    2
}

#[derive(Debug, Clone)]
pub struct External {
    pub dir: PathBuf,
    pub manifest: ExternalManifest,
}

pub fn scan_externals(project: &Project) -> Result<Vec<External>, String> {
    if !project.externals_dir.exists() {
        return Ok(Vec::new());
    }
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&project.externals_dir)
        .map_err(|e| format!("{}: {e}", project.externals_dir.display()))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .map(|entry| entry.path())
        .collect();
    // `readdirSync` lists in the file system's order; sorting is that order
    // on the file systems lf runs on (APFS, ext4 list by name).
    dirs.sort();
    let mut found = Vec::new();
    for dir in dirs {
        let file = dir.join(EXTERNAL_MANIFEST);
        if !file.exists() {
            continue;
        }
        let text = std::fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))?;
        let manifest: ExternalManifest = serde_yaml::from_str(&text).map_err(|e| format!("{}: {e}", file.display()))?;
        validate(&manifest).map_err(|issue| format!("{}: {issue}", file.display()))?;
        if manifest.kind == "adapter" && manifest.command.is_none() && manifest.url.is_none() {
            return Err(format!("{}: an adapter external needs a `command` or a `url`", file.display()));
        }
        found.push(External { dir, manifest });
    }
    Ok(found)
}

fn validate(manifest: &ExternalManifest) -> Result<(), String> {
    if manifest.name.is_empty() {
        return Err("name: Too small: expected string to have >=1 characters".into());
    }
    if manifest.kind != "adapter" && manifest.kind != "plugin" {
        return Err(format!("kind: expected \"adapter\" or \"plugin\", got \"{}\"", manifest.kind));
    }
    if manifest.protocol != 2 {
        return Err("protocol: expected 2".into());
    }
    if manifest.command.as_ref().is_some_and(Vec::is_empty) {
        return Err("command: expected at least one item".into());
    }
    if manifest.auth.as_ref().is_some_and(|a| a.kind != "bearer") {
        return Err("auth.kind: expected \"bearer\"".into());
    }
    Ok(())
}

/// An adapter external the host can call: where it answers, and its manifest answer.
pub struct RunningExternal {
    pub external: External,
    pub base_url: String,
    pub supported_triggers: Vec<String>,
    /// What a listen on it may say (`WireListenDeclarations`), as JSON.
    pub listen: Obj,
    /// The started process; killed when this is dropped.
    _child: Option<Child>,
}

/// The `Authorization` secret a call to this external carries.
pub fn call_secret<'c>(external: &External, credential: Option<&'c Credential>) -> Result<Option<&'c str>, String> {
    let Some(auth) = &external.manifest.auth else { return Ok(None) };
    let name = &external.manifest.name;
    let Some(credential) = credential else {
        return Err(format!("external \"{name}\" needs a credential (its auth field is \"{}\")", auth.field));
    };
    match credential.fields.get(&auth.field) {
        Some(secret) => Ok(Some(secret.as_str())),
        None => Err(format!("credential \"{}\" has no \"{}\" field, which external \"{name}\" sends", credential.name, auth.field)),
    }
}

/// One call to a running external, under the credential its secrets name.
pub async fn rpc(running: &RunningExternal, credentials: &Credentials, tenant: &str, method: &str, params: serde_json::Value) -> Result<Js, String> {
    call(&running.external, &running.base_url, credentials, tenant, method, params).await
}

async fn call(external: &External, base_url: &str, credentials: &Credentials, tenant: &str, method: &str, params: serde_json::Value) -> Result<Js, String> {
    let credential = credential_for(credentials, &external.manifest.name);
    if let Some(credential) = credential {
        refuse_stale(credential, jiff::Timestamp::now().as_millisecond())?;
    }
    let bearer = call_secret(external, credential)?;
    post_rpc(Call { base_url, bearer, team_id: tenant, method, params }).await
}

/// Start (or reach) every adapter external and read its manifest.
pub async fn start_externals(project: &Project, externals: &[External], credentials: &Credentials, tenant: &str) -> Result<Vec<RunningExternal>, String> {
    let mut running = Vec::new();
    for external in externals {
        if external.manifest.kind != "adapter" {
            continue;
        }
        let (base_url, child) = reach(project, external).await?;
        let name = &external.manifest.name;
        let raw = call(external, &base_url, credentials, tenant, "manifest", json!({})).await?;
        let version = raw.get("protocolVersion");
        if !matches!(version, Some(Js::Num(n)) if n.as_f64() == Some(MANIFEST_PROTOCOL_VERSION as f64)) {
            let got = version.map(Js::to_json).unwrap_or_else(|| "nothing".into());
            return Err(format!(
                "external \"{name}\": protocolVersion: expected {MANIFEST_PROTOCOL_VERSION}, got {got} — this adapter targets an older adapter protocol; update it to protocol version {MANIFEST_PROTOCOL_VERSION}."
            ));
        }
        let manifest = WireManifest::read(&raw).map_err(|expected| shape_error("manifest", name, &raw, &expected))?;
        if manifest.adapter_type != *name {
            return Err(format!("external folder \"{name}\" serves adapter \"{}\"; the names must agree", manifest.adapter_type));
        }
        running.push(RunningExternal {
            external: external.clone(),
            base_url,
            supported_triggers: manifest.supported_triggers,
            listen: manifest.listen,
            _child: child,
        });
    }
    Ok(running)
}

/// The manifest answer's facts `check` reads, validated as `WireManifestResult` is.
struct WireManifest {
    adapter_type: String,
    supported_triggers: Vec<String>,
    listen: Obj,
}

impl WireManifest {
    fn read(raw: &Js) -> Result<WireManifest, String> {
        let strings = |key: &str| -> Result<Vec<String>, String> {
            raw.get(key)
                .and_then(Js::as_array)
                .and_then(|items| items.iter().map(|i| i.as_str().map(str::to_string)).collect::<Option<Vec<_>>>())
                .ok_or_else(|| format!("{key}: expected an array of strings"))
        };
        let adapter_type = raw.get("adapterType").and_then(Js::as_str).ok_or("adapterType: expected string")?.to_string();
        let supported_triggers = strings("supportedTriggers")?;
        strings("methods")?;
        let capabilities = raw.get("runtimeCapabilities");
        let flag = |path: &[&str]| path.iter().try_fold(capabilities, |v, k| v.map(|v| v.get(k))).flatten().is_some_and(|v| matches!(v, Js::Bool(_)));
        if !(flag(&["traversal", "incoming"]) && flag(&["traversal", "edgeProperties"]) && flag(&["resources"])) {
            return Err("runtimeCapabilities: expected { traversal: { incoming, edgeProperties }, resources }".into());
        }
        if raw.get("webhookEventTypeId").is_some_and(|v| v.as_str().is_none()) {
            return Err("webhookEventTypeId: expected string".into());
        }
        for trigger in &supported_triggers {
            if !TRIGGER_TYPES.contains(&trigger.as_str()) {
                return Err(format!("supportedTriggers: \"{trigger}\" is not a trigger type ({})", TRIGGER_TYPES.join(", ")));
            }
        }
        Ok(WireManifest { adapter_type, supported_triggers, listen: listen_declarations(raw)? })
    }
}

/// `WireListenDeclarations.parse`: the three declarations, unknown keys stripped.
fn listen_declarations(raw: &Js) -> Result<Obj, String> {
    let mut out = Obj::new();
    for key in ["subscribableEvents", "defaultSubscribedEvents"] {
        let Some(value) = raw.get(key) else { continue };
        let ok = value.as_array().is_some_and(|items| items.iter().all(|i| i.as_str().is_some_and(|s| !s.is_empty())));
        if !ok {
            return Err(format!("{key}: expected an array of non-empty strings"));
        }
        out.insert(key.into(), value.clone());
    }
    if let Some(value) = raw.get("listenConfig") {
        let items = value.as_array().ok_or("listenConfig: expected an array")?;
        let mut entries = Vec::new();
        for item in items {
            let key = item.get("key").and_then(Js::as_str).filter(|k| !k.is_empty()).ok_or("listenConfig.key: expected a non-empty string")?;
            let mut entry = Obj::new();
            entry.insert("key".into(), Js::str(key));
            if let Some(required) = item.get("required") {
                let Js::Bool(required) = required else { return Err("listenConfig.required: expected boolean".into()) };
                entry.insert("required".into(), Js::Bool(*required));
            }
            if let Some(format) = item.get("format") {
                let format = format.as_str().filter(|f| ["cron", "timezone", "fields", "strings"].contains(f));
                entry.insert("format".into(), Js::str(format.ok_or("listenConfig.format: expected cron, timezone, fields or strings")?));
            }
            entries.push(Js::Obj(entry));
        }
        out.insert("listenConfig".into(), Js::Arr(entries));
    }
    Ok(out)
}

async fn reach(project: &Project, external: &External) -> Result<(String, Option<Child>), String> {
    let name = &external.manifest.name;
    if let Some(url) = &external.manifest.url {
        return Ok((url.clone(), None));
    }
    let Some((command, args)) = external.manifest.command.as_deref().and_then(<[String]>::split_first) else {
        return Err(format!("external \"{name}\" has no command"));
    };
    let state_dir = project.lf_dir.join("externals").join(name);
    std::fs::create_dir_all(&state_dir).map_err(|e| format!("{}: {e}", state_dir.display()))?;
    let lf = project.lf_dir.display().to_string();
    let mut child = Command::new(command)
        .args(args)
        .current_dir(&external.dir)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("PORT", "0")
        .envs(external.manifest.env.iter().map(|(k, v)| (k, v.replace("{lf}", &lf))))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("external \"{name}\": {command} could not be started ({e})"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut lines = BufReader::new(stdout).lines();
    let port = tokio::time::timeout(Duration::from_secs(10), async {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(port) = listening_port(&line) {
                return Ok(port);
            }
        }
        Err(format!("external \"{name}\" exited before listening"))
    })
    .await
    .map_err(|_| format!("external \"{name}\" did not print \"listening <port>\" within 10s"))??;
    // Keep reading what it prints, so a full pipe never blocks it.
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    Ok((format!("http://127.0.0.1:{port}/"), Some(child)))
}

/// The port in a line `listening <port>…`.
fn listening_port(line: &str) -> Option<u16> {
    let digits: String = line.strip_prefix("listening ")?.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_port_is_read_off_the_listening_line() {
        assert_eq!(listening_port("listening 5557"), Some(5557));
        assert_eq!(listening_port("listening 80 on all"), Some(80));
        assert_eq!(listening_port("ready"), None);
    }

    #[test]
    fn listen_declarations_keep_only_the_three() {
        let raw = Js::parse(br#"{ "subscribableEvents": ["a"], "other": 1, "listenConfig": [{ "key": "schedule", "required": true, "extra": 2 }] }"#).unwrap();
        let listen = listen_declarations(&raw).unwrap();
        assert_eq!(Js::Obj(listen).to_json(), r#"{"subscribableEvents":["a"],"listenConfig":[{"key":"schedule","required":true}]}"#);
    }
}
