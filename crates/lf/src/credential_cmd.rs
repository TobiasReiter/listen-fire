//! `lf credential add|update|delete|list`: a
//! person's credentials for a module, as the platform's credential pages hold
//! them (a name, the module it is for, its fields), written to the secrets
//! file by these commands only.
//!
//!   add --module <module> [name]   a new credential bound to the module and the
//!                                  credential its manifest declares: signed in
//!                                  at the provider for an OAuth 2 one, its
//!                                  fields asked for a static one
//!   update <name>                  signed in again / its fields edited; an
//!                                  entry written by hand gets its binding
//!   delete <name>
//!   list
//!
//! The OAuth app's client id and secret are the module's install's (`lf
//! connect <module>`), never copied into a user's credential. The command
//! lines of `connect`, `credential` and `completion` are read here too.

use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::completion;
use crate::connect::{CLIENT_ID_FIELD, CLIENT_SECRET_FIELD, REDIRECT_PORT_FIELD, connect_module, entry_content, find_external, known_modules, process_env, public_url, read_manifest};
use crate::json::{Js, Obj};
use crate::obj;
use crate::oauth2::{ClientApp, Declaration, DeclarationKind};
use crate::oauth_redirect::{RedirectMode, authorize_at_provider};
use crate::project::{Project, load_project};
use crate::prompt::{Ask, Prompter};
use crate::secret_stores::{EntryChange, change_entry, secrets_file_for_writes, secrets_of};
use crate::secrets::{Binding, Credential, Credentials, ENV_PREFIX, install_of, load_secrets};
use crate::secrets_family::Fields;

/// How the provider sends the person back, as the command line asked.
pub struct RedirectChoice {
    pub how: How,
    /// --redirect-port; absent: the install's registered port.
    pub port: Option<u16>,
    pub open_browser: bool,
}

#[derive(Clone, Copy)]
pub enum How {
    Loopback,
    Headless,
    Public,
}

const TOKEN_FIELDS: [&str; 3] = ["access_token", "refresh_token", "expires_at"];

/// A credential name a movement can import.
fn is_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn fields_vec(fields: &Fields) -> Vec<(String, String)> {
    fields.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
}

pub struct AddInput<'a> {
    pub module: &'a str,
    pub name: Option<&'a str>,
    pub declared: Option<&'a str>,
    pub redirect: &'a RedirectChoice,
}

pub async fn add_credential(project: &Project, input: AddInput<'_>, prompter: &mut Prompter) -> Result<(), String> {
    let env = process_env();
    let credentials = load_secrets(project, &env)?;
    let Some(external) = find_external(project, input.module)? else {
        return Err(format!("module \"{}\" is not installed here; set it up first: lf connect {}", input.module, input.module));
    };
    let module = external.manifest.name.clone();
    let install = install_of(&credentials, &module);
    if install.is_none() && external.manifest.auth.is_some() {
        return Err(format!("module \"{module}\" is not set up here (its server secret): lf connect {module}"));
    }
    let facts = read_manifest(project, &external, install).await?;
    let declaration = choose_declared(&module, &facts.declarations, input.declared)?;

    let name = match input.name {
        Some(name) => name.to_string(),
        None => {
            let user: String = user_name().chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' }).collect();
            prompter.ask("a name for the credential", Ask { default: Some(&format!("{user}_{module}")), ..Ask::default() }).await?
        }
    };
    if !is_name(&name) {
        return Err(format!("\"{name}\" cannot be a credential name: letters, digits and _ (a movement imports it by this name)"));
    }
    if credentials.iter().any(|c| c.name == name) {
        return Err(format!("there is already a credential \"{name}\"; change it with lf credential update {name}"));
    }
    let mut fields: Vec<(String, String)> = ask_fields(declaration, &Fields::new(), prompter).await?.into_iter().filter(|(_, v)| !v.is_empty()).collect();
    if let DeclarationKind::OAuth2(oauth2) = &declaration.kind {
        let client = client_of(&module, install)?;
        let mode = redirect_mode(project, input.redirect, install)?;
        let grant = authorize_at_provider(oauth2, &client, &mode, prompter, &format!("\"{name}\" ({module})")).await?;
        fields = crate::connect::spread(fields, fields_vec(&grant));
    }
    let binding = Binding::Credential(declaration.name.clone());
    let file = secrets_file_for_writes(project, &env)?;
    change_entry(&file, &name, EntryChange::Create(entry_content(&module, &binding, &fields))).await?;
    prompter.print(&format!("added {name} ({module}, credential {}); a movement uses it as:", declaration.name));
    prompter.print(&format!("  import {{ {name} }} from credentials"));
    prompter.print(&format!("  x = connect {module} using {name}"));
    Ok(())
}

