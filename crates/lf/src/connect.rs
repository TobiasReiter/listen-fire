//! `lf connect <module>`: set a module up for this project, once, by prompts —
//! never by editing the secrets file (apps/cli/src/connect.ts). Everything the
//! module needs before any user signs in:
//!   - installed: an `externals/<name>/lf-external.yaml`, serving a module
//!     package with serve-module, or reaching a module run separately at its
//!     server URL;
//!   - its install's secrets: the server secret a separately-run module checks
//!     (the external's `auth` field), the webhook secret its inbound deliveries
//!     are signed with, and the OAuth app's client id and secret, stored once
//!     per module, with the redirect port the app registered.
//!
//! User credentials are not set up here: `lf credential add --module <module>`.
//! With no module named, it lists the modules it knows.

use std::collections::BTreeSet;
use std::path::Path;

use crate::check::LOCAL_TENANT;
use crate::externals::{EXTERNAL_MANIFEST, External, ExternalManifest, scan_externals, start_externals};
use crate::http_out::{hex, random_bytes};
use crate::json::Js;
use crate::oauth2::{Declaration, declarations_of};
use crate::oauth_redirect::{loopback_redirect_uri, public_redirect_uri};
use crate::project::Project;
use crate::prompt::{Ask, Prompter};
use crate::secret_stores::{EntryChange, change_entry, secrets_file_for_writes};
use crate::secrets::{Binding, Credential, Credentials, Origin, install_of, load_secrets};

/// The install's fields for the OAuth app at the provider.
pub const CLIENT_ID_FIELD: &str = "client_id";
pub const CLIENT_SECRET_FIELD: &str = "client_secret";
/// The loopback port the app registered (`http://127.0.0.1:<port>/callback`); 0: any.
pub const REDIRECT_PORT_FIELD: &str = "redirect_port";
/// The server secret field of a separately-run module lf connect installs.
const SERVER_SECRET_FIELD: &str = "server_secret";
/// The field of an install that holds the webhook secret, unless its external says another.
const DEFAULT_WEBHOOK_SECRET_FIELD: &str = "webhook_secret";

pub fn process_env() -> Vec<(String, String)> {
    std::env::vars().collect()
}

/// An installed external named by its name, its folder, or the module it serves.
pub fn find_external(project: &Project, reference: &str) -> Result<Option<External>, String> {
    let folder = project.externals_dir.join(reference);
    Ok(scan_externals(project)?.into_iter().find(|e| e.manifest.name == reference || e.manifest.module.as_deref() == Some(reference) || e.dir == folder))
}

/// What one external's manifest answer says that these commands read.
pub struct ManifestFacts {
    pub declarations: Vec<Declaration>,
    pub answer: Js,
}

/// Start one external long enough to read its manifest answer.
pub async fn read_manifest(project: &Project, external: &External, install: Option<&Credential>) -> Result<ManifestFacts, String> {
    let credentials: Credentials = install.into_iter().cloned().collect();
    let running = start_externals(project, std::slice::from_ref(external), &credentials, LOCAL_TENANT).await?;
    let started = running.into_iter().next().ok_or_else(|| format!("external \"{}\" did not answer its manifest", external.manifest.name))?;
    Ok(ManifestFacts { declarations: declarations_of(&started.manifest_answer)?, answer: started.manifest_answer.clone() })
}

/// `lf connect` with no module: the installed externals, and module packages
/// the project can install.
pub fn known_modules(project: &Project) -> Result<Vec<String>, String> {
    let credentials = load_secrets(project, &process_env())?;
    let installed = scan_externals(project)?;
    let mut lines = Vec::new();
    for external in &installed {
        let name = &external.manifest.name;
        let how = match (&external.manifest.module, &external.manifest.url) {
            (Some(module), _) => format!("module {module}"),
            (None, Some(url)) => format!("at {url}"),
            (None, None) => "command".to_string(),
        };
        let install = match install_of(&credentials, name) {
            Some(install) => format!("install set up ({})", install.name),
            None => "install not set up".to_string(),
        };
        let users: Vec<&str> = credentials.iter().filter(|c| c.external == *name && c.binding != Binding::Install).map(|c| c.name.as_str()).collect();
        let users = if users.is_empty() { "none".to_string() } else { users.join(", ") };
        lines.push(format!("{name}  installed ({how}); {install}; credentials: {users}"));
    }
    let core_processes = crate::externals::core_modules_in(&project.externals_dir)?;
    for module in crate::core::BUILTIN.iter().chain(&core_processes) {
        let needs_setup = module.settings.iter().any(|s| !s.optional);
        let set_up = match (install_of(&credentials, &module.name).is_some(), needs_setup) {
            (true, _) => "set up",
            (false, false) => "ready with its defaults",
            (false, true) => "not set up",
        };
        let how = if module.process.is_some() { "installed" } else { "built-in" };
        lines.push(format!("{}  {how} {} module; {set_up} (lf connect {})", module.name, module.slot.name(), module.name));
    }
    let installed_modules: BTreeSet<&str> = installed.iter().filter_map(|e| e.manifest.module.as_deref()).collect();
    for name in module_packages(&project.root) {
        if !installed_modules.contains(name.as_str()) {
            lines.push(format!("{name}  not installed (lf connect {name})"));
        }
    }
    Ok(lines)
}

