//! `lf-host completion <bash|zsh|fish>`: a shell's tab completion, printed to
//! be sourced (`source <(lf-host completion bash)`, or saved where the shell
//! loads completions). It completes the subcommands and their flags, and asks
//! the binary itself for what depends on the project in the current folder:
//! `completion --list modules` (the installed externals and the `@lf/*`
//! packages the project could install) and `completion --list credentials`
//! (the secrets' entry names). The scripts name the binary as it was run, so
//! they keep working when it is installed as `lf`.

use std::path::Path;

use crate::connect::{module_packages, process_env};
use crate::externals::scan_externals;
use crate::project::load_project;
use crate::secrets::load_secrets;

const SUBCOMMANDS: &str = "init check upgrade run resume serve runs call cancel connect credential completion catalog";
const CREDENTIAL_ACTIONS: &str = "add update delete list";
const FLAGS: &str = "--dir --ephemeral --dry-run --event --webhook --body --install --header --port --reason --module --credential --url --redirect-port --no-browser --headless --public --no-reauthorize --help";
const SHELLS: &str = "bash zsh fish";

pub fn run(shell: Option<&str>, list: Option<&str>, dir: Option<&Path>) -> Result<i32, String> {
    if let Some(list) = list {
        // Completing never fails loudly: outside a project there is nothing to offer.
        let dir = match dir {
            Some(dir) => dir.to_path_buf(),
            None => std::env::current_dir().map_err(|e| e.to_string())?,
        };
        for name in listed(list, &dir) {
            println!("{name}");
        }
        return Ok(0);
    }
    let program = program_name();
    let script = match shell {
        Some("bash") => bash(&program),
        Some("zsh") => zsh(&program),
        Some("fish") => fish(&program),
        other => {
            eprintln!("lf completion: bash, zsh or fish, not \"{}\"", other.unwrap_or_default());
            return Ok(2);
        }
    };
    print!("{script}");
    Ok(0)
}

/// The binary's own name, as the shell will call it.
fn program_name() -> String {
    std::env::args()
        .next()
        .and_then(|arg0| Path::new(&arg0).file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "lf-host".into())
}

fn listed(list: &str, dir: &Path) -> Vec<String> {
    let Ok(project) = load_project(dir) else { return Vec::new() };
    match list {
        "modules" => {
            let installed = scan_externals(&project).unwrap_or_default();
            let mut names: Vec<String> = installed.iter().map(|e| e.manifest.name.clone()).collect();
            for package in module_packages(&project.root) {
                if !installed.iter().any(|e| e.manifest.module.as_deref() == Some(package.as_str())) {
                    names.push(package);
                }
            }
            names
        }
        "credentials" => load_secrets(&project, &process_env()).map(|c| c.into_iter().map(|c| c.name).collect()).unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn function_name(program: &str) -> String {
    let safe: String = program.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    format!("_{safe}_complete")
}

fn bash(program: &str) -> String {
    let function = function_name(program);
    format!(
        r#"# bash completion for {program}: source <({program} completion bash)
{function}() {{
  local cur="${{COMP_WORDS[COMP_CWORD]}}" prev="${{COMP_WORDS[COMP_CWORD-1]}}" command="${{COMP_WORDS[1]}}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "{SUBCOMMANDS}" -- "$cur"))
    return
  fi
  case "$prev" in
    --module) COMPREPLY=($(compgen -W "$("{program}" completion --list modules 2>/dev/null)" -- "$cur")); return ;;
    --dir) COMPREPLY=($(compgen -d -- "$cur")); return ;;
    --event|--body) COMPREPLY=($(compgen -f -- "$cur")); return ;;
  esac
  if [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "{FLAGS}" -- "$cur"))
    return
  fi
  case "$command" in
    connect)
      [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "$("{program}" completion --list modules 2>/dev/null)" -- "$cur")) ;;
    credential)
      if [ "$COMP_CWORD" -eq 2 ]; then
        COMPREPLY=($(compgen -W "{CREDENTIAL_ACTIONS}" -- "$cur"))
      elif [ "$COMP_CWORD" -eq 3 ] && [[ "${{COMP_WORDS[2]}}" == update || "${{COMP_WORDS[2]}}" == delete ]]; then
        COMPREPLY=($(compgen -W "$("{program}" completion --list credentials 2>/dev/null)" -- "$cur"))
      fi ;;
    completion)
      [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "{SHELLS}" -- "$cur")) ;;
    *) COMPREPLY=($(compgen -f -- "$cur")) ;;
  esac
}}
complete -F {function} {program}
"#
    )
}

