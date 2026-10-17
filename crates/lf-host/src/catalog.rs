//! The catalog snapshot the checker reads, built as the TypeScript lf builds
//! it (apps/cli/src/sources.ts `catalogOf` over movement-engine's
//! `catalog_snapshot.ts` `buildCatalogSnapshot`): each adapter external's
//! manifest answer and schema, the credentials the secrets name, and the
//! project's files. Written in the TypeScript's key order (crate::json).

use indexmap::IndexMap;

use crate::externals::{RunningExternal, plugin_entries};
use crate::json::{Js, Obj};
use crate::obj;
use crate::secrets::{Binding, Credentials};
use crate::sources::MovementFile;

/// `CATALOG_SNAPSHOT_VERSION`.
const CATALOG_SNAPSHOT_VERSION: u64 = 1;

/// `instanceSchemaKey({ credentialName })`: the credential's name, `''` for none.
fn instance_schema_key(credential_name: Option<&str>) -> String {
    credential_name.unwrap_or("").to_string()
}

pub fn catalog_of(running: &[RunningExternal], schemas: &IndexMap<String, Js>, credentials: &Credentials, files: &[MovementFile]) -> Js {
    let mut credential_specs = Obj::new();
    for credential in credentials {
        // An install's secret signs calls; it is no account a `using` may name.
        let mut spec = obj! { "adapters" => Js::strings([&credential.external]) };
        match &credential.binding {
            Binding::Install => continue,
            Binding::Credential(declared) => {
                spec.insert("credential".into(), Js::str(declared));
            }
            Binding::Legacy => {}
        }
        credential_specs.insert(credential.name.clone(), Js::from(spec));
    }
    let mut enumerated = credential_specs.clone();
    movement_parser::util::js::object_key_order(&mut enumerated);
    let mut adapters = Obj::new();
    for r in running.iter().filter(|r| !r.is_plugin()) {
        let name = &r.external.manifest.name;
        // The hosted product holds a remote install's secret itself, so there
        // it constructs credential-free; here the secrets file names it.
        let installed = credentials.iter().any(|c| c.external == *name && c.binding == Binding::Install);
        let credentialed = !r.declared_credentials.is_empty() || (r.external.manifest.auth.is_some() && !installed);
        let mut adapter_schemas = Obj::new();
        if let Some(schema) = schemas.get(name) {
            if !credentialed {
                adapter_schemas.insert(instance_schema_key(None), schema.clone());
            }
            for (credential_name, spec) in &enumerated {
                let serves = spec.get("adapters").and_then(Js::as_array).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(name)));
                if credentialed && serves {
                    adapter_schemas.insert(instance_schema_key(Some(credential_name)), schema.clone());
                }
            }
        }
        let construction_args = if credentialed {
            vec![Js::from(obj! { "name" => Js::str("credentials"), "kind" => Js::str("credential"), "required" => Js::Bool(true) })]
        } else {
            Vec::new()
        };
        adapters.insert(name.clone(), adapter_snapshot_of(&r.supported_triggers, &r.listen, construction_args, &r.declared_credentials, adapter_schemas));
    }
    let files: Obj = files.iter().map(|f| (f.name.clone(), Js::from(obj! { "source" => Js::str(&f.source) }))).collect();
    Js::from(obj! {
        "contractVersion" => Js::Num(CATALOG_SNAPSHOT_VERSION.into()),
        "adapters" => Js::from(adapters),
        "credentials" => Js::from(credential_specs),
        "plugins" => Js::from(plugins_of(running)),
        "files" => Js::from(files),
    })
}

/// `adapterSnapshotOf` for a remote adapter's manifest: no construction
/// blocks, no connect affordance, no trigger expectation, an introspected schema.
fn adapter_snapshot_of(supported_triggers: &[String], listen: &Obj, construction_args: Vec<Js>, declared_credentials: &[String], schemas: Obj) -> Js {
    let mut snapshot = obj! { "constructionArgs" => Js::Arr(construction_args) };
    if !declared_credentials.is_empty() {
        snapshot.insert("declaredCredentials".into(), Js::strings(declared_credentials));
    }
    for (k, v) in trigger_config_vocabulary(supported_triggers, listen) {
        snapshot.insert(k, v);
    }
    snapshot.insert("schemaShape".into(), Js::str("introspected"));
    snapshot.insert("schemas".into(), Js::from(schemas));
    Js::from(snapshot)
}

/// `triggerConfigVocabulary` for a manifest with no `triggerConfig` blocks.
fn trigger_config_vocabulary(supported_triggers: &[String], listen: &Obj) -> Obj {
    let mut keys: Vec<String> = Vec::new();
    let mut options = Obj::new();
    let mut required: Vec<String> = Vec::new();
    let mut formats = Obj::new();
    let subscribable = listen.get("subscribableEvents").and_then(Js::as_array).unwrap_or(&[]);
    if !subscribable.is_empty() {
        keys.push("events".into());
        options.insert("events".into(), Js::Arr(subscribable.to_vec()));
    }
    for entry in listen.get("listenConfig").and_then(Js::as_array).unwrap_or(&[]) {
        let Some(key) = entry.get("key").and_then(Js::as_str) else { continue };
        if !keys.iter().any(|k| k == key) {
            keys.push(key.into());
        }
        if Js::is_true(entry.get("required")) && !required.iter().any(|k| k == key) {
            required.push(key.into());
        }
        if let Some(format) = entry.get("format") {
            formats.insert(key.into(), format.clone());
        }
    }
    let mut out = Obj::new();
    if !supported_triggers.is_empty() {
        out.insert("canFire".into(), Js::Bool(true));
    }
    if !keys.is_empty() {
        out.insert("triggerConfig".into(), Js::strings(&keys));
    }
    if !options.is_empty() {
        out.insert("triggerConfigOptions".into(), Js::from(options));
    }
    if !required.is_empty() {
        out.insert("triggerConfigRequired".into(), Js::strings(&required));
    }
    if !formats.is_empty() {
        out.insert("triggerConfigFormats".into(), Js::from(formats));
    }
    let defaults = listen.get("defaultSubscribedEvents").and_then(Js::as_array).unwrap_or(&[]);
    if !defaults.is_empty() {
        out.insert("defaultEvents".into(), Js::Arr(defaults.to_vec()));
    }
    out
}

/// `pluginsOf`: each plugin external's package, keyed as a program spells a
/// plugin, each spec tagged with the package it is imported from.
fn plugins_of(running: &[RunningExternal]) -> Obj {
    let mut plugins = Obj::new();
    for r in running {
        let Some(package) = r.plugins.as_ref().and_then(|d| d.get("package")).cloned() else { continue };
        for (name, spec) in plugin_entries(r.plugins.as_ref()) {
            let mut spec = match spec {
                Js::Obj(spec) => spec,
                _ => continue,
            };
            spec.insert("package".into(), package.clone());
            plugins.insert(name.replace('-', "_"), Js::Obj(spec));
        }
    }
    plugins
}
