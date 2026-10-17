//! A project is a folder with `lf.yaml` at its root: the engine version it is
//! pinned to, where its movement files live, and its externals folder. `.lf/`
//! beside it holds what the host keeps (state, files, secrets).

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

// Unknown keys are ignored, so a newer lf.yaml still loads.
#[derive(Deserialize)]
struct ProjectFile {
    engine: String,
    #[serde(default = "default_movements")]
    movements: String,
    #[serde(default = "default_externals")]
    externals: String,
    #[serde(default)]
    user: UserFile,
    /// The module filling each core slot (crate::core), by slot name.
    #[serde(default)]
    core: std::collections::BTreeMap<String, String>,
    /// Superseded by `core: { store: … }`: refused with the way over.
    store: Option<serde_yaml::Value>,
    #[serde(rename = "publicUrl")]
    public_url: Option<String>,
    /// Seconds a started external has to print `listening <port>`.
    #[serde(rename = "startTimeout")]
    start_timeout: Option<f64>,
    /// The most one run may spend, in US dollars (the platform's
    /// `MOVEMENT_MAX_RUN_COST_USD`).
    #[serde(rename = "maxRunCostUsd")]
    max_run_cost_usd: Option<f64>,
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
    /// The module filling each core slot: lf.yaml's `core:`, defaults beside.
    pub core: crate::core::CoreChoice,
    /// Where lf is reached from outside (`publicUrl`), when lf.yaml names it.
    pub public_url: Option<String>,
    /// How long a started external (a module's serve-module included) has to
    /// print `listening <port>`: lf.yaml's `startTimeout`, unless
    /// `--start-timeout` names another.
    pub start_timeout: Duration,
    /// The most one run may spend on model calls and paid services, in
    /// microdollars (lf.yaml's `maxRunCostUsd`); None: no cap.
    pub cost_cap_microdollars: Option<f64>,
}

/// `maxRunCostUsd` as the platform reads `MOVEMENT_MAX_RUN_COST_USD`
/// (`parseRunCostCap`): a positive number of US dollars, to microdollars.
fn cost_cap_of(dollars: f64, at: &str) -> Result<f64, String> {
    if !(dollars.is_finite() && dollars > 0.0) {
        return Err(format!(
            "{at}: maxRunCostUsd: a positive number of US dollars, the most one run may spend on model calls and paid services (e.g. 5); leave it out for no cap"
        ));
    }
    Ok((dollars * 1_000_000.0).round())
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
    // An empty file reads as an empty mapping: every key at its default.
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
    let cost_cap_microdollars = file.max_run_cost_usd.map(|d| cost_cap_of(d, &path.display().to_string())).transpose()?;
    if file.store.is_some() {
        return Err(format!(
            "{}: store: run state is kept by the store module now: `core: {{ store: \"@lf/postgres-store\" }}` (or @lf/sqlite-store, the default), set up with `lf connect @lf/postgres-store`",
            path.display()
        ));
    }
    let externals_dir = dir.join(&file.externals);
    // The externals folder is read only when `core:` names a module lf does not build in.
    let installed = match file.core.values().all(|name| crate::core::builtin(name).is_some()) {
        true => Vec::new(),
        false => crate::externals::core_modules_in(&externals_dir)?,
    };
    let core = crate::core::CoreChoice::of(&file.core, &installed, &path.display().to_string())?;
    let language_version = language_version_of_engine(&file.engine)?;
    refuse_below_lf(language_version, &path.display().to_string(), "run `lf upgrade`")?;
    let lf_dir = dir.join(".lf");
    fs::create_dir_all(&lf_dir).map_err(|e| format!("{}: {e}", lf_dir.display()))?;
    Ok(Project {
        movements_dir: dir.join(&file.movements),
        externals_dir,
        lf_dir,
        engine: file.engine,
        language_version,
        user: (file.user.name, file.user.email),
        core,
        public_url: file.public_url,
        start_timeout,
        cost_cap_microdollars,
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
    fn the_cost_cap_is_read_as_the_platform_reads_its_setting() {
        assert_eq!(cost_cap_of(5.0, "lf.yaml"), Ok(5_000_000.0));
        assert_eq!(cost_cap_of(0.25, "lf.yaml"), Ok(250_000.0));
        assert!(cost_cap_of(0.0, "lf.yaml").unwrap_err().contains("maxRunCostUsd"));
        assert!(cost_cap_of(-1.0, "lf.yaml").is_err());
    }

    #[test]
    fn a_pin_below_version_5_is_refused_saying_what_to_do() {
        for version in 1..=4 {
            assert_eq!(
                refuse_below_lf(version, "lf.yaml", "run `lf upgrade`"),
                Err(format!("lf.yaml is pinned to language version {version}, which lf does not run (lf runs language version 5 and later): run `lf upgrade`"))
            );
        }
        assert_eq!(FIRST_LF_LANGUAGE_VERSION, 5);
        for version in [5, CURRENT_LANGUAGE_VERSION] {
            assert!(refuse_below_lf(version, "lf.yaml", "").is_ok());
        }
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
