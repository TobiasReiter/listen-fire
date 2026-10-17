//! Secrets, read where the TypeScript lf reads them (apps/cli/src/secrets.ts):
//! the file (`LF_SECRETS_FILE`, else `<project>/.lf/secrets.yaml`, else
//! `~/.config/lf/secrets.yaml`; a SOPS file is read with `sops -d`), then the
//! environment field by field (`LF_SECRET__<CREDENTIAL>__<FIELD>`).
//!
//! THIN (G0): read only. OAuth refresh and write-back are G4's; a credential
//! that would need a refresh before its call is refused rather than sent stale.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use movement_parser::ast::{ImportSource, Statement};

use crate::project::Project;
use crate::sources::MovementFile;

const ENV_PREFIX: &str = "LF_SECRET__";
const REFRESH_WINDOW_MS: i64 = 30_000;

#[derive(Debug, Clone)]
pub struct Credential {
    pub name: String,
    pub external: String,
    pub fields: BTreeMap<String, String>,
}

/// The credentials, in the order the file and then the environment name them.
pub type Credentials = Vec<Credential>;

pub fn secrets_paths(project: &Project, env: &[(String, String)]) -> Vec<PathBuf> {
    if let Some(named) = env_var(env, "LF_SECRETS_FILE").filter(|v| !v.is_empty()) {
        return vec![PathBuf::from(named)];
    }
    let home = env_var(env, "HOME").unwrap_or_default();
    vec![project.lf_dir.join("secrets.yaml"), Path::new(&home).join(".config").join("lf").join("secrets.yaml")]
}

fn env_var<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
    env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

pub fn load_secrets(project: &Project, env: &[(String, String)]) -> Result<Credentials, String> {
    let paths = secrets_paths(project, env);
    let path = paths.iter().find(|p| p.exists());
    let named = env_var(env, "LF_SECRETS_FILE").filter(|v| !v.is_empty());
    if path.is_none()
        && let Some(named) = named
    {
        return Err(format!("LF_SECRETS_FILE points at {named}, which does not exist"));
    }
    let mut credentials: Credentials = Vec::new();
    if let Some(path) = path {
        for (name, raw) in read_secrets_file(path)? {
            if name == "sops" {
                continue;
            }
            let (external, fields) = parse_entry(raw).map_err(|why| format!("{}: entry \"{name}\" {why}", path.display()))?;
            credentials.push(Credential { name, external, fields });
        }
    }
    apply_environment(&mut credentials, env)?;
    Ok(credentials)
}

/// One entry: the external it belongs to (`module:`, written by `lf connect` /
/// `lf credential`, or a hand-written `external:`) and its fields. A user
/// credential's `credential:` names the declared credential it binds; it is
/// not a field.
fn parse_entry(raw: serde_yaml::Value) -> Result<(String, BTreeMap<String, String>), String> {
    let shape = || "needs `module` (or a hand-written `external`) and string fields".to_string();
    let serde_yaml::Value::Mapping(entry) = raw else { return Err(shape()) };
    let (mut external, mut module) = (None, None);
    let mut fields = BTreeMap::new();
    for (key, value) in entry {
        let (serde_yaml::Value::String(key), serde_yaml::Value::String(value)) = (key, value) else { return Err(shape()) };
        match key.as_str() {
            "external" => external = Some(value),
            "module" => module = Some(value),
            "credential" => {}
            _ => {
                fields.insert(key, value);
            }
        }
    }
    let owner = match (external, module) {
        (Some(_), Some(_)) => return Err("names both `external` and `module`; keep one".into()),
        (Some(owner), None) | (None, Some(owner)) => owner,
        (None, None) => return Err(shape()),
    };
    if owner.is_empty() {
        return Err(shape());
    }
    Ok((owner, fields))
}

fn read_secrets_file(path: &Path) -> Result<Vec<(String, serde_yaml::Value)>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let parsed = mapping_of(&text).map_err(|_| format!("{}: expected a mapping of credential names", path.display()))?;
    if !parsed.iter().any(|(k, _)| k == "sops") {
        return Ok(parsed);
    }
    let decrypted = Command::new("sops").arg("-d").arg(path).output().map_err(|e| {
        format!("{} is encrypted with SOPS, and `sops` could not be run ({e}); install sops", path.display())
    })?;
    if !decrypted.status.success() {
        return Err(format!("sops -d {} failed: {}", path.display(), String::from_utf8_lossy(&decrypted.stderr).trim()));
    }
    mapping_of(&String::from_utf8_lossy(&decrypted.stdout)).map_err(|_| format!("{}: decrypted secrets are not a mapping", path.display()))
}

/// A YAML document as a mapping keyed by strings; an empty one is empty.
fn mapping_of(text: &str) -> Result<Vec<(String, serde_yaml::Value)>, ()> {
    match serde_yaml::from_str::<serde_yaml::Value>(text).map_err(|_| ())? {
        serde_yaml::Value::Null => Ok(Vec::new()),
        serde_yaml::Value::Mapping(map) => map
            .into_iter()
            .map(|(k, v)| match k {
                serde_yaml::Value::String(k) => Ok((k, v)),
                _ => Err(()),
            })
            .collect(),
        _ => Err(()),
    }
}