fn zsh(program: &str) -> String {
    let function = function_name(program);
    format!(
        r#"#compdef {program}
# zsh completion for {program}: source <({program} completion zsh), or save it as _{program} on your fpath
{function}() {{
  local command=${{words[2]}}
  if (( CURRENT == 2 )); then
    compadd -- {SUBCOMMANDS}
    return
  fi
  case ${{words[CURRENT-1]}} in
    --module) compadd -- ${{(f)"$("{program}" completion --list modules 2>/dev/null)"}}; return ;;
    --dir) _directories; return ;;
    --event|--body) _files; return ;;
  esac
  if [[ ${{words[CURRENT]}} == -* ]]; then
    compadd -- {FLAGS}
    return
  fi
  case $command in
    connect)
      (( CURRENT == 3 )) && compadd -- ${{(f)"$("{program}" completion --list modules 2>/dev/null)"}} ;;
    credential)
      if (( CURRENT == 3 )); then
        compadd -- {CREDENTIAL_ACTIONS}
      elif (( CURRENT == 4 )) && [[ ${{words[3]}} == (update|delete) ]]; then
        compadd -- ${{(f)"$("{program}" completion --list credentials 2>/dev/null)"}}
      fi ;;
    completion)
      (( CURRENT == 3 )) && compadd -- {SHELLS} ;;
    *) _files ;;
  esac
}}
compdef {function} {program}
"#
    )
}

fn fish(program: &str) -> String {
    format!(
        r#"# fish completion for {program}: {program} completion fish | source
complete -c {program} -f
complete -c {program} -n '__fish_use_subcommand' -a '{SUBCOMMANDS}'
complete -c {program} -n '__fish_seen_subcommand_from connect' -a '({program} completion --list modules 2>/dev/null)'
complete -c {program} -n '__fish_seen_subcommand_from credential; and not __fish_seen_subcommand_from {CREDENTIAL_ACTIONS}' -a '{CREDENTIAL_ACTIONS}'
complete -c {program} -n '__fish_seen_subcommand_from credential; and __fish_seen_subcommand_from update delete' -a '({program} completion --list credentials 2>/dev/null)'
complete -c {program} -n '__fish_seen_subcommand_from completion' -a '{SHELLS}'
complete -c {program} -l module -r -a '({program} completion --list modules 2>/dev/null)'
complete -c {program} -l dir -r -a '(__fish_complete_directories)'
complete -c {program} -l event -r -F
complete -c {program} -l body -r -F
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// What bash completes for the words, with `lf` standing in for the
    /// binary's project lists.
    fn bash_completes(words: &[&str]) -> Option<String> {
        let script = bash("lf");
        let cword = words.len() - 1;
        let quoted: Vec<String> = words.iter().map(|w| format!("'{w}'")).collect();
        let probe = format!(
            "lf() {{ case \"$3\" in modules) echo acme_crm; echo @lf/dealroom ;; credentials) echo alice_acme ;; esac; }}\n{script}\nCOMP_WORDS=({}); COMP_CWORD={cword}; _lf_complete; echo \"${{COMPREPLY[*]}}\"",
            quoted.join(" ")
        );
        let out = Command::new("bash").arg("-c").arg(probe).output().ok()?;
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    #[test]
    fn bash_completes_subcommands_modules_and_credentials() {
        let Some(top) = bash_completes(&["lf", "cre"]) else { return };
        assert_eq!(top, "credential");
        assert_eq!(bash_completes(&["lf", "connect", ""]).unwrap(), "acme_crm @lf/dealroom");
        assert_eq!(bash_completes(&["lf", "credential", "add", "--module", "a"]).unwrap(), "acme_crm");
        assert_eq!(bash_completes(&["lf", "credential", "u"]).unwrap(), "update");
        assert_eq!(bash_completes(&["lf", "credential", "delete", ""]).unwrap(), "alice_acme");
        assert_eq!(bash_completes(&["lf", "completion", "f"]).unwrap(), "fish");
    }

    #[test]
    fn the_zsh_and_fish_scripts_parse() {
        for (shell, script) in [("zsh", zsh("lf")), ("fish", fish("lf"))] {
            let Ok(out) = Command::new(shell).arg("-n").arg("-c").arg(&script).output() else { continue };
            assert!(out.status.success(), "{shell}: {}", String::from_utf8_lossy(&out.stderr));
        }
    }
}
