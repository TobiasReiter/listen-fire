//! Core services as modules filling slots (plans/cloud-native-2026-10-06/
//! 22_everywhere_plan.md, Henry 2026-10-17). The engine and the run host's
//! rules stay fixed; what they lean on — the models a call reaches, the judge
//! that settles a fuzzy identity match, the store run state lives in, where
//! files are kept — is a module of a kind (its slot), named per slot by
//! lf.yaml's `core:` and configured as every module is: `lf connect <module>`
//! writes its settings to its install entry in the secrets file, and runs its
//! setup (the Postgres store creates and migrates its own schema there).
//!
//! lf's built-ins run in process. A slot's contract is its family's
//! contract suite (the run host's store cases, …). A third-party module
//! fills the store slot as a process: a folder in the externals folder whose
//! lf-external.yaml says `kind: core`, `slot: store` and its `command`,
//! driven over the store wire (docs/contracts/store-slot.md,
//! crate::store_module). The other slots take only a built-in: their
//! families are lf's own code paths (a model call's streaming and pricing,
//! the judge's question, the file folder), with no wire to drive a process
//! over yet.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::project::Project;
use crate::secrets::{Credentials, install_of};

/// A kind of core service a module can fill (protocol.ts `CORE_SLOTS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    Models,
    Judge,
    Store,
    Files,
}

impl Slot {
    pub const ALL: [Slot; 4] = [Slot::Models, Slot::Judge, Slot::Store, Slot::Files];

    pub fn name(self) -> &'static str {
        match self {
            Slot::Models => "models",
            Slot::Judge => "judge",
            Slot::Store => "store",
            Slot::Files => "files",
        }
    }

    pub fn of(name: &str) -> Option<Slot> {
        Slot::ALL.into_iter().find(|s| s.name() == name)
    }

    /// The module a project gets when lf.yaml names none for the slot.
    pub fn default_module(self) -> &'static CoreModule {
        let name = match self {
            Slot::Models => ANTHROPIC,
            Slot::Judge => JUDGE,
            Slot::Store => SQLITE_STORE,
            Slot::Files => LOCAL_FILES,
        };
        builtin(name).expect("every slot's default is a built-in")
    }
}

/// One construction argument a module declares (protocol.ts `WireModuleSetting`):
/// prompted by `lf connect`, kept on the module's install entry.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct Setting {
    pub name: Cow<'static, str>,
    #[serde(default)]
    pub label: Cow<'static, str>,
    #[serde(default)]
    pub secret: bool,
    #[serde(default)]
    pub optional: bool,
}

const fn setting(name: &'static str, label: &'static str, secret: bool, optional: bool) -> Setting {
    Setting { name: Cow::Borrowed(name), label: Cow::Borrowed(label), secret, optional }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CoreModule {
    pub name: Cow<'static, str>,
    pub slot: Slot,
    pub settings: Cow<'static, [Setting]>,
    /// None: built into lf. Some: a third-party module lf starts.
    pub process: Option<ProcessModule>,
}

/// A core module run as a process (an externals folder whose
/// lf-external.yaml says `kind: core`): started in its folder, spoken to
/// over its stdin and stdout.
#[derive(Debug, Clone, PartialEq)]
pub struct ProcessModule {
    pub dir: PathBuf,
    pub command: Vec<String>,
    pub env: BTreeMap<String, String>,
}

const fn built_in(name: &'static str, slot: Slot, settings: &'static [Setting]) -> CoreModule {
    CoreModule { name: Cow::Borrowed(name), slot, settings: Cow::Borrowed(settings), process: None }
}

pub const ANTHROPIC: &str = "@lf/anthropic";
pub const JUDGE: &str = "@lf/judge";
pub const SQLITE_STORE: &str = "@lf/sqlite-store";
pub const POSTGRES_STORE: &str = "@lf/postgres-store";
pub const LOCAL_FILES: &str = "@lf/local-files";

const ANTHROPIC_SETTINGS: &[Setting] = &[
    setting("api_key", "your Anthropic API key", true, false),
    setting("base_url", "another endpoint speaking the Messages API (empty: Anthropic's)", false, true),
];
const SQLITE_SETTINGS: &[Setting] = &[setting("path", "the state file, from the project folder (empty: .lf/state.db)", false, true)];
const POSTGRES_SETTINGS: &[Setting] = &[setting("url", "the database URL (postgres://…; add ?sslmode=verify-full for verified TLS)", true, false)];

pub const BUILTIN: &[CoreModule] = &[
    built_in(ANTHROPIC, Slot::Models, ANTHROPIC_SETTINGS),
    // Declines every question today: an ambiguous match creates a new record.
    built_in(JUDGE, Slot::Judge, &[]),
    built_in(SQLITE_STORE, Slot::Store, SQLITE_SETTINGS),
    built_in(POSTGRES_STORE, Slot::Store, POSTGRES_SETTINGS),
    built_in(LOCAL_FILES, Slot::Files, &[]),
];

pub fn builtin(name: &str) -> Option<&'static CoreModule> {
    BUILTIN.iter().find(|m| m.name == name)
}