/// The `@lf/*` packages in the project's node_modules.
pub fn module_packages(root: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root.join("node_modules").join("@lf")) else { return Vec::new() };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir() || t.is_symlink()))
        .map(|e| format!("@lf/{}", e.file_name().to_string_lossy()))
        .collect();
    names.sort();
    names
}

/// The secret field the external's inbound deliveries are signed with, when
/// it takes any (doors.ts `inboundSetupOf`): declared in its manifest answer,
/// or by the `webhook` block of its lf-external.yaml.
fn inbound_secret_field(external: &External, answer: &Js) -> Option<String> {
    let file: Option<serde_yaml::Value> = std::fs::read_to_string(external.dir.join(EXTERNAL_MANIFEST)).ok().and_then(|t| serde_yaml::from_str(&t).ok());
    let webhook = file.as_ref().and_then(|f| f.get("webhook")).filter(|w| !w.is_null());
    let secret_field = webhook.and_then(|w| w.get("secretField")).and_then(|f| f.as_str()).map(str::to_string);
    if answer.get("inbound").is_some() {
        return Some(secret_field.unwrap_or_else(|| DEFAULT_WEBHOOK_SECRET_FIELD.into()));
    }
    webhook.and(secret_field)
}

/// lf.yaml's `publicUrl`, when it names one: where `lf serve` is reached.
pub fn public_url(project: &Project) -> Option<String> {
    let text = std::fs::read_to_string(project.root.join(crate::project::PROJECT_FILE)).ok()?;
    let value: serde_yaml::Value = serde_yaml::from_str(&text).ok()?;
    value.get("publicUrl")?.as_str().map(str::to_string)
}

/// An entry as written to a secrets file: its binding keys first (secrets.ts `entryContent`).
pub fn entry_content(external: &str, binding: &Binding, fields: &[(String, String)]) -> Vec<(String, String)> {
    let mut entry = match binding {
        Binding::Legacy => vec![("external".to_string(), external.to_string())],
        Binding::Install => vec![("module".to_string(), external.to_string())],
        Binding::Credential(declared) => vec![("module".to_string(), external.to_string()), ("credential".to_string(), declared.clone())],
    };
    entry.extend(fields.iter().cloned());
    entry
}

/// `{ ...stored, ...next }` as an object spread orders it: a key keeps its
/// place, a new one goes at the end.
pub fn spread(mut stored: Vec<(String, String)>, next: Vec<(String, String)>) -> Vec<(String, String)> {
    for (key, value) in next {
        match stored.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => stored.push((key, value)),
        }
    }
    stored
}

pub async fn connect_module(project: &Project, reference: &str, prompter: &mut Prompter, url: Option<&str>) -> Result<(), String> {
    if let Some(module) = crate::core::builtin(reference) {
        return connect_core(project, module, prompter).await;
    }
    if let Some(module) = crate::externals::core_modules_in(&project.externals_dir)?.into_iter().find(|m| m.name == reference) {
        return connect_core(project, &module, prompter).await;
    }
    let env = process_env();
    let credentials = load_secrets(project, &env)?;
    let (external, created) = match find_external(project, reference)? {
        Some(found) => (found, false),
        None => (install_external(project, reference, prompter, url).await?, true),
    };
    let outcome = set_up(project, &external, &credentials, &env, prompter).await;
    if outcome.is_err() && created {
        let _ = std::fs::remove_dir_all(&external.dir);
    }
    outcome
}