pub struct UpdateInput<'a> {
    pub name: &'a str,
    pub declared: Option<&'a str>,
    pub reauthorize: bool,
    pub redirect: &'a RedirectChoice,
}

pub async fn update_credential(project: &Project, input: UpdateInput<'_>, prompter: &mut Prompter) -> Result<(), String> {
    let name = input.name;
    let credentials = load_secrets(project, &process_env())?;
    let credential = writable(&credentials, name)?;
    if credential.binding == Binding::Install {
        return Err(format!("\"{name}\" is the install of {}; change it with lf connect {}", credential.external, credential.external));
    }
    let Some(external) = find_external(project, &credential.external)? else {
        return Err(format!(
            "\"{name}\" is for module \"{}\", which is not installed here (lf connect {})",
            credential.external, credential.external
        ));
    };
    let install = install_of(&credentials, &credential.external);
    let facts = read_manifest(project, &external, install).await?;
    let named = match &credential.binding {
        Binding::Credential(declared) => Some(declared.clone()),
        _ => input.declared.map(str::to_string).or_else(|| declared_by_name(&facts.declarations, name)),
    };
    let declaration = choose_declared(&credential.external, &facts.declarations, named.as_deref())?;

    let mut edited = ask_fields(declaration, &credential.fields, prompter).await?;
    if let (DeclarationKind::OAuth2(oauth2), true) = (&declaration.kind, input.reauthorize) {
        // A hand-written entry holds its own app; a bound one uses the install's.
        let own_app = credential.binding == Binding::Legacy && credential.fields.contains_key(CLIENT_ID_FIELD);
        let client = client_of(&credential.external, if own_app { Some(credential) } else { install })?;
        let mode = redirect_mode(project, input.redirect, install)?;
        let grant = authorize_at_provider(oauth2, &client, &mode, prompter, &format!("\"{name}\" ({})", credential.external)).await?;
        edited.extend(grant);
    }
    let Some(file) = credential.origin.file.clone() else { return Err(format!("\"{name}\" is not in a secrets file")) };
    // Through the family: the same lock and write a refresh takes.
    if !edited.is_empty() {
        secrets_of(credential).update(name, &edited).await?;
    }
    let bound = Binding::Credential(declaration.name.clone());
    let cleared: Vec<&str> = declaration
        .fields
        .iter()
        .filter(|f| f.optional == Some(true) && edited.get(&f.name).is_some_and(String::is_empty))
        .map(|f| f.name.as_str())
        .collect();
    let next = |stored: Option<Vec<(String, String)>>| -> Result<Vec<(String, String)>, String> {
        let stored = stored.ok_or_else(|| format!("\"{name}\" was deleted meanwhile"))?;
        let kept: Vec<(String, String)> = stored
            .into_iter()
            .filter(|(k, _)| !["external", "module", "credential"].contains(&k.as_str()) && !cleared.contains(&k.as_str()))
            .collect();
        Ok(entry_content(&credential.external, &bound, &kept))
    };
    change_entry(&file, name, EntryChange::Replace(&next)).await?;
    let recorded = if credential.binding == Binding::Legacy { "; its binding is now recorded" } else { "" };
    prompter.print(&format!("updated {name} ({}, credential {}){recorded}", credential.external, declaration.name));
    Ok(())
}

pub async fn delete_credential(project: &Project, name: &str, prompter: &mut Prompter) -> Result<(), String> {
    let credentials = load_secrets(project, &process_env())?;
    let credential = writable(&credentials, name)?;
    if credential.binding == Binding::Install {
        return Err(format!("\"{name}\" is the install of {}, not a user credential", credential.external));
    }
    let Some(file) = credential.origin.file.clone() else { return Err(format!("\"{name}\" is not in a secrets file")) };
    change_entry(&file, name, EntryChange::Delete).await?;
    prompter.print(&format!("deleted {name} ({})", credential.external));
    Ok(())
}