fn apply_environment(credentials: &mut Credentials, env: &[(String, String)]) -> Result<(), String> {
    for (key, value) in env {
        let Some(rest) = key.strip_prefix(ENV_PREFIX) else { continue };
        let lowered = rest.to_lowercase();
        let parts: Vec<&str> = lowered.split("__").collect();
        let [credential_name, field] = parts[..] else {
            return Err(format!("{key}: expected LF_SECRET__<CREDENTIAL>__<FIELD> (double underscores between the parts)"));
        };
        if credential_name.is_empty() || field.is_empty() {
            return Err(format!("{key}: expected LF_SECRET__<CREDENTIAL>__<FIELD> (double underscores between the parts)"));
        }
        let at = match credentials.iter().position(|c| c.name.to_lowercase() == credential_name) {
            Some(at) => at,
            None => {
                credentials.push(Credential { name: credential_name.into(), external: String::new(), fields: BTreeMap::new() });
                credentials.len() - 1
            }
        };
        let credential = &mut credentials[at];
        if field == "external" {
            credential.external = value.clone();
        } else {
            let existing = credential.fields.keys().find(|f| f.to_lowercase() == field).cloned().unwrap_or_else(|| field.into());
            credential.fields.insert(existing, value.clone());
        }
    }
    for credential in credentials.iter() {
        if credential.external.is_empty() {
            return Err(format!(
                "credential \"{}\" comes from the environment but {ENV_PREFIX}{}__EXTERNAL is not set",
                credential.name,
                credential.name.to_uppercase()
            ));
        }
    }
    Ok(())
}

/// The first credential the secrets name for this external.
pub fn credential_for<'a>(credentials: &'a Credentials, external: &str) -> Option<&'a Credential> {
    credentials.iter().find(|c| c.external == external)
}

/// Refused until G4 ports the refresh: a credential the TypeScript lf would
/// refresh before this call.
pub fn refuse_stale(credential: &Credential, now_ms: i64) -> Result<(), String> {
    let refreshable = credential.fields.contains_key("refresh_token") && credential.fields.contains_key("token_url");
    let Some(at) = credential.fields.get("expires_at").filter(|_| refreshable) else { return Ok(()) };
    let expires_soon = match jiff::Timestamp::strptime("%Y-%m-%dT%H:%M:%S%.fZ", at).or_else(|_| at.parse::<jiff::Timestamp>()) {
        Ok(t) => t.as_millisecond() - now_ms <= REFRESH_WINDOW_MS,
        Err(_) => true,
    };
    if expires_soon {
        return Err(format!(
            "credential \"{}\" needs an OAuth refresh, which lf-host does not do yet; refresh it with the TypeScript lf",
            credential.name
        ));
    }
    Ok(())
}

pub struct MissingCredential {
    pub file: PathBuf,
    pub line: usize,
    pub column: usize,
    pub message: String,
}

/// Every credential the project's programs import, that the secrets do not hold.
pub fn missing_credentials(
    project: &Project,
    files: &[MovementFile],
    credentials: &Credentials,
    env: &[(String, String)],
) -> Vec<MissingCredential> {
    let mut missing = Vec::new();
    for file in files {
        // `lf check` reports a file that does not parse.
        let Ok(program) = crate::check::parse(&file.source, project.language_version) else { continue };
        for statement in &program.statements {
            let Statement::Import(import) = statement else { continue };
            if !matches!(&import.source, ImportSource::Builtin { namespace } if namespace == "credentials") {
                continue;
            }
            for imported in &import.names {
                if credentials.iter().any(|c| c.name == imported.name) {
                    continue;
                }
                let where_ = secrets_paths(project, env).iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ");
                let upper = imported.name.to_uppercase();
                missing.push(MissingCredential {
                    file: file.path.clone(),
                    line: import.span.start.line,
                    column: import.span.start.col,
                    message: format!(
                        "credential \"{}\" is imported here but not configured. Looked in: {where_}; environment {ENV_PREFIX}{upper}__EXTERNAL and {ENV_PREFIX}{upper}__<FIELD>",
                        imported.name
                    ),
                });
            }
        }
    }
    missing
}

#[cfg(test)]
mod tests {
    use super::parse_entry;

    fn entry(yaml: &str) -> Result<(String, Vec<(String, String)>), String> {
        parse_entry(serde_yaml::from_str(yaml).unwrap()).map(|(owner, fields)| (owner, fields.into_iter().collect()))
    }

    #[test]
    fn entries_written_by_the_commands_and_by_hand_both_read() {
        let pair = |k: &str, v: &str| (k.to_string(), v.to_string());
        assert_eq!(entry("module: hubspot\nclient_id: app\n"), Ok(("hubspot".into(), vec![pair("client_id", "app")])));
        assert_eq!(
            entry("module: hubspot\ncredential: hubspot\naccess_token: t\n"),
            Ok(("hubspot".into(), vec![pair("access_token", "t")]))
        );
        assert_eq!(entry("external: acme_crm\ntoken: x\n"), Ok(("acme_crm".into(), vec![pair("token", "x")])));
        assert!(entry("external: a\nmodule: b\n").unwrap_err().contains("both"));
        assert!(entry("credential: c\ntoken: x\n").is_err());
    }
}