async fn set_up(project: &Project, external: &External, credentials: &Credentials, env: &[(String, String)], prompter: &mut Prompter) -> Result<(), String> {
    let name = &external.manifest.name;
    let existing = install_of(credentials, name).filter(|c| !matches!(c.binding, Binding::Credential(_)));
    if let Some(existing) = existing
        && (existing.origin.file.is_none() || !existing.origin.env_fields.is_empty())
    {
        return Err(format!("the install of \"{name}\" (\"{}\") comes from the environment, which lf cannot write; change it there", existing.name));
    }
    let mut fields: Vec<(String, String)> = existing.map(|c| c.fields.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
    let mut cleared: BTreeSet<String> = BTreeSet::new();
    let current = |fields: &[(String, String)], field: &str| fields.iter().find(|(k, v)| k == field && !v.is_empty()).map(|(_, v)| v.clone());
    let put = |fields: &mut Vec<(String, String)>, field: &str, value: String| match fields.iter_mut().find(|(k, _)| k == field) {
        Some(slot) => slot.1 = value,
        None => fields.push((field.to_string(), value)),
    };

    // The server secret is needed to read the manifest of a module that checks it.
    if let Some(auth) = &external.manifest.auth {
        let now = current(&fields, &auth.field);
        let question = format!("the secret {name}'s server checks (field \"{}\")", auth.field);
        let answer = prompter.ask(&question, Ask { secret: true, default: now.as_deref(), ..Ask::default() }).await?;
        put(&mut fields, &auth.field, answer);
    }
    let install_name = match existing {
        Some(existing) => existing.name.clone(),
        None if credentials.iter().any(|c| c.name == *name) => format!("{name}_install"),
        None => name.clone(),
    };
    let provisional = Credential {
        name: install_name.clone(),
        external: name.clone(),
        binding: Binding::Install,
        fields: fields.iter().cloned().collect(),
        origin: Origin::default(),
    };
    let facts = read_manifest(project, external, Some(&provisional)).await?;

    // The module's declared settings (its construction arguments), sent on each call.
    for setting in facts.answer.get("settings").and_then(Js::as_array).into_iter().flatten() {
        let Some(field) = setting.get("name").and_then(Js::as_str) else { continue };
        let label = setting.get("label").and_then(Js::as_str).unwrap_or(field);
        let ask = Ask {
            secret: setting.get("secret") == Some(&Js::Bool(true)),
            optional: setting.get("optional") == Some(&Js::Bool(true)),
            default: None,
        };
        let now = current(&fields, field);
        let answer = prompter.ask(&format!("{label} (setting \"{field}\")"), Ask { default: now.as_deref(), ..ask }).await?;
        if answer.is_empty() {
            fields.retain(|(k, _)| k != field);
        } else {
            put(&mut fields, field, answer);
        }
    }

    if let Some(field) = inbound_secret_field(external, &facts.answer) {
        let generated = hex(&random_bytes(24)?);
        let default = current(&fields, &field).unwrap_or(generated);
        let question = format!("the secret {name}'s webhooks are signed with (field \"{field}\"; enter generates one)");
        let answer = prompter.ask(&question, Ask { secret: true, default: Some(&default), ..Ask::default() }).await?;
        put(&mut fields, &field, answer);
    }

    let oauth2: Vec<&Declaration> = facts.declarations.iter().filter(|d| d.oauth2().is_some()).collect();
    if !oauth2.is_empty() {
        let names: Vec<&str> = oauth2.iter().map(|d| d.name.as_str()).collect();
        prompter.print(&format!("{name} signs users in with OAuth 2 ({}): your app at the provider, once for every credential", names.join(", ")));
        let client_id = prompter.ask("your app's client id", Ask { default: current(&fields, CLIENT_ID_FIELD).as_deref(), ..Ask::default() }).await?;
        put(&mut fields, CLIENT_ID_FIELD, client_id);
        let now_secret = current(&fields, CLIENT_SECRET_FIELD);
        let secret = prompter
            .ask("your app's client secret (empty for a public client)", Ask { secret: true, optional: true, default: now_secret.as_deref() })
            .await?;
        if secret.is_empty() {
            fields.retain(|(k, _)| k != CLIENT_SECRET_FIELD);
            cleared.insert(CLIENT_SECRET_FIELD.into());
        } else {
            put(&mut fields, CLIENT_SECRET_FIELD, secret);
        }
        let registered = fields.iter().find(|(k, _)| k == REDIRECT_PORT_FIELD).map(|(_, v)| v.clone()).unwrap_or_else(|| "0".into());
        let port = prompter.ask("the loopback port your app registered for its redirect (0: any port)", Ask { default: Some(&registered), ..Ask::default() }).await?;
        let number = port.parse::<u32>().ok().filter(|p| *p <= 65535 && port.chars().all(|c| c.is_ascii_digit()));
        let Some(number) = number else { return Err(format!("the redirect port must be a number from 0 to 65535, not \"{port}\"")) };
        put(&mut fields, REDIRECT_PORT_FIELD, port.clone());
        prompter.print("register these redirect URIs with the provider:");
        if number == 0 {
            prompter.print(&format!(
                "  {}   (lf credential add; a provider that matches the port exactly needs a fixed one: lf connect {name} again)",
                loopback_redirect_uri(0).replace(":0", ":<any port>")
            ));
        } else {
            prompter.print(&format!("  {}   (lf credential add, and --headless)", loopback_redirect_uri(number as u16)));
        }
        if let Some(public) = public_url(project) {
            prompter.print(&format!("  {}   (lf credential add --public, through lf serve)", public_redirect_uri(&public)));
        }
    }

    let file = match existing.and_then(|e| e.origin.file.clone()) {
        Some(file) => file,
        None => secrets_file_for_writes(project, env)?,
    };
    let binding = existing.map(|e| e.binding.clone()).unwrap_or(Binding::Install);
    let content = entry_content(name, &binding, &fields);
    // A refresh beside this keeps its tokens: they are not an install's.
    let next = |stored: Option<Vec<(String, String)>>| -> Result<Vec<(String, String)>, String> {
        let kept: Vec<(String, String)> = stored.unwrap_or_default().into_iter().filter(|(k, _)| !cleared.contains(k)).collect();
        Ok(spread(kept, content.clone()))
    };
    change_entry(&file, &install_name, EntryChange::Replace(&next)).await?;
    prompter.print(&format!("connected {name}: its install is \"{install_name}\" in {}", file.path.display()));
    if !facts.declarations.is_empty() {
        prompter.print(&format!("next, a user credential: lf credential add --module {name} <name>"));
    }
    Ok(())
}

/// A built-in core module (crate::core): its settings asked for and written
/// to its install entry, then its setup run (a store's schema created).
async fn connect_core(project: &Project, module: &crate::core::CoreModule, prompter: &mut Prompter) -> Result<(), String> {
    let env = process_env();
    let credentials = load_secrets(project, &env)?;
    let existing = install_of(&credentials, &module.name);
    // Settings the environment supplies (a deployed lf) are not lf's to
    // write: the setup alone runs, over them.
    if let Some(existing) = existing
        && (existing.origin.file.is_none() || !existing.origin.env_fields.is_empty())
    {
        let settings = crate::core::settings_of(&credentials, module);
        for line in crate::core::set_up(project, module, &settings)? {
            prompter.print(&line);
        }
        prompter.print(&format!("{} is set up; its settings (\"{}\") come from the environment", module.name, existing.name));
        return Ok(());
    }
    let mut fields: Vec<(String, String)> = Vec::new();
    for setting in module.settings.iter() {
        let label = if setting.label.is_empty() { &setting.name } else { &setting.label };
        let now = existing.and_then(|e| e.fields.get(setting.name.as_ref())).filter(|v| !v.is_empty()).cloned();
        let answer = prompter
            .ask(&format!("{label} (setting \"{}\")", setting.name), Ask { secret: setting.secret, optional: setting.optional, default: now.as_deref() })
            .await?;
        if !answer.is_empty() {
            fields.push((setting.name.to_string(), answer));
        }
    }
    let settings = fields.iter().cloned().collect();
    for line in crate::core::set_up(project, module, &settings)? {
        prompter.print(&line);
    }
    // Nothing to keep (a module with no settings, or every one left at its
    // default) and no entry to change: the secrets file is not touched.
    if fields.is_empty() && existing.is_none() {
        prompter.print(&format!("connected {}: it has no settings to keep", module.name));
        return Ok(());
    }
    let install_name = match existing {
        Some(existing) => existing.name.clone(),
        None => core_entry_name(&module.name),
    };
    let file = match existing.and_then(|e| e.origin.file.clone()) {
        Some(file) => file,
        None => secrets_file_for_writes(project, &env)?,
    };
    let content = entry_content(&module.name, &Binding::Install, &fields);
    change_entry(&file, &install_name, EntryChange::Replace(&|_| Ok(content.clone()))).await?;
    prompter.print(&format!("connected {}: its settings are \"{install_name}\" in {}", module.name, file.path.display()));
    let filling = match module.slot {
        crate::core::Slot::Store => &project.core.store,
        crate::core::Slot::Models => &project.core.models,
        crate::core::Slot::Judge => &project.core.judge,
        crate::core::Slot::Files => &project.core.files,
    };
    if filling.name != module.name {
        prompter.print(&format!("to use it, name it in lf.yaml: core: {{ {}: \"{}\" }}", module.slot.name(), module.name));
    }
    Ok(())
}

/// The entry a core module's settings are kept under: its package name
/// without the scope (`@lf/postgres-store` → `postgres_store`), so
/// `LF_SECRET__POSTGRES_STORE__URL` reaches it.
pub fn core_entry_name(module: &str) -> String {
    external_name_of(module)
}

/// Install `reference`: a module package the project has, else a module run
/// separately at a server URL.
async fn install_external(project: &Project, reference: &str, prompter: &mut Prompter, url: Option<&str>) -> Result<External, String> {
    let as_package = url.is_none() && resolves_from(&project.root, reference);
    let url = match (as_package, url) {
        (true, _) => None,
        (false, Some(url)) => Some(url.to_string()),
        (false, None) => Some(
            prompter
                .ask(&format!("\"{reference}\" is not installed or a package here; the server URL of the separately-run module"), Ask::default())
                .await?,
        ),
    };
    if let Some(url) = &url
        && !(url.starts_with("http://") || url.starts_with("https://"))
    {
        return Err(format!("the server URL must be http(s), not \"{url}\""));
    }
    let name = external_name_of(reference);
    let dir = project.externals_dir.join(&name);
    if dir.join(EXTERNAL_MANIFEST).exists() {
        return Err(format!("{} already holds another external; connect it by its name", dir.display()));
    }
    // A path is kept absolute: the manifest is read from the external's folder.
    let module = if reference.starts_with('.') { project.root.join(reference).display().to_string() } else { reference.to_string() };
    let body = match &url {
        None => format!("name: {}\nmodule: {}\n", yaml_scalar(&name), yaml_scalar(&module)),
        Some(url) => format!("name: {}\nurl: {}\nauth:\n  kind: bearer\n  field: {SERVER_SECRET_FIELD}\n", yaml_scalar(&name), yaml_scalar(url)),
    };
    let text = format!("# Installed by `lf connect {reference}`.\n{body}");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join(EXTERNAL_MANIFEST);
    std::fs::write(&path, &text).map_err(|e| format!("{}: {e}", path.display()))?;
    let manifest: ExternalManifest = serde_yaml::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    prompter.print(&format!("installed {reference} as externals/{name}"));
    Ok(External { dir, manifest })
}

fn yaml_scalar(text: &str) -> String {
    let plain = !text.is_empty() && text.chars().all(|c| c.is_ascii_alphanumeric() || "_-./:@".contains(c)) && !text.starts_with(['@', '-', ':']);
    let reads_back = matches!(serde_yaml::from_str::<serde_yaml::Value>(text), Ok(serde_yaml::Value::String(s)) if s == text);
    if plain && reads_back { text.to_string() } else { serde_json::Value::String(text.into()).to_string() }
}

/// The external's name for a module reference: the package's own name
/// without its scope (`@acme/hubspot` → `hubspot`), or a URL's last part.
fn external_name_of(reference: &str) -> String {
    let last = reference.split('/').rfind(|part| !part.is_empty()).unwrap_or(reference);
    last.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' }).collect()
}

/// Whether Node resolves `reference` from the project (a path that exists,
/// or a package in a node_modules at or above it).
fn resolves_from(root: &Path, reference: &str) -> bool {
    if reference.starts_with('.') || reference.starts_with('/') {
        return root.join(reference).exists();
    }
    root.ancestors().any(|dir| dir.join("node_modules").join(reference).join("package.json").exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_module_reference_names_its_external() {
        assert_eq!(external_name_of("@acme/hubspot"), "hubspot");
        assert_eq!(external_name_of("@lf/google-sheets"), "google_sheets");
        assert_eq!(external_name_of("./mods/crm/"), "crm");
    }

    #[test]
    fn a_spread_keeps_places_and_appends_new_keys() {
        let pair = |k: &str, v: &str| (k.to_string(), v.to_string());
        let merged = spread(vec![pair("module", "m"), pair("access_token", "t"), pair("token", "old")], vec![pair("module", "m"), pair("token", "new"), pair("client_id", "c")]);
        assert_eq!(merged, vec![pair("module", "m"), pair("access_token", "t"), pair("token", "new"), pair("client_id", "c")]);
    }
}
