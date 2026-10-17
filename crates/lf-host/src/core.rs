//! Core services as modules filling slots (plans/cloud-native-2026-10-06/
//! 22_everywhere_plan.md, Henry 2026-10-17). The engine and the run host's
//! rules stay fixed; what they lean on — the models a call reaches, the judge
//! that settles a fuzzy identity match, the store run state lives in, where
//! files are kept — is a module of a kind (its slot), named per slot by
//! lf.yaml's `core:` and configured as every module is: `lf connect <module>`
//! writes its settings to its install entry in the secrets file, and runs its
//! setup (the Postgres store creates and migrates its own schema there).
//!
//! The modules here are lf's built-ins and run in process. A slot's contract
//! is its family's contract suite (the run host's store cases, …); a
//! third-party core module would run as a process over the adapter protocol
//! (its manifest's `kind: core` and `slot`), which lf does not load yet.

use std::collections::BTreeMap;

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

    fn of(name: &str) -> Option<Slot> {
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
#[derive(Debug)]
pub struct Setting {
    pub name: &'static str,
    pub label: &'static str,
    pub secret: bool,
    pub optional: bool,
}

#[derive(Debug)]
pub struct CoreModule {
    pub name: &'static str,
    pub slot: Slot,
    pub settings: &'static [Setting],
}

pub const ANTHROPIC: &str = "@lf/anthropic";
pub const JUDGE: &str = "@lf/judge";
pub const SQLITE_STORE: &str = "@lf/sqlite-store";
pub const POSTGRES_STORE: &str = "@lf/postgres-store";
pub const LOCAL_FILES: &str = "@lf/local-files";

pub const BUILTIN: &[CoreModule] = &[
    CoreModule {
        name: ANTHROPIC,
        slot: Slot::Models,
        settings: &[
            Setting { name: "api_key", label: "your Anthropic API key", secret: true, optional: false },
            Setting { name: "base_url", label: "another endpoint speaking the Messages API (empty: Anthropic's)", secret: false, optional: true },
        ],
    },
    // Declines every question today: an ambiguous match creates a new record.
    CoreModule { name: JUDGE, slot: Slot::Judge, settings: &[] },
    CoreModule {
        name: SQLITE_STORE,
        slot: Slot::Store,
        settings: &[Setting { name: "path", label: "the state file, from the project folder (empty: .lf/state.db)", secret: false, optional: true }],
    },
    CoreModule {
        name: POSTGRES_STORE,
        slot: Slot::Store,
        settings: &[Setting {
            name: "url",
            label: "the database URL (postgres://…; add ?sslmode=verify-full for verified TLS)",
            secret: true,
            optional: false,
        }],
    },
    CoreModule { name: LOCAL_FILES, slot: Slot::Files, settings: &[] },
];

pub fn builtin(name: &str) -> Option<&'static CoreModule> {
    BUILTIN.iter().find(|m| m.name == name)
}

/// The module filling each slot for one project.
#[derive(Debug, Clone, Copy)]
pub struct CoreChoice {
    pub models: &'static CoreModule,
    pub judge: &'static CoreModule,
    pub store: &'static CoreModule,
    pub files: &'static CoreModule,
}

impl Default for CoreChoice {
    fn default() -> Self {
        CoreChoice {
            models: Slot::Models.default_module(),
            judge: Slot::Judge.default_module(),
            store: Slot::Store.default_module(),
            files: Slot::Files.default_module(),
        }
    }
}

impl CoreChoice {
    /// lf.yaml's `core:` (slot → module), every slot it leaves out at its default.
    pub fn of(named: &BTreeMap<String, String>, at: &str) -> Result<CoreChoice, String> {
        let mut choice = CoreChoice::default();
        for (slot_name, module_name) in named {
            let Some(slot) = Slot::of(slot_name) else {
                let slots: Vec<&str> = Slot::ALL.iter().map(|s| s.name()).collect();
                return Err(format!("{at}: core.{slot_name}: not a core slot (the slots: {})", slots.join(", ")));
            };
            let module = match builtin(module_name) {
                Some(module) if module.slot == slot => module,
                Some(module) => return Err(format!("{at}: core.{slot_name}: {module_name} fills the {} slot, not {slot_name}", module.slot.name())),
                None => {
                    let fits: Vec<&str> = BUILTIN.iter().filter(|m| m.slot == slot).map(|m| m.name).collect();
                    return Err(format!(
                        "{at}: core.{slot_name}: {module_name} is not one of lf's built-in {slot_name} modules ({}); a core module run as a separate process is not supported by lf yet",
                        fits.join(", ")
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

/// A core module's settings as its install entry holds them (`lf connect`
/// writes it; `LF_SECRET__<ENTRY>__<FIELD>` supplies or overrides fields).
/// The models module also reads the entry named `anthropic`, where the
/// TypeScript lf keeps the provider key.
pub fn settings_of(credentials: &Credentials, module: &CoreModule) -> BTreeMap<String, String> {
    let entry = install_of(credentials, module.name).or_else(|| match module.name {
        ANTHROPIC => credentials.iter().find(|c| c.name == crate::models::MODEL_CREDENTIAL),
        _ => None,
    });
    entry.map(|c| c.fields.iter().filter(|(_, v)| !v.is_empty()).map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default()
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
    match module.name {
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
            let path = sqlite_path(project, settings);
            crate::store::Store::open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            Ok(vec![format!("the state file is {}", path.display())])
        }
        _ => Ok(Vec::new()),
    }
}

pub fn sqlite_path(project: &Project, settings: &BTreeMap<String, String>) -> std::path::PathBuf {
    match settings.get("path") {
        Some(path) => project.root.join(path),
        None => project.lf_dir.join("state.db"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn every_slot_has_a_built_in_default() {
        let choice = CoreChoice::of(&BTreeMap::new(), "lf.yaml").unwrap();
        assert_eq!([choice.models.name, choice.judge.name, choice.store.name, choice.files.name], [ANTHROPIC, JUDGE, SQLITE_STORE, LOCAL_FILES]);
    }

    #[test]
    fn a_slot_takes_only_a_module_of_its_kind() {
        assert_eq!(CoreChoice::of(&named(&[("store", POSTGRES_STORE)]), "lf.yaml").unwrap().store.name, POSTGRES_STORE);
        assert!(CoreChoice::of(&named(&[("store", ANTHROPIC)]), "lf.yaml").unwrap_err().contains("fills the models slot"));
        assert!(CoreChoice::of(&named(&[("ocr", ANTHROPIC)]), "lf.yaml").unwrap_err().contains("not a core slot"));
        assert!(CoreChoice::of(&named(&[("models", "@acme/llm")]), "lf.yaml").unwrap_err().contains("separate process"));
    }
}
