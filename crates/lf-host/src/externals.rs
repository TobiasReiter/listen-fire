//! Externals: the project's installed modules (a folder each under the
//! externals folder, with an `lf-external.yaml`), read and started as the
//! TypeScript lf does (apps/cli/src/externals.ts). An external is a process
//! speaking adapter protocol 2 over HTTP: started with `PORT=0`, it prints
//! `listening <port>`. A `module` external is served by `serve-module` (the
//! module kit's runner; `LF_SERVE_MODULE` names another command). A plugin
//! external serves a package of plugins instead of an adapter.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::json::{Js, Obj};
use crate::project::Project;
use crate::credential_calls::{Sending, Target, send};
use crate::oauth2::{Declaration, declarations_of};
use crate::protocol::shape_error;
use crate::secrets::{Credentials, credential_for, signer_of};

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
    /// A module (a path relative to the folder, or a package) served by
    /// `serve-module`.
    pub module: Option<String>,
    pub auth: Option<Auth>,
    /// How its webhooks are signed when its manifest declares no `inbound`.
    pub webhook: Option<WebhookBlock>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// `webhook:` — the protocol's own scheme, keyed by one of the install's fields.
#[derive(Debug, Clone, Deserialize)]
pub struct WebhookBlock {
    pub signature: String,
    #[serde(default = "remote_signature_header")]
    pub header: String,
    #[serde(rename = "secretField")]
    pub secret_field: String,
}

fn remote_signature_header() -> String {
    "x-listen-fire-signature".into()
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
        let reaches = [manifest.command.is_some(), manifest.url.is_some(), manifest.module.is_some()].iter().filter(|r| **r).count();
        if reaches != 1 {
            return Err(format!("{}: an external needs exactly one of `command`, `url` or `module`", file.display()));
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
    if manifest.webhook.as_ref().is_some_and(|w| w.signature != "hmac-sha256") {
        return Err("webhook.signature: expected \"hmac-sha256\"".into());
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
    /// The protocol methods it implements (`methods`).
    pub methods: Vec<String>,
    /// `runtimeCapabilities`, as it answered them.
    pub runtime_capabilities: Js,
    pub webhook_event_type_id: Option<String>,
    /// The package of plugins it serves (`plugins`: `{ package, plugins }`).
    pub plugins: Option<Js>,
    /// The credentials its manifest declares (`credentials`); the first is
    /// sent on each call (src/credential_calls.rs).
    pub credential_declarations: Vec<Declaration>,
    /// Its manifest answer as it came (what `lf connect` reads of it).
    pub manifest_answer: Js,
    /// How its manifest says its webhooks are signed (crate::doors).
    pub inbound: Option<crate::inbound::Declaration>,
    /// The started process; killed when this is dropped.
    _child: Option<Child>,
}

impl RunningExternal {
    pub fn is_plugin(&self) -> bool {
        self.external.manifest.kind == "plugin"
    }

    /// Whether it serves `plugin` (either spelling).
    pub fn serves_plugin(&self, plugin: &str) -> bool {
        let spelled = plugin.replace('-', "_");
        plugin_entries(self.plugins.as_ref()).iter().any(|(name, _)| name.replace('-', "_") == spelled)
    }
}

/// The `{ name, spec }` entries of a plugins declaration, in order.
pub fn plugin_entries(declared: Option<&Js>) -> Vec<(String, Js)> {
    declared
        .and_then(|d| d.get("plugins"))
        .and_then(Js::as_array)
        .unwrap_or(&[])
        .iter()
        .filter_map(|entry| Some((entry.get("name")?.as_str()?.to_string(), entry.get("spec")?.clone())))
        .collect()
}

/// The plugin external that serves `plugin`.
pub fn plugin_external_for<'r>(running: &'r [RunningExternal], plugin: &str) -> Option<&'r RunningExternal> {
    running.iter().find(|r| r.serves_plugin(plugin))
}