/// A credential `list` shows: its line, and the same facts as JSON. Never a value.
pub struct ListedCredential {
    pub line: String,
    pub facts: Obj,
}

/// Each credential's name, module, declared credential, where it is kept and its token's expiry.
pub fn list_credentials(project: &Project) -> Result<Vec<ListedCredential>, String> {
    let credentials = load_secrets(project, &process_env())?;
    Ok(credentials
        .iter()
        .map(|credential| {
            let (what, binding, declared) = match &credential.binding {
                Binding::Install => ("install".to_string(), "install", Js::Null),
                Binding::Credential(declared) => (format!("credential {declared}"), "credential", Js::str(declared)),
                Binding::Legacy => ("written by hand (lf credential update records its binding)".to_string(), "legacy", Js::Null),
            };
            let mut where_ = Vec::new();
            if let Some(file) = &credential.origin.file {
                where_.push(file.path.display().to_string());
            }
            if !credential.origin.env_fields.is_empty() {
                where_.push("environment".to_string());
            }
            let expires_at = credential.fields.get("expires_at");
            let expires = expires_at.map(|at| format!("; token expires {at}")).unwrap_or_default();
            ListedCredential {
                line: format!("{}  {}  {what}  ({}){expires}", credential.name, credential.external, where_.join(" + ")),
                facts: obj! {
                    "name" => Js::str(&credential.name),
                    "module" => Js::str(&credential.external),
                    "binding" => Js::str(binding),
                    "declaredCredential" => declared,
                    "kept" => Js::strings(&where_),
                    "expiresAt" => expires_at.map_or(Js::Null, Js::str),
                },
            }
        })
        .collect())
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// A credential lf may write: in a secrets file, no field from the environment.
fn writable<'c>(credentials: &'c Credentials, name: &str) -> Result<&'c Credential, String> {
    let credential = credentials.iter().find(|c| c.name == name).ok_or_else(|| format!("there is no credential \"{name}\" (lf credential list)"))?;
    if credential.origin.file.is_none() || !credential.origin.env_fields.is_empty() {
        return Err(format!(
            "\"{name}\" has fields from the environment ({ENV_PREFIX}{}__…), which lf cannot write; change it there, or unset them",
            name.to_uppercase()
        ));
    }
    Ok(credential)
}

fn choose_declared<'d>(module: &str, declared: &'d [Declaration], named: Option<&str>) -> Result<&'d Declaration, String> {
    let names = || declared.iter().map(|d| d.name.as_str()).collect::<Vec<_>>().join(", ");
    if declared.is_empty() {
        return Err(format!("module \"{module}\" declares no credential; it needs none"));
    }
    if let Some(named) = named {
        return declared.iter().find(|d| d.name == named).ok_or_else(|| format!("module \"{module}\" declares no credential \"{named}\" (it declares {})", names()));
    }
    match declared {
        [only] => Ok(only),
        _ => Err(format!("module \"{module}\" declares several credentials ({}); name one with --credential", names())),
    }
}

/// A hand-written entry's declared credential: the one named like it, if any.
fn declared_by_name(declared: &[Declaration], name: &str) -> Option<String> {
    if declared.len() > 1 { declared.iter().find(|d| d.name == name).map(|d| d.name.clone()) } else { None }
}

/// Ask each field the declaration lists (not the tokens a sign-in writes);
/// the current value is the default. The answers that changed.
async fn ask_fields(declaration: &Declaration, current: &BTreeMap<String, String>, prompter: &mut Prompter) -> Result<Fields, String> {
    let mut answers = Fields::new();
    for field in &declaration.fields {
        if TOKEN_FIELDS.contains(&field.name.as_str()) && declaration.oauth2().is_some() {
            continue;
        }
        let now = current.get(&field.name).filter(|v| !v.is_empty());
        let question = match &field.label {
            Some(label) => format!("{label} ({})", field.name),
            None => field.name.clone(),
        };
        let ask = Ask { secret: field.secret != Some(false), default: now.map(String::as_str), optional: field.optional == Some(true) };
        let answer = prompter.ask(&question, ask).await?;
        if current.get(&field.name) != Some(&answer) {
            answers.insert(field.name.clone(), answer);
        }
    }
    Ok(answers)
}

