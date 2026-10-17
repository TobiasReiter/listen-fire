//! A project is a folder with `lf.yaml` at its root: the engine version it is
//! pinned to, where its movement files live, and its externals folder. `.lf/`
//! beside it holds what the host keeps (state, files, secrets). The same file
//! format the TypeScript lf reads (apps/cli/src/project.ts), read the same way.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use movement_parser::version::{CURRENT_LANGUAGE_VERSION, since};
use serde::Deserialize;

pub const PROJECT_FILE: &str = "lf.yaml";

/// The engine version this release runs (`ENGINE_VERSION` in
/// packages/movement-engine/public/movement-engine.ts); a test holds the two equal.
pub const CURRENT_ENGINE_VERSION: &str = "0.11.0";

/// lf runs on the Rust engine alone, which runs version 5 and later;
/// versions 1–4 run only on the hosted TypeScript engine.
pub const FIRST_LF_LANGUAGE_VERSION: u32 = 5;

// Unknown keys are ignored, as the TypeScript schema strips them.
#[derive(Deserialize)]
struct ProjectFile {
    engine: String,
    #[serde(default = "default_movements")]
    movements: String,
    #[serde(default = "default_externals")]
    externals: String,
    #[serde(default)]
    user: UserFile,
    /// Where run state is kept, when not `.lf/state.db` (crate::backend::StoreSpec).
    store: Option<StoreFile>,
    #[serde(rename = "publicUrl")]
    public_url: Option<String>,
    /// Seconds a started external has to print `listening <port>`.
    #[serde(rename = "startTimeout")]
    start_timeout: Option<f64>,
}

/// lf.yaml's `store:`: a spec written out, or where to read one, so a
/// database's password never sits in the committed file.
#[derive(Deserialize)]
#[serde(untagged)]
enum StoreFile {
    Spec(String),
    Env {
        env: String,
    },
    Credential {
        credential: String,
    },
}

#[derive(Deserialize, Default)]
struct UserFile {
    name: Option<String>,
    email: Option<String>,
}

fn default_movements() -> String {
    "movements".into()
}

fn default_externals() -> String {
    "externals".into()
}

#[derive(Debug, Clone)]
#[allow(dead_code)] // `root`, `engine` and `user` are read by the run path (G2)
pub struct Project {
    pub root: PathBuf,
    /// The host's own folder: `<root>/.lf`.
    pub lf_dir: PathBuf,
    pub engine: String,
    /// The language version the pinned engine runs.
    pub language_version: u32,
    pub movements_dir: PathBuf,
    pub externals_dir: PathBuf,
    /// The local acting identity lf.yaml names.
    pub user: (Option<String>, Option<String>),
    /// lf.yaml's `store:`, unless `--store` names another.
    pub store: Option<ProjectStore>,
    /// Where lf is reached from outside (`publicUrl`), when lf.yaml names it.
    pub public_url: Option<String>,
    /// How long a started external (a module's serve-module included) has to
    /// print `listening <port>`: lf.yaml's `startTimeout`, unless
    /// `--start-timeout` names another.
    pub start_timeout: Duration,
}

/// Where lf.yaml says run state is kept.
#[derive(Debug, Clone, PartialEq)]
pub enum ProjectStore {
    /// Written out: a SQLite file, or a Postgres URL with no password in it.
    Spec(String),
    /// The environment variable that holds the spec.
    Env(String),
    /// The secrets entry whose `url` field holds the spec.
    Credential(String),
}

impl ProjectStore {
    fn of(file: StoreFile, at: &str) -> Result<ProjectStore, String> {
        let named = |name: String, key: &str| {
            if name.trim().is_empty() { Err(format!("{at}: store.{key}: a name")) } else { Ok(name) }
        };
        Ok(match file {
            StoreFile::Spec(spec) => {
                if has_inline_password(&spec) {
                    return Err(format!(
                        "{at}: store: a database URL with its password written in lf.yaml; keep the URL out of the committed file: `store: {{ env: LF_STORE_URL }}` (an environment variable) or `store: {{ credential: <name> }}` (a secrets entry with a `url` field)"
                    ));
                }
                ProjectStore::Spec(spec)
            }
            StoreFile::Env { env } => ProjectStore::Env(named(env, "env")?),
            StoreFile::Credential { credential } => ProjectStore::Credential(named(credential, "credential")?),
        })
    }
}

