//! Every link a hover can carry resolves to a page and heading of the site `pnpm docs:build` produces.

use std::path::{Path, PathBuf};
use std::process::Command;

use movement_language::docs::{all_targets, docs_url};
use movement_language::{DOCS_BASE, DOCS_SITE};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

#[test]
fn every_hover_link_resolves_in_the_built_site() {
    assert_eq!(DOCS_BASE, format!("{DOCS_SITE}/docs/v5"));
    let root = repo_root();
    let built = Command::new("node").arg("scripts/docs/build.mjs").current_dir(&root).output().expect("node is needed to build the docs site");
    assert!(built.status.success(), "{}", String::from_utf8_lossy(&built.stderr));
    let targets = all_targets();
    assert!(targets.len() > 50, "built-ins and symbol kinds are covered: {}", targets.len());
    let mut broken = Vec::new();
    for (page, anchor) in targets {
        let url = docs_url(&page, &anchor);
        let file = root.join("site/docs/v5").join(format!("{page}.html"));
        match std::fs::read_to_string(&file) {
            Err(_) => broken.push(format!("{url}: no page")),
            Ok(html) if !html.contains(&format!("id=\"{anchor}\"")) => broken.push(format!("{url}: no heading")),
            Ok(_) => {}
        }
    }
    assert!(broken.is_empty(), "{}", broken.join("\n"));
}