/// The module filling each slot for one project.
#[derive(Debug, Clone)]
pub struct CoreChoice {
    pub models: CoreModule,
    pub judge: CoreModule,
    pub store: CoreModule,
    pub files: CoreModule,
}

impl Default for CoreChoice {
    fn default() -> Self {
        CoreChoice {
            models: Slot::Models.default_module().clone(),
            judge: Slot::Judge.default_module().clone(),
            store: Slot::Store.default_module().clone(),
            files: Slot::Files.default_module().clone(),
        }
    }
}

impl CoreChoice {
    /// lf.yaml's `core:` (slot → module), every slot it leaves out at its
    /// default. A module that is not built in is one of `installed`, the
    /// project's core modules run as processes.
    pub fn of(named: &BTreeMap<String, String>, installed: &[CoreModule], at: &str) -> Result<CoreChoice, String> {
        let mut choice = CoreChoice::default();
        for (slot_name, module_name) in named {
            let Some(slot) = Slot::of(slot_name) else {
                let slots: Vec<&str> = Slot::ALL.iter().map(|s| s.name()).collect();
                return Err(format!("{at}: core.{slot_name}: not a core slot (the slots: {})", slots.join(", ")));
            };
            let found = builtin(module_name).or_else(|| installed.iter().find(|m| m.name == *module_name));
            let module = match found {
                Some(module) if module.slot != slot => {
                    return Err(format!("{at}: core.{slot_name}: {module_name} fills the {} slot, not {slot_name}", module.slot.name()));
                }
                Some(module) if module.process.is_some() && slot != Slot::Store => {
                    return Err(format!(
                        "{at}: core.{slot_name}: {module_name} is a core module run as a process; lf fills only the store slot with one, and the {slot_name} slot takes a built-in ({})",
                        builtin_names(slot)
                    ));
                }
                Some(module) => module.clone(),
                None => {
                    return Err(format!(
                        "{at}: core.{slot_name}: {module_name} is neither one of lf's built-in {slot_name} modules ({}) nor a folder in the externals folder whose lf-external.yaml says `kind: core` and `name: {module_name}`",
                        builtin_names(slot)
                    ));
                }
            };
            match slot {
                Slot::Models => choice.models = module,
                Slot::Judge => choice.judge = module,
                Slot::Store => choice.store = module,
                Slot::Files => choice.files = module,
            }
        }
        Ok(choice)
    }
}

fn builtin_names(slot: Slot) -> String {
    BUILTIN.iter().filter(|m| m.slot == slot).map(|m| m.name.as_ref()).collect::<Vec<_>>().join(", ")
}

/// A core module's settings as its install entry holds them (`lf connect`
/// writes it; `LF_SECRET__<ENTRY>__<FIELD>` supplies or overrides fields).
pub fn settings_of(credentials: &Credentials, module: &CoreModule) -> BTreeMap<String, String> {
    install_of(credentials, &module.name).map(|c| c.fields.iter().filter(|(_, v)| !v.is_empty()).map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default()
}

/// A required setting, or what to run to give it one.
pub fn required<'a>(settings: &'a BTreeMap<String, String>, module: &CoreModule, field: &str) -> Result<&'a str, String> {
    settings.get(field).map(String::as_str).ok_or_else(|| {
        format!(
            "{} has no `{field}` setting: run `lf connect {}` (or set LF_SECRET__<ENTRY>__{} on an entry whose module is {})",
            module.name,
            module.name,
            field.to_uppercase(),
            module.name
        )
    })
}

/// A module's setup, run by `lf connect` once its settings are written: what
/// it did, line by line.
pub fn set_up(project: &Project, module: &CoreModule, settings: &BTreeMap<String, String>) -> Result<Vec<String>, String> {
    if let Some(process) = &module.process {
        // A store module sets itself up when it is opened.
        let opened = crate::store_module::ProcessStore::start(&module.name, process, settings).map_err(|e| e.to_string())?;
        return Ok(vec![format!("{} answered as a store (its tenant: {})", module.name, crate::backend::RunHostStore::tenant(&opened))]);
    }
    match module.name.as_ref() {
        POSTGRES_STORE => {
            let url = required(settings, module, "url")?;
            let applied = crate::pg_store::PgStore::migrate(url).map_err(|e| e.to_string())?;
            Ok(vec![if applied.is_empty() {
                "the lf schema is up to date".to_string()
            } else {
                format!("created the lf schema (migrations {})", applied.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(", "))
            }])
        }
        SQLITE_STORE => {
            let path = sqlite_path(project, settings)?;
            crate::store::Store::open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            Ok(vec![format!("the state file is {}", path.display())])
        }
        _ => Ok(Vec::new()),
    }
}

