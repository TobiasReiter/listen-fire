//! A checker `Catalog` over a snapshot: service/snapshot.ts's
//! `fromCatalogSnapshot`, its lookups answered from the data as the
//! TypeScript answers them.

use super::helpers::{credential_arg_of, entry_position_key_of, unwrap_credential_arg};
use super::types::{AdapterSpec, CatalogSnapshot, CredentialSpec, InstanceSchema, PluginSpec, SnapshotCredential};
use crate::util::js;

/// The snapshot versions this build reads (service/snapshot.ts
/// `SUPPORTED_CATALOG_SNAPSHOT_VERSIONS`).
pub const SUPPORTED_CATALOG_SNAPSHOT_VERSIONS: &[u32] = &[1];

impl CatalogSnapshot {
    /// The snapshot in `json`, refused when it does not read as one — a
    /// member the TypeScript does not declare included, and a schema field
    /// typed with what only the checker's typing builds.
    pub fn load(json: &str) -> Result<CatalogSnapshot, String> {
        let snapshot: CatalogSnapshot = super::types::read_catalog(json)?;
        snapshot.check_contract_version()?;
        snapshot.check_schema_types()?;
        Ok(snapshot)
    }

    /// A snapshot written under a version this build cannot read is refused,
    /// never read as though it were the current one.
    fn check_contract_version(&self) -> Result<(), String> {
        match self.contract_version {
            None => Ok(()),
            Some(seen) if SUPPORTED_CATALOG_SNAPSHOT_VERSIONS.contains(&seen) => Ok(()),
            Some(seen) => Err(format!(
                "the catalog snapshot carries contract version {seen}, which this release does not read (supported: {})",
                SUPPORTED_CATALOG_SNAPSHOT_VERSIONS.iter().map(u32::to_string).collect::<Vec<_>>().join(", ")
            )),
        }
    }

    fn check_schema_types(&self) -> Result<(), String> {
        let refuse = |at: String| Err(format!("{at} is not a type an adapter surface declares"));
        for (name, adapter) in self.adapters.iter() {
            for (key, schema) in adapter.schemas.iter() {
                let fields = schema
                    .positions
                    .iter()
                    .flat_map(|(p, s)| s.properties.iter().map(move |(f, t)| (p, f, t)))
                    .chain(schema.writable_roots.iter().flat_map(|(r, w)| {
                        w.fields.iter().chain(w.result_shape.iter()).map(move |(f, t)| (r, f, t))
                    }));
                for (at, field, type_) in fields {
                    if !type_.is_schema() {
                        return refuse(format!("adapters.{name}.schemas[{key:?}] {at}.{field}"));
                    }
                }
            }
        }
        Ok(())
    }

    /// `adapter(name)`: the entry minus the snapshot's own members.
    pub fn adapter(&self, name: &str) -> Option<&AdapterSpec> {
        self.adapters.get(name).map(|a| &a.spec)
    }

    /// `credential(name)`, the legacy single-adapter form normalised.
    pub fn credential(&self, name: &str) -> Option<CredentialSpec> {
        Some(match self.credentials.get(name)? {
            SnapshotCredential::Adapters(spec) => spec.clone(),
            SnapshotCredential::Adapter(legacy) => CredentialSpec { adapters: vec![legacy.adapter.clone()] },
        })
    }

    /// `credentialNames()`: `Object.keys` of the credentials.
    pub fn credential_names(&self) -> Vec<&str> {
        self.credentials.keys().map(String::as_str).collect()
    }

    pub fn plugin(&self, name: &str) -> Option<&PluginSpec> {
        self.plugins.get(name)
    }

    /// `models?()`: absent when the snapshot carries none, which leaves a
    /// model unchecked.
    pub fn models(&self) -> Option<&[String]> {
        self.models.as_deref()
    }

    /// `constructionArgOptions({adapter, credentialName, arg})`.
    pub fn construction_arg_options(&self, adapter: &str, credential_name: Option<&str>, arg: &str) -> Option<&[String]> {
        let options = self.adapters.get(adapter)?.construction_arg_options.as_ref()?;
        options.get(credential_name.unwrap_or(""))?.get(arg).map(Vec::as_slice)
    }

    /// `instantiate(adapter, args)`: the schema of the instance a
    /// construction call builds. The credential argument picks the schema;
    /// the entry position its position arguments pin picks among that
    /// credential's, falling back to the unpositioned one when the
    /// positioned one is missing. No schema for the credential named is no
    /// schema — never another credential's.
    pub fn instantiate(&self, adapter_name: &str, args: &Args) -> Option<&InstanceSchema> {
        let adapter = self.adapters.get(adapter_name)?;
        let position_key = entry_position_key_of(&adapter.spec, Some(args));
        let at = |credential: Option<&str>| {
            adapter
                .schemas
                .get(&instance_schema_key(credential, Some(&position_key)))
                .or_else(|| adapter.schemas.get(&instance_schema_key(credential, None)))
        };
        let credential_arg = credential_arg_of(&adapter.spec);
        if credential_arg.is_none()
            && let Some(direct) = at(None)
        {
            return Some(direct);
        }
        let arg_name = credential_arg.map_or("credentials", |a| a.name.as_str());
        let raw = args.get(arg_name).map(|raw| js::trim(raw))?;
        let credential = unwrap_credential_arg(&raw).unwrap_or(raw);
        if credential.is_empty() {
            return None;
        }
        at(Some(&credential))
    }
}

/// A construction call's arguments, by name, as their source text.
pub type Args = super::types::JsMap<String>;

/// `instanceSchemaKey({credentialName, positionKey})`: the credential import
/// name, and `::` and the entry position when one is pinned.
pub fn instance_schema_key(credential_name: Option<&str>, position_key: Option<&str>) -> String {
    let credential = credential_name.unwrap_or("");
    match position_key {
        Some(position) if !position.is_empty() => format!("{credential}::{position}"),
        _ => credential.to_string(),
    }
}
