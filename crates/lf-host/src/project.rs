//! A project is a folder with `lf.yaml` at its root: the engine version it is
//! pinned to, where its movement files live, and its externals folder. `.lf/`
//! beside it holds what the host keeps (state, files, secrets). The same file
//! format the TypeScript lf reads (apps/cli/src/project.ts), read the same way.

use std::fs;
use std::path::{Path, PathBuf};

use movement_parser::version::{CURRENT_LANGUAGE_VERSION, since};
use serde::Deserialize;

pub const PROJECT_FILE: &str = "lf.yaml";

/// The engine version this release runs (apps/cli's `CURRENT_ENGINE_VERSION`).
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
    fn a_pin_below_version_5_is_refused() {
        let refused = refuse_below_lf(4, "lf.yaml", "run `lf upgrade`").unwrap_err();
        assert!(refused.contains("which lf does not run (lf runs language version 5 and later)"), "{refused}");
        assert!(refuse_below_lf(5, "lf.yaml", "").is_ok());
    }

    #[test]
    fn semver_is_three_numbers() {
        assert!(is_semver("0.11.0"));
        assert!(!is_semver("0.11"));
        assert!(!is_semver("0.11.x"));
    }
}
