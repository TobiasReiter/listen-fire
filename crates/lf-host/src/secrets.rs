//! Secrets, read where the TypeScript lf reads them (apps/cli/src/secrets.ts):
//! the file (`LF_SECRETS_FILE`, else `<project>/.lf/secrets.yaml`, else
//! `~/.config/lf/secrets.yaml`; a SOPS file is read with `sops -d`), then the
//! environment field by field (`LF_SECRET__<CREDENTIAL>__<FIELD>`).
//!
//! Each credential remembers where its fields came from, so a refreshed token
//! is written back there (src/secret_stores.rs, through the secrets family of
//! src/secrets_family.rs).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;

use movement_parser::ast::{ImportSource, Statement};

use crate::project::Project;
use crate::sources::MovementFile;

pub const ENV_PREFIX: &str = "LF_SECRET__";

#[derive(Debug, Clone)]
pub struct Credential {
    pub name: String,
    pub external: String,
    /// What the entry is for (secrets.ts `CredentialBinding`).
    pub binding: Binding,
    pub fields: BTreeMap<String, String>,
    pub origin: Origin,
}

/// secrets.ts `CredentialBinding`: a hand-written `external:` entry is an
/// install and a credential in one; `module:` alone is the install (its
/// server secret signs calls); `module:` + `credential:` is a user credential
/// for that declared credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Binding {
    Legacy,
    Install,
    Credential(String),
}

/// Where a credential's fields came from (secrets.ts `CredentialOrigin`).
#[derive(Debug, Clone, Default)]
pub struct Origin {
    /// The secrets file it was read from; absent for one made wholly from the environment.
    pub file: Option<SecretsFile>,
    /// The fields whose value the environment supplied.
    pub env_fields: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretsFile {
    pub path: PathBuf,
    pub encrypted: bool,
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
        let (content, encrypted) = read_secrets_file(path)?;
        let file = SecretsFile { path: path.clone(), encrypted };
        for (name, raw) in content {
            if name == "sops" {
                continue;
            }
            let (external, binding, fields) = parse_entry(raw).map_err(|why| format!("{}: entry \"{name}\" {why}", path.display()))?;
            credentials.push(Credential { name, external, binding, fields, origin: Origin { file: Some(file.clone()), env_fields: BTreeSet::new() } });
        }
    }
    apply_environment(&mut credentials, env)?;
    Ok(credentials)
}

/// One entry: the external it belongs to (`module:`, written by `lf connect` /
/// `lf credential`, or a hand-written `external:`) and its fields. A user
/// credential's `credential:` names the declared credential it binds; it is
/// not a field.
pub fn parse_entry(raw: serde_yaml::Value) -> Result<(String, Binding, BTreeMap<String, String>), String> {
    let shape = || "needs `module` (or a hand-written `external`) and string fields".to_string();
    let serde_yaml::Value::Mapping(entry) = raw else { return Err(shape()) };
    let (mut external, mut module, mut credential) = (None, None, None);
    let mut fields = BTreeMap::new();
    for (key, value) in entry {
        let (serde_yaml::Value::String(key), serde_yaml::Value::String(value)) = (key, value) else { return Err(shape()) };
        match key.as_str() {
            "external" => external = Some(value),
            "module" => module = Some(value),
            "credential" => credential = Some(value),
            _ => {
                fields.insert(key, value);
            }
        }
    }
    let (owner, binding) = match (external, module, credential) {
        (Some(_), Some(_), _) | (Some(_), None, Some(_)) => return Err("names both `external` and `module`/`credential`; keep one".into()),
        (Some(owner), None, None) => (owner, Binding::Legacy),
        (None, Some(owner), None) => (owner, Binding::Install),
        (None, Some(owner), Some(declared)) => (owner, Binding::Credential(declared)),
        (None, None, Some(_)) => return Err("names a `credential` but no `module`".into()),
        (None, None, None) => return Err(shape()),
    };
    if owner.is_empty() {
        return Err(shape());
    }
    Ok((owner, binding, fields))
}

/// A secrets file's entries, decrypted with `sops -d` when it carries SOPS
/// metadata, and whether it did.
pub fn read_secrets_file(path: &Path) -> Result<(Vec<(String, serde_yaml::Value)>, bool), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let parsed = mapping_of(&text).map_err(|_| format!("{}: expected a mapping of credential names", path.display()))?;
    if !parsed.iter().any(|(k, _)| k == "sops") {
        return Ok((parsed, false));
    }
    let decrypted = Command::new("sops").arg("-d").arg(path).output().map_err(|e| {
        format!("{} is encrypted with SOPS, and `sops` could not be run ({e}); install sops", path.display())
    })?;
    if !decrypted.status.success() {
        return Err(format!("sops -d {} failed: {}", path.display(), String::from_utf8_lossy(&decrypted.stderr).trim()));
    }
    let plain = mapping_of(&String::from_utf8_lossy(&decrypted.stdout)).map_err(|_| format!("{}: decrypted secrets are not a mapping", path.display()))?;
    Ok((plain, true))
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

pub fn apply_environment(credentials: &mut Credentials, env: &[(String, String)]) -> Result<(), String> {
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
                credentials.push(Credential {
                    name: credential_name.into(),
                    external: String::new(),
                    binding: Binding::Legacy,
                    fields: BTreeMap::new(),
                    origin: Origin::default(),
                });
                credentials.len() - 1
            }
        };
        let credential = &mut credentials[at];
        if field == "external" {
            credential.external = value.clone();
        } else {
            let existing = credential.fields.keys().find(|f| f.to_lowercase() == field).cloned().unwrap_or_else(|| field.into());
            credential.fields.insert(existing.clone(), value.clone());
            credential.origin.env_fields.insert(existing);
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

/// The install of `external` (secrets.ts `installOf`): its `module:`-only
/// entry, else the first hand-written one, else the first.
pub fn install_of<'a>(credentials: &'a Credentials, external: &str) -> Option<&'a Credential> {
    let all: Vec<&Credential> = credentials.iter().filter(|c| c.external == external).collect();
    all.iter().find(|c| c.binding == Binding::Install).or_else(|| all.iter().find(|c| c.binding == Binding::Legacy)).or(all.first()).copied()
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
    use super::{Binding, parse_entry};

    type Entry = (String, Binding, Vec<(String, String)>);

    fn entry(yaml: &str) -> Result<Entry, String> {
        parse_entry(serde_yaml::from_str(yaml).unwrap()).map(|(owner, binding, fields)| (owner, binding, fields.into_iter().collect()))
    }

    #[test]
    fn entries_written_by_the_commands_and_by_hand_both_read() {
        let pair = |k: &str, v: &str| (k.to_string(), v.to_string());
        assert_eq!(entry("module: hubspot\nclient_id: app\n"), Ok(("hubspot".into(), Binding::Install, vec![pair("client_id", "app")])));
        assert_eq!(
            entry("module: hubspot\ncredential: oauth\naccess_token: t\n"),
            Ok(("hubspot".into(), Binding::Credential("oauth".into()), vec![pair("access_token", "t")]))
        );
        assert_eq!(entry("external: acme_crm\ntoken: x\n"), Ok(("acme_crm".into(), Binding::Legacy, vec![pair("token", "x")])));
        assert!(entry("external: a\nmodule: b\n").unwrap_err().contains("both"));
        assert!(entry("credential: c\ntoken: x\n").is_err());
    }
}