/// A Postgres URL carrying a password, in its userinfo or as a `password` parameter.
fn has_inline_password(spec: &str) -> bool {
    if !(spec.starts_with("postgres://") || spec.starts_with("postgresql://")) {
        return false;
    }
    match url::Url::parse(spec) {
        Ok(url) => url.password().is_some_and(|p| !p.is_empty()) || url.query_pairs().any(|(k, v)| k == "password" && !v.is_empty()),
        // Unreadable: judged by its shape, so a password is never let through.
        Err(_) => spec.split_once("://").and_then(|(_, rest)| rest.split_once('@')).is_some_and(|(userinfo, _)| userinfo.contains(':')) || spec.contains("password="),
    }
}

/// A started external's wait when lf.yaml names none: a module's first start
/// compiles its TypeScript, which can take a while on a cold cache.
pub const DEFAULT_START_TIMEOUT: Duration = Duration::from_secs(30);

/// `startTimeout` / `--start-timeout`: a positive number of seconds.
pub fn start_timeout_of(seconds: f64, from: &str) -> Result<Duration, String> {
    if !(seconds.is_finite() && seconds > 0.0) {
        return Err(format!("{from}: a positive number of seconds, e.g. 30"));
    }
    Ok(Duration::from_secs_f64(seconds))
}

/// The language version an engine version runs. Every engine this release
/// knows runs the current language version; a newer engine is refused.
pub fn language_version_of_engine(engine: &str) -> Result<u32, String> {
    if compare_semver(engine, CURRENT_ENGINE_VERSION) > 0 {
        return Err(format!(
            "lf.yaml pins engine {engine}, newer than this lf ({CURRENT_ENGINE_VERSION}); upgrade lf or lower the pin"
        ));
    }
    Ok(CURRENT_LANGUAGE_VERSION)
}

/// Refuses a pin lf does not run, before any engine sees it.
pub fn refuse_below_lf(language_version: u32, pinned: &str, remedy: &str) -> Result<(), String> {
    if since(language_version, FIRST_LF_LANGUAGE_VERSION) {
        return Ok(());
    }
    Err(format!(
        "{pinned} is pinned to language version {language_version}, which lf does not run (lf runs language version {FIRST_LF_LANGUAGE_VERSION} and later): {remedy}"
    ))
}

fn compare_semver(a: &str, b: &str) -> i64 {
    let parts = |s: &str| s.split('.').map(|p| p.parse::<i64>().unwrap_or(0)).collect::<Vec<_>>();
    let (pa, pb) = (parts(a), parts(b));
    for i in 0..3 {
        let d = pa.get(i).copied().unwrap_or(0) - pb.get(i).copied().unwrap_or(0);
        if d != 0 {
            return d;
        }
    }
    0
}

