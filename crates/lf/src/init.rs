//! `lf init [dir]`: scaffold a starter project (lf.yaml, the movements and
//! externals folders, and one movement that checks clean with no external).
//! Existing files are never overwritten; a re-run reports what it made.

use std::fs;
use std::io::Write;
use std::path::Path;

use crate::project::CURRENT_ENGINE_VERSION;

const STARTER_MOVEMENT: &str = r#"# A movement is a program the host runs when something happens. This one needs
# no external system, so `lf check` passes straight away. To react to events
# from a system, install it under externals/ and add
#
#   import { crm } from adapters
#   listen to crm { events: ["company.created"] } fire greet
function greet(name: <text>) {
  return "Hello, ${name}!"
}
"#;

const PROJECT_TAIL: &str = "# Who events act as on this machine (@user_name, @user_email). Defaults to the OS user;
# LF_USER and LF_USER_EMAIL override.
# user: { name: Your Name, email: you@example.com }
# Where this lf is reached from outside; a callback's url is under it. Defaults to
# where `lf serve` listens.
# publicUrl: https://lf.example.com
";

/// What a project keeps out of version control: run state, and credentials.
const IGNORED: &[&str] = &[".lf/", "secrets.yaml", ".env", ".env.*"];

pub fn run(dir: &Path, out: &mut impl Write) -> Result<i32, String> {
    let made = scaffold(dir)?;
    let line = if made.is_empty() { "already a project".to_string() } else { format!("made {}", made.join(", ")) };
    writeln!(out, "{line}").map_err(|e| e.to_string())?;
    Ok(0)
}

fn scaffold(root: &Path) -> Result<Vec<String>, String> {
    let mut made = Vec::new();
    let write = |relative: &str, content: &str, made: &mut Vec<String>| -> Result<(), String> {
        let path = root.join(relative);
        if path.exists() {
            return Ok(());
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        fs::write(&path, content).map_err(|e| format!("{}: {e}", path.display()))?;
        made.push(relative.to_string());
        Ok(())
    };
    fs::create_dir_all(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let project_file = format!("engine: {CURRENT_ENGINE_VERSION}\nmovements: movements\nexternals: externals\n{PROJECT_TAIL}");
    write("lf.yaml", &project_file, &mut made)?;
    write("movements/hello.mvt", STARTER_MOVEMENT, &mut made)?;
    for folder in [".lf", "externals"] {
        let path = root.join(folder);
        if !path.exists() {
            fs::create_dir_all(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            made.push(format!("{folder}/"));
        }
    }
    let gitignore = root.join(".gitignore");
    let existing = fs::read_to_string(&gitignore).unwrap_or_default();
    let present: Vec<&str> = existing.lines().map(str::trim).collect();
    let missing: Vec<&str> = IGNORED.iter().copied().filter(|entry| !present.contains(entry) && !present.contains(&entry.trim_end_matches('/'))).collect();
    if !missing.is_empty() {
        let lead = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
        let appended = format!("{existing}{lead}{}\n", missing.join("\n"));
        fs::write(&gitignore, appended).map_err(|e| format!("{}: {e}", gitignore.display()))?;
        made.push(format!(".gitignore entries {}", missing.join(" ")));
    }
    Ok(made)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_folder_becomes_a_project_and_a_second_run_changes_nothing() {
        let root = std::env::temp_dir().join(format!("lf-init-{}", uuid::Uuid::new_v4())).join("nested");
        assert!(!scaffold(&root).unwrap().is_empty());
        let project = crate::project::load_project(&root).unwrap();
        assert_eq!(project.engine, CURRENT_ENGINE_VERSION);
        let ignored = fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(ignored.lines().any(|l| l == ".lf/") && ignored.lines().any(|l| l == "secrets.yaml"));
        assert!(scaffold(&root).unwrap().is_empty());
        fs::remove_dir_all(root.parent().unwrap()).ok();
    }
}