/// The SQLite store's state file: its `path` setting from the project
/// folder, else `.lf/state.db`.
pub fn sqlite_path(project: &Project, settings: &BTreeMap<String, String>) -> Result<std::path::PathBuf, String> {
    state_file_at(&project.root, &project.lf_dir, settings.get("path").map(String::as_str))
}

/// A `path` setting that names no file lf could keep its state in is
/// refused when it is read, not met later as a SQLite error.
fn state_file_at(root: &std::path::Path, lf_dir: &std::path::Path, setting: Option<&str>) -> Result<std::path::PathBuf, String> {
    let Some(setting) = setting else { return Ok(lf_dir.join("state.db")) };
    let refuse = |why: &str| {
        Err(format!("{SQLITE_STORE}'s `path` setting \"{setting}\" {why}: run `lf connect {SQLITE_STORE}` to set it again (empty for .lf/state.db)"))
    };
    if setting.contains("://") {
        return refuse("is a URL, not a file (a Postgres database is @lf/postgres-store's)");
    }
    let path = root.join(setting);
    if path.is_dir() {
        return refuse("is a folder; name the state file inside it");
    }
    if path.parent().is_some_and(|parent| !parent.as_os_str().is_empty() && !parent.is_dir()) {
        return refuse("is in a folder that does not exist");
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn every_slot_has_a_built_in_default() {
        let choice = CoreChoice::of(&BTreeMap::new(), &[], "lf.yaml").unwrap();
        assert_eq!([choice.models.name, choice.judge.name, choice.store.name, choice.files.name], [ANTHROPIC, JUDGE, SQLITE_STORE, LOCAL_FILES]);
    }

    #[test]
    fn the_sqlite_stores_path_names_a_file_in_a_folder_that_exists() {
        let root = std::env::temp_dir().join(format!("lf-core-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("state")).unwrap();
        let lf_dir = root.join(".lf");
        assert_eq!(state_file_at(&root, &lf_dir, None), Ok(lf_dir.join("state.db")));
        assert_eq!(state_file_at(&root, &lf_dir, Some("state/run.db")), Ok(root.join("state/run.db")));
        assert!(state_file_at(&root, &lf_dir, Some("state")).unwrap_err().contains("is a folder"));
        assert!(state_file_at(&root, &lf_dir, Some("nowhere/run.db")).unwrap_err().contains("a folder that does not exist"));
        assert!(state_file_at(&root, &lf_dir, Some("postgres://db/lf")).unwrap_err().contains("is a URL"));
    }

    #[test]
    fn a_slot_takes_only_a_module_of_its_kind() {
        assert_eq!(CoreChoice::of(&named(&[("store", POSTGRES_STORE)]), &[], "lf.yaml").unwrap().store.name, POSTGRES_STORE);
        assert!(CoreChoice::of(&named(&[("store", ANTHROPIC)]), &[], "lf.yaml").unwrap_err().contains("fills the models slot"));
        assert!(CoreChoice::of(&named(&[("ocr", ANTHROPIC)]), &[], "lf.yaml").unwrap_err().contains("not a core slot"));
        assert!(CoreChoice::of(&named(&[("models", "@acme/llm")]), &[], "lf.yaml").unwrap_err().contains("kind: core"));
    }

    fn process_module(name: &str, slot: Slot) -> CoreModule {
        let process = ProcessModule { dir: PathBuf::from("/p/externals/x"), command: vec!["./store".into()], env: BTreeMap::new() };
        CoreModule { name: Cow::Owned(name.into()), slot, settings: Cow::Owned(Vec::new()), process: Some(process) }
    }

    #[test]
    fn a_process_module_fills_the_store_slot_and_only_it() {
        let installed = [process_module("acme_store", Slot::Store), process_module("acme_llm", Slot::Models)];
        let choice = CoreChoice::of(&named(&[("store", "acme_store")]), &installed, "lf.yaml").unwrap();
        assert_eq!(choice.store, installed[0]);
        assert!(CoreChoice::of(&named(&[("models", "acme_llm")]), &installed, "lf.yaml").unwrap_err().contains("only the store slot"));
        assert!(CoreChoice::of(&named(&[("models", "acme_store")]), &installed, "lf.yaml").unwrap_err().contains("fills the store slot"));
    }
}