fn client_of(module: &str, holder: Option<&Credential>) -> Result<ClientApp, String> {
    let holder = holder.filter(|h| h.fields.get(CLIENT_ID_FIELD).is_some_and(|id| !id.is_empty()));
    let Some(holder) = holder else { return Err(format!("module \"{module}\" has no OAuth app set up: lf connect {module}")) };
    Ok(ClientApp {
        client_id: holder.fields[CLIENT_ID_FIELD].clone(),
        client_secret: holder.fields.get(CLIENT_SECRET_FIELD).filter(|s| !s.is_empty()).cloned(),
    })
}

fn redirect_mode(project: &Project, choice: &RedirectChoice, install: Option<&Credential>) -> Result<RedirectMode, String> {
    let registered = install.and_then(|i| i.fields.get(REDIRECT_PORT_FIELD)).and_then(|p| p.parse::<u16>().ok()).unwrap_or(0);
    let port = choice.port.unwrap_or(registered);
    match choice.how {
        How::Loopback => Ok(RedirectMode::Loopback { port, open_browser: choice.open_browser }),
        How::Headless if port == 0 => Err("--headless needs the redirect port your app registered: --redirect-port <port>, or set it with lf connect".into()),
        How::Headless => Ok(RedirectMode::Headless { port }),
        How::Public => match public_url(project) {
            Some(public_url) => Ok(RedirectMode::Public { public_url, lf_dir: project.lf_dir.clone() }),
            None => Err("--public needs lf.yaml's publicUrl, where lf serve is reached".into()),
        },
    }
}

fn user_name() -> String {
    std::env::var("USER").or_else(|_| std::env::var("LOGNAME")).unwrap_or_else(|_| "user".into())
}

// ── The command lines ───────────────────────────────────────────────────────

pub const COMMANDS: &[&str] = &["connect", "credential", "completion"];

pub const USAGE: &str = "  lf connect [<module>] [--url <server url>]     set a module up: install it, its server and webhook secrets, its OAuth app (no module: list the ones known; --json: as JSON)
  lf credential add --module <module> [<name>] [--credential <declared>]   a user credential for the module: sign in at the provider, or its fields
  lf credential update <name> [--no-reauthorize]   sign in again and edit its fields
  lf credential delete <name>
  lf credential list [--json]
    signing in: --redirect-port N (the port your app registered)  --no-browser  --headless (paste the redirect back)  --public (through lf serve at publicUrl)
  lf completion <bash|zsh|fish>   a shell's tab completion for lf (subcommands, modules, credentials)";

#[derive(Default)]
struct Line {
    positionals: Vec<String>,
    dir: Option<PathBuf>,
    module: Option<String>,
    credential: Option<String>,
    url: Option<String>,
    redirect_port: Option<String>,
    list: Option<String>,
    no_browser: bool,
    headless: bool,
    public: bool,
    no_reauthorize: bool,
    json: bool,
}

fn parse(argv: &[String]) -> Result<Line, String> {
    let mut line = Line::default();
    let mut rest = argv.iter();
    while let Some(arg) = rest.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag, Some(value.to_string())),
            _ => (arg.as_str(), None),
        };
        let mut value = |name: &str| inline.clone().or_else(|| rest.next().cloned()).ok_or_else(|| format!("{name} needs a value"));
        match flag {
            "--dir" => line.dir = Some(PathBuf::from(value("--dir")?)),
            "--module" => line.module = Some(value("--module")?),
            "--credential" => line.credential = Some(value("--credential")?),
            "--url" => line.url = Some(value("--url")?),
            "--redirect-port" => line.redirect_port = Some(value("--redirect-port")?),
            "--list" => line.list = Some(value("--list")?),
            "--no-browser" => line.no_browser = true,
            "--headless" => line.headless = true,
            "--public" => line.public = true,
            "--no-reauthorize" => line.no_reauthorize = true,
            "--json" => line.json = true,
            "--ephemeral" => {}
            flag if flag.starts_with('-') && flag != "-" => return Err(format!("unknown option \"{flag}\"")),
            positional => line.positionals.push(positional.to_string()),
        }
    }
    Ok(line)
}