fn is_semver(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// `http://` or `https://` and a host.
fn is_http_url(text: &str) -> bool {
    let rest = text.strip_prefix("https://").or_else(|| text.strip_prefix("http://"));
    rest.is_some_and(|rest| rest.split(['/', '?', '#']).next().is_some_and(|host| !host.is_empty() && !host.contains(char::is_whitespace)))
}

/// The project whose `lf.yaml` is at `from` or the nearest folder above it.
pub fn load_project(from: &Path) -> Result<Project, String> {
    let mut dir = std::path::absolute(from).map_err(|e| format!("{}: {e}", from.display()))?;
    while !dir.join(PROJECT_FILE).exists() {
        match dir.parent() {
            Some(parent) => dir = parent.to_path_buf(),
            None => return Err(format!("no {PROJECT_FILE} here or in any folder above (run `lf init`)")),
        }
    }
    let path = dir.join(PROJECT_FILE);
    let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    // An empty file reads as an empty mapping, as the TypeScript `parse(…) ?? {}` does.
    let value: serde_yaml::Value = serde_yaml::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let value = if value.is_null() { serde_yaml::Value::Mapping(Default::default()) } else { value };
    let file: ProjectFile = serde_yaml::from_value(value).map_err(|e| format!("{}: {e}", path.display()))?;
    if !is_semver(&file.engine) {
        return Err(format!("{}: engine: a semver version, e.g. 0.11.0", path.display()));
    }
    if let Some(url) = &file.public_url
        && !is_http_url(url)
    {
        return Err(format!("{}: publicUrl: an http(s) URL, e.g. https://lf.example.com", path.display()));
    }
    let start_timeout = match file.start_timeout {
        None => DEFAULT_START_TIMEOUT,
        Some(seconds) => start_timeout_of(seconds, &format!("{}: startTimeout", path.display()))?,
    };
    let store = file.store.map(|s| ProjectStore::of(s, &path.display().to_string())).transpose()?;
    let language_version = language_version_of_engine(&file.engine)?;
    refuse_below_lf(language_version, &path.display().to_string(), "run `lf upgrade`")?;
    let lf_dir = dir.join(".lf");
    fs::create_dir_all(&lf_dir).map_err(|e| format!("{}: {e}", lf_dir.display()))?;
    Ok(Project {
        movements_dir: dir.join(&file.movements),
        externals_dir: dir.join(&file.externals),
        lf_dir,
        engine: file.engine,
        language_version,
        user: (file.user.name, file.user.email),
        store,
        public_url: file.public_url,
        start_timeout,
        root: dir,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_newer_engine_is_refused_and_an_older_one_runs_the_current_version() {
        assert!(language_version_of_engine("0.12.0").unwrap_err().contains("newer than this lf"));
        assert_eq!(language_version_of_engine("0.6.0"), Ok(CURRENT_LANGUAGE_VERSION));
    }

    #[test]
    fn a_store_url_with_a_password_is_refused_and_one_read_from_elsewhere_is_kept() {
        let of = |yaml: &str| ProjectStore::of(serde_yaml::from_str(yaml).unwrap(), "lf.yaml");
        assert!(of("postgres://lf:secret@db.example.com/lf").unwrap_err().contains("store: { env: LF_STORE_URL }"));
        assert!(of("postgresql://db.example.com/lf?user=lf&password=secret").is_err());
        assert_eq!(of("postgres://lf@db.example.com/lf?sslmode=require").unwrap(), ProjectStore::Spec("postgres://lf@db.example.com/lf?sslmode=require".into()));
        assert_eq!(of("state/other.db").unwrap(), ProjectStore::Spec("state/other.db".into()));
        assert_eq!(of("{ env: LF_STORE_URL }").unwrap(), ProjectStore::Env("LF_STORE_URL".into()));
        assert_eq!(of("{ credential: db }").unwrap(), ProjectStore::Credential("db".into()));
        assert!(of("{ env: '' }").is_err());
    }

    #[test]
    fn a_pin_below_version_5_is_refused() {
        let refused = refuse_below_lf(4, "lf.yaml", "run `lf upgrade`").unwrap_err();
        assert!(refused.contains("which lf does not run (lf runs language version 5 and later)"), "{refused}");
        assert!(refuse_below_lf(5, "lf.yaml", "").is_ok());
    }

    #[test]
    fn engine_version_is_the_engine_packages() {
        let source = include_str!("../../../packages/movement-engine/public/movement-engine.ts");
        let marker = "export const ENGINE_VERSION = '";
        let start = source.find(marker).expect("the public entry declares ENGINE_VERSION") + marker.len();
        let end = start + source[start..].find('\'').expect("ENGINE_VERSION ends");
        assert_eq!(&source[start..end], CURRENT_ENGINE_VERSION);
    }

    #[test]
    fn semver_is_three_numbers() {
        assert!(is_semver("0.11.0"));
        assert!(!is_semver("0.11"));
        assert!(!is_semver("0.11.x"));
    }
}
