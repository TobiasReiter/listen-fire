//! The project's movement files, scanned as the TypeScript lf scans them
//! (apps/cli/src/sources.ts `scanMovements`): every `.mvt` under the movements
//! folder, entries in sorted order, folders walked depth first.

use std::fs;
use std::path::{Path, PathBuf};

use crate::project::Project;

pub const MOVEMENT_EXTENSION: &str = ".mvt";

#[derive(Debug, Clone)]
pub struct MovementFile {
    /// The path an import names: relative to the movements folder, no extension.
    pub name: String,
    /// Where it is on disk.
    pub path: PathBuf,
    pub source: String,
}

pub fn scan_movements(project: &Project) -> Result<Vec<MovementFile>, String> {
    let mut files = Vec::new();
    walk(&project.movements_dir, &project.movements_dir, &mut files)?;
    Ok(files)
}

fn walk(root: &Path, dir: &Path, files: &mut Vec<MovementFile>) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .map(|entry| entry.map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect::<Result<_, _>>()
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    // `Array.prototype.sort` orders by UTF-16 code units.
    entries.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    for entry in entries {
        let path = dir.join(&entry);
        if path.is_dir() {
            walk(root, &path, files)?;
        } else if let Some(stem) = entry.strip_suffix(MOVEMENT_EXTENSION) {
            let relative_dir = dir.strip_prefix(root).unwrap_or(Path::new(""));
            let name = relative_dir
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .chain(std::iter::once(stem.to_string()))
                .collect::<Vec<_>>()
                .join("/");
            let source = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            files.push(MovementFile { name, path, source });
        }
    }
    Ok(())
}