/// `connect`, `credential` or `completion`: the exit code, or None when the
/// command line is another command's.
pub async fn dispatch(argv: &[String]) -> Option<Result<i32, String>> {
    let command = argv.iter().find(|a| !a.starts_with('-'))?;
    if !COMMANDS.contains(&command.as_str()) || argv.iter().any(|a| a == "-h" || a == "--help") {
        return None;
    }
    Some(run(argv).await)
}

fn project_at(line: &Line) -> Result<Project, String> {
    let dir = match &line.dir {
        Some(dir) => dir.clone(),
        None => std::env::current_dir().map_err(|e| e.to_string())?,
    };
    load_project(&dir)
}

async fn run(argv: &[String]) -> Result<i32, String> {
    let line = parse(argv)?;
    let (command, rest) = line.positionals.split_first().ok_or("no command")?;
    match command.as_str() {
        "completion" => completion::run(rest.first().map(String::as_str), line.list.as_deref(), line.dir.as_deref()),
        "connect" => {
            let project = project_at(&line)?;
            let Some(reference) = rest.first() else {
                let known = known_modules(&project)?;
                if line.json {
                    let doc = Js::Obj(obj! { "modules" => Js::Arr(known.into_iter().map(|m| Js::Obj(m.facts)).collect()) });
                    println!("{}", doc.to_json());
                } else if known.is_empty() {
                    println!("no modules known here; install one: lf connect <package or name>");
                } else {
                    println!("{}", known.iter().map(|m| m.line.as_str()).collect::<Vec<_>>().join("\n"));
                }
                return Ok(0);
            };
            connect_module(&project, reference, &mut Prompter::terminal(), line.url.as_deref()).await?;
            Ok(0)
        }
        _ => credential(&line, rest).await,
    }
}

async fn credential(line: &Line, rest: &[String]) -> Result<i32, String> {
    let project = project_at(line)?;
    let (action, name) = (rest.first().map(String::as_str), rest.get(1).map(String::as_str));
    if action == Some("list") {
        let listed = list_credentials(&project)?;
        if line.json {
            let doc = Js::Obj(obj! { "credentials" => Js::Arr(listed.into_iter().map(|c| Js::Obj(c.facts)).collect()) });
            println!("{}", doc.to_json());
        } else {
            let lines: Vec<&str> = listed.iter().map(|c| c.line.as_str()).collect();
            println!("{}", if lines.is_empty() { "no credentials".to_string() } else { lines.join("\n") });
        }
        return Ok(0);
    }
    if line.headless && line.public {
        eprintln!("lf credential: --headless and --public are two ways back from the provider; pick one");
        return Ok(2);
    }
    let port = match &line.redirect_port {
        Some(port) => match port.parse::<u16>() {
            Ok(n) if port.chars().all(|c| c.is_ascii_digit()) => Some(n),
            _ => {
                eprintln!("--redirect-port: a port number, not \"{port}\"");
                return Ok(2);
            }
        },
        None => None,
    };
    let how = if line.headless {
        How::Headless
    } else if line.public {
        How::Public
    } else {
        How::Loopback
    };
    let redirect = RedirectChoice { how, port, open_browser: !line.no_browser && !line.headless };
    let mut prompter = Prompter::terminal();
    match (action, name) {
        (Some("add"), _) => {
            let Some(module) = &line.module else {
                eprintln!("lf credential add needs --module <module>");
                return Ok(2);
            };
            let input = AddInput { module, name, declared: line.credential.as_deref(), redirect: &redirect };
            add_credential(&project, input, &mut prompter).await?;
        }
        (Some("update"), Some(name)) => {
            let input = UpdateInput { name, declared: line.credential.as_deref(), reauthorize: !line.no_reauthorize, redirect: &redirect };
            update_credential(&project, input, &mut prompter).await?;
        }
        (Some("delete"), Some(name)) => delete_credential(&project, name, &mut prompter).await?,
        (Some(action @ ("update" | "delete")), None) => {
            eprintln!("lf credential {action} needs a credential name");
            return Ok(2);
        }
        (other, _) => {
            eprintln!("lf credential: add, update, delete or list, not \"{}\"", other.unwrap_or_default());
            return Ok(2);
        }
    }
    Ok(0)
}
