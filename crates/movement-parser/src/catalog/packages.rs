//! A plugin package (language version 5, design §2.10, §4.3): a tag a
//! plugin's spec declares as its `package`, matched exactly and never
//! parsed. ``import { `@lf/web` as web } from plugins`` binds each member
//! under the dotted local name `web.fetchUrl`, so a call of it is an
//! ordinary plugin call. The TypeScript twin is `packageMembers` in
//! packages/movement-lang/checker/catalog.ts.

use crate::ast::{ImportSource, ImportedName, Program, Statement};
use crate::catalog::types::{JsMap, PluginSpec};
use crate::surface::table::plugin_name;
use crate::version::since;

/// One plugin of a package: the name it is called by after the package's
/// local name and a dot, and the catalog's key it invokes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageMember {
    pub name: String,
    pub key: String,
}

/// The plugins whose spec declares `tag` as its package, in catalog order;
/// none when no spec does, which is how a package import is told from an
/// import of one plugin.
pub fn package_members(plugins: &JsMap<PluginSpec>, tag: &str) -> Vec<PackageMember> {
    plugins
        .iter()
        .filter(|(_, spec)| spec.package.as_deref() == Some(tag))
        .map(|(key, _)| PackageMember { name: plugin_name(key), key: key.clone() })
        .collect()
}

/// The local name a package's member is bound to: `web.fetchUrl`.
pub fn member_local(package_local: &str, member: &str) -> String {
    format!("{package_local}.{member}")
}

/// The program with each package import read as the imports of its members
/// (`` `@lf/web` as web `` → `fetch_url as web.fetchUrl`, …), which is what
/// an engine binds. An import that names no package is left as written. The
/// checkers do not read this: they bind the same names themselves, keeping
/// the package to name in a diagnostic.
pub fn expand_package_imports(program: &mut Program, plugins: &JsMap<PluginSpec>, language_version: u32) {
    if !since(language_version, 5) {
        return;
    }
    for statement in &mut program.statements {
        let Statement::Import(import) = statement else { continue };
        if !matches!(&import.source, ImportSource::Builtin { namespace } if namespace == "plugins") {
            continue;
        }
        import.names = std::mem::take(&mut import.names)
            .into_iter()
            .flat_map(|imported| {
                let members = package_members(plugins, &imported.name);
                if members.is_empty() {
                    return vec![imported];
                }
                let local = imported.alias.unwrap_or(imported.name);
                members.into_iter().map(|m| ImportedName { alias: Some(member_local(&local, &m.name)), name: m.key }).collect()
            })
            .collect();
    }
}