/// One call to a running external, under the credential its secrets name.
pub async fn rpc(running: &RunningExternal, credentials: &Credentials, tenant: &str, method: &str, params: serde_json::Value) -> Result<Js, String> {
    let target = Target { external: &running.external, base_url: &running.base_url, declarations: &running.credential_declarations, methods: &running.methods };
    call(&target, credentials, tenant, method, params).await
}

async fn call(target: &Target<'_>, credentials: &Credentials, tenant: &str, method: &str, params: serde_json::Value) -> Result<Js, String> {
    let credential = credential_for(credentials, &target.external.manifest.name);
    let signer = signer_of(credentials, &target.external.manifest.name, credential);
    Ok(send(target, credentials, credential, signer, Sending { tenant, method, cache_scope_id: "<none>", params }).await?)
}

/// Start (or reach) every external and read its manifest.
pub async fn start_externals(project: &Project, externals: &[External], credentials: &Credentials, tenant: &str) -> Result<Vec<RunningExternal>, String> {
    let mut running = Vec::new();
    for external in externals {
        let (base_url, child) = reach(project, external).await?;
        let name = &external.manifest.name;
        let target = Target { external, base_url: &base_url, declarations: &[], methods: &[] };
        let raw = call(&target, credentials, tenant, "manifest", json!({})).await?;
        let version = raw.get("protocolVersion");
        if !matches!(version, Some(Js::Num(n)) if n.as_f64() == Some(MANIFEST_PROTOCOL_VERSION as f64)) {
            let got = version.map(Js::to_json).unwrap_or_else(|| "nothing".into());
            return Err(format!(
                "external \"{name}\": protocolVersion: expected {MANIFEST_PROTOCOL_VERSION}, got {got} — this adapter targets an older adapter protocol; update it to protocol version {MANIFEST_PROTOCOL_VERSION}."
            ));
        }
        let manifest = WireManifest::read(&raw).map_err(|expected| shape_error("manifest", name, &raw, &expected))?;
        if manifest.adapter_type != *name {
            return Err(format!("external folder \"{name}\" serves \"{}\"; the names must agree", manifest.adapter_type));
        }
        let credential_declarations = declarations_of(&raw).map_err(|expected| shape_error("manifest", name, &raw, &expected))?;
        if external.manifest.kind == "plugin" && manifest.plugins.is_none() {
            return Err(format!("external \"{name}\" is a plugin external, but its manifest declares no plugins"));
        }
        running.push(RunningExternal {
            external: external.clone(),
            base_url,
            supported_triggers: manifest.supported_triggers,
            listen: manifest.listen,
            methods: manifest.methods,
            runtime_capabilities: manifest.runtime_capabilities,
            webhook_event_type_id: manifest.webhook_event_type_id,
            plugins: manifest.plugins,
            credential_declarations,
            manifest_answer: raw,
            inbound: manifest.inbound,
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
    methods: Vec<String>,
    runtime_capabilities: Js,
    webhook_event_type_id: Option<String>,
    plugins: Option<Js>,
    inbound: Option<crate::inbound::Declaration>,
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
        let methods = strings("methods")?;
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
        // As the schema parses it: the two declared members, in order.
        let traversal = capabilities.and_then(|c| c.get("traversal"));
        let runtime_capabilities = Js::Obj(crate::obj! {
            "traversal" => Js::Obj(crate::obj! {
                "incoming" => traversal.and_then(|t| t.get("incoming")).cloned().unwrap_or(Js::Null),
                "edgeProperties" => traversal.and_then(|t| t.get("edgeProperties")).cloned().unwrap_or(Js::Null),
            }),
            "resources" => capabilities.and_then(|c| c.get("resources")).cloned().unwrap_or(Js::Null),
        });
        let webhook_event_type_id = raw.get("webhookEventTypeId").and_then(Js::as_str).map(str::to_string);
        let plugins = plugins_declaration(raw, &methods)?;
        let inbound = raw.get("inbound").map(crate::inbound::Declaration::read).transpose().map_err(|issue| format!("inbound.{issue}"))?;
        Ok(WireManifest { adapter_type, supported_triggers, listen: listen_declarations(raw)?, methods, runtime_capabilities, webhook_event_type_id, plugins, inbound })
    }
}

/// `WirePluginsDeclaration`, paired with `invokePlugin` as the manifest
/// schema pairs them: a package tag and at least one `{ name, spec }`.
fn plugins_declaration(raw: &Js, methods: &[String]) -> Result<Option<Js>, String> {
    let lists = methods.iter().any(|m| m == "invokePlugin");
    let Some(declared) = raw.get("plugins") else {
        return if lists { Err("plugins: lists `invokePlugin` in methods but declares no `plugins`".into()) } else { Ok(None) };
    };
    if !lists {
        return Err("methods: declares `plugins` but does not list `invokePlugin` in methods".into());
    }
    if !declared.get("package").and_then(Js::as_str).is_some_and(|p| !p.is_empty()) {
        return Err("plugins.package: expected a non-empty string".into());
    }
    let entries = declared.get("plugins").and_then(Js::as_array).ok_or("plugins.plugins: expected an array")?;
    if entries.is_empty() {
        return Err("plugins.plugins: expected at least one plugin".into());
    }
    for entry in entries {
        if !entry.get("name").and_then(Js::as_str).is_some_and(|n| !n.is_empty()) || !matches!(entry.get("spec"), Some(Js::Obj(_))) {
            return Err("plugins.plugins: expected { name, spec } entries".into());
        }
    }
    Ok(Some(declared.clone()))
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
    let served: Vec<String>;
    let command_line = match &external.manifest.module {
        Some(module) => {
            served = [serve_module_command(project, name)?, vec![module.clone()]].concat();
            Some(served.as_slice())
        }
        None => external.manifest.command.as_deref(),
    };
    let Some((command, args)) = command_line.and_then(<[String]>::split_first) else {
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
        .envs(crate::serve::host_url().map(|url| ("LF_HOST_URL", url)))
        .envs(external.manifest.env.iter().map(|(k, v)| (k, v.replace("{lf}", &lf))))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("external \"{name}\": {command} could not be started ({e})"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut lines = BufReader::new(stdout).lines();
    let waited = project.start_timeout;
    let port = tokio::time::timeout(waited, async {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(port) = listening_port(&line) {
                return Ok(port);
            }
        }
        Err(format!("external \"{name}\" exited before listening"))
    })
    .await
    .map_err(|_| {
        format!(
            "external \"{name}\" did not print \"listening <port>\" within {}s (lf.yaml's `startTimeout`, or --start-timeout, waits longer)",
            waited.as_secs()
        )
    })??;
    // Keep reading what it prints, so a full pipe never blocks it.
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    Ok((format!("http://127.0.0.1:{port}/"), Some(child)))
}

/// How a `module` external is served: `LF_SERVE_MODULE` when set, else the
/// module kit's `serve-module` as the TypeScript lf finds it
/// (`require.resolve('module-kit/bin/serve-module.cjs')`): the project's
/// node_modules (its `.bin` shim, or the package's script under node), then
/// the workspace lf-host was built in.
fn serve_module_command(project: &Project, external: &str) -> Result<Vec<String>, String> {
    if let Some(command) = std::env::var("LF_SERVE_MODULE").ok().filter(|c| !c.is_empty()) {
        return Ok(vec![command]);
    }
    let script = |base: &Path| -> Option<Vec<String>> {
        let shim = base.join("node_modules/.bin/serve-module");
        if shim.is_file() {
            return Some(vec![shim.display().to_string()]);
        }
        ["node_modules/module-kit/bin/serve-module.cjs", "packages/module-kit/bin/serve-module.cjs"]
            .iter()
            .map(|relative| base.join(relative))
            .find(|path| path.is_file())
            .map(|path| vec!["node".to_string(), path.display().to_string()])
    };
    let from_binary = std::env::current_exe().ok().and_then(|exe| exe.canonicalize().ok());
    let bases = project.root.ancestors().chain(from_binary.iter().flat_map(|exe| exe.ancestors().skip(1)));
    for base in bases {
        if let Some(command) = script(base) {
            return Ok(command);
        }
    }
    Err(format!(
        "external \"{external}\" is a module, and lf found no serve-module to serve it: add module-kit to the project (its node_modules), or set LF_SERVE_MODULE to the command that serves a module"
    ))
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
    fn serve_module_is_found_in_the_projects_node_modules_then_the_workspace() {
        if std::env::var_os("LF_SERVE_MODULE").is_some() {
            return;
        }
        let root = std::env::temp_dir().join(format!("lf-serve-module-{}", uuid::Uuid::new_v4()));
        let script = root.join("node_modules/module-kit/bin/serve-module.cjs");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(&script, "").unwrap();
        let mut project = test_project(&root);
        assert_eq!(serve_module_command(&project, "m").unwrap(), vec!["node".to_string(), script.display().to_string()]);
        // No copy in the project: the workspace this binary was built in has one.
        std::fs::remove_file(&script).unwrap();
        project.root = root.join("elsewhere");
        let found = serve_module_command(&project, "m").unwrap();
        assert!(found.last().unwrap().ends_with("serve-module.cjs") || found[0].ends_with("serve-module"), "{found:?}");
        std::fs::remove_dir_all(&root).unwrap();
    }

    fn test_project(root: &Path) -> Project {
        Project {
            root: root.to_path_buf(),
            lf_dir: root.join(".lf"),
            engine: String::new(),
            language_version: 5,
            movements_dir: root.join("movements"),
            externals_dir: root.join("externals"),
            user: (None, None),
            store: None,
            public_url: None,
            start_timeout: crate::project::DEFAULT_START_TIMEOUT,
            cost_cap_microdollars: None,
        }
    }

    #[test]
    fn the_port_is_read_off_the_listening_line() {
        assert_eq!(listening_port("listening 5557"), Some(5557));
        assert_eq!(listening_port("listening 80 on all"), Some(80));
        assert_eq!(listening_port("ready"), None);
    }

    #[test]
    fn a_plugins_declaration_pairs_with_invoke_plugin() {
        let declared = r#""plugins": { "package": "@lf/web", "plugins": [{ "name": "fetch-url", "spec": { "args": ["url"] } }] }"#;
        let with = |methods: &str, plugins: bool| {
            let body = if plugins { format!("{{ {declared} }}") } else { "{}".to_string() };
            plugins_declaration(&Js::parse(body.as_bytes()).unwrap(), &methods.split(',').filter(|m| !m.is_empty()).map(str::to_string).collect::<Vec<_>>())
        };
        assert!(with("manifest,invokePlugin", true).unwrap().is_some());
        assert_eq!(with("manifest", false).unwrap(), None);
        assert!(with("manifest", true).unwrap_err().contains("does not list `invokePlugin`"));
        assert!(with("manifest,invokePlugin", false).unwrap_err().contains("declares no `plugins`"));
        let empty = Js::parse(br#"{ "plugins": { "package": "@lf/web", "plugins": [] } }"#).unwrap();
        assert!(plugins_declaration(&empty, &["invokePlugin".to_string()]).unwrap_err().contains("at least one"));
    }

    #[test]
    fn listen_declarations_keep_only_the_three() {
        let raw = Js::parse(br#"{ "subscribableEvents": ["a"], "other": 1, "listenConfig": [{ "key": "schedule", "required": true, "extra": 2 }] }"#).unwrap();
        let listen = listen_declarations(&raw).unwrap();
        assert_eq!(Js::Obj(listen).to_json(), r#"{"subscribableEvents":["a"],"listenConfig":[{"key":"schedule","required":true}]}"#);
    }
}
