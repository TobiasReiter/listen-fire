//! `lf-host` — the local run host as one Rust binary, growing toward the sole
//! `lf` (plans/cloud-native-2026-10-06/22_everywhere_plan.md #7). Named
//! `lf-host` until it replaces the TypeScript `lf` (apps/cli), whose commands,
//! project format, state file and output it keeps.
//!
//!   lf-host check [--dir <project>]          the TypeScript `lf check`
//!   lf-host run --event <file> [--dry-run]   route an event to its listens and run each
//!   lf-host resume [<run-id>]                step a parked run, or drain due work and every parked run
//!   lf-host upgrade [--check] [--all]        rewrite the movement files into the current language version
//!   lf-host runs                             the runs, most recent first
//!   lf-host drain [--until-idle] [--max-seconds N]  a worker over the work queue (scale from zero)
//!   lf-host serve [--port N]                 the inbound doors, the callback door and the work drain
//!   lf-host call <callback-id> [--body <values.json>]
//!   lf-host cancel <run-id> [--reason <text>]
//!   lf-host catalog [--dir <project>]        the catalog snapshot `check` reads, as JSON
//!   lf-host connect [<module>]               set a module up (src/connect.rs)
//!   lf-host credential add|update|delete|list   user credentials (src/credential_cmd.rs)
//!   lf-host completion <bash|zsh|fish>       the shell's tab completion
//!   lf-host --contract-store <state.db|postgres://…> [--team <uuid>]  the run host's backend over stdio JSON-RPC
//!   lf-host --contract-secrets <file|env>    a secrets store over stdio JSON-RPC
//!   lf-host --contract-doors                 the inbound doors over HTTP, their world arranged over stdio JSON-RPC
//!
//! `run`, `resume`, `runs`, `drain`, `serve`, `call` and `cancel` keep run
//! state where `--store <spec>` (or lf.yaml's `store:`) says: a SQLite file,
//! `.lf/state.db` by default, or a Postgres database (`postgres://…`) with the
//! hosted product's schema.
//!   lf-host --project-schema                 one schema projection, stdin to stdout (a parity probe)
//!
//! Single-threaded: one tokio thread, every wait an await.

mod anthropic;
mod backend;
mod callbacks;
mod catalog;
mod check;
mod completion;
mod connect;
mod contract_doors;
mod contract_secrets;
mod contract_store;
mod credential_calls;
mod credential_cmd;
mod doors;
mod documents;
mod drain;
mod externals;
mod file_ref;
mod http;
mod http_out;
mod inbound;
mod json;
mod llm_calls;
mod models;
mod oauth2;
mod oauth_redirect;
mod park_files;
mod pg_store;
mod project;
mod prompt;
mod protocol;
mod remote;
mod routing;
mod run_host;
mod runs;
mod schema;
mod secret_stores;
mod secrets;
mod secrets_family;
mod segment;
mod serve;
mod sources;
mod store;
mod upgrade;
mod wire;
mod wire_results;

use std::io::Write;
use std::path::PathBuf;

const USAGE: &str = "usage: lf-host <check|catalog|run|resume|runs|drain|serve|call|cancel|upgrade|connect|credential|completion> [--dir <project folder>] [--ephemeral] [--store <state.db|postgres://…>] [--team <uuid>]
       lf-host run --event <file.json> [--dry-run]
       lf-host run --webhook <external> --body <file> [--install <credential>] [--header k:v]...
       lf-host resume [<run-id>]
       lf-host drain [--until-idle] [--max-seconds <n>]
       lf-host serve [--port N]
       lf-host call <callback-id> [--body <values.json>]
       lf-host cancel <run-id> [--reason <text>]
       lf-host --contract-store <state.db|postgres://…> [--team <uuid>]
       lf-host --contract-secrets <secrets file | env>
       lf-host --contract-doors
       lf-host --project-schema
  check     every diagnostic the project's movement files have (as `lf check`)
  catalog   the catalog snapshot the files are checked against, as JSON
  run       route the event file's event to the listens it matches and run each (as `lf run --event`)
  resume    step every parked leaf of one run, or drain due work and every parked run (as `lf resume`)
  upgrade   rewrite the movement files by the fixes that keep their meaning (--all: every fix offered; --check: print the diff, write nothing)
  runs      the runs in the state file, most recent first (as `lf runs`)
  drain     claim due work rows one at a time and run them; with --until-idle exit once none is due, with --max-seconds stop claiming after n seconds
  serve     the inbound doors, the callback door and the work queue's drain (as `lf serve`)
  call      call a callback, as its url's POST does (the values: a JSON object)
  cancel    cancel a run: settled failed now, or at its next statement if another lf is stepping it
  --store   where run state is kept: a SQLite file (default .lf/state.db, or lf.yaml's `store:`) or a Postgres database with the hosted schema
  --team    the tenant (a uuid) of a Postgres store's rows
  --contract-store  serve the run host's backend over stdin/stdout JSON-RPC (the contract suite's bridge)
  --contract-doors  serve the inbound doors over HTTP, their world arranged over stdin/stdout JSON-RPC (the inbound contract suite's bridge)
  --project-schema  project one adapter introspection (JSON on stdin) into its schema and notes (the projection's parity probe)
  --contract-secrets  serve one secrets store over stdin/stdout JSON-RPC (the secrets contract suite's bridge)
{CREDENTIAL_USAGE}
not yet here (the TypeScript lf has them): init";

/// The commands the TypeScript lf has that this binary does not yet.
const NOT_YET: &[&str] = &["init"];

struct Args {
    command: Option<String>,
    /// Positionals after the command (`resume <run-id>`).
    rest: Vec<String>,
    dir: PathBuf,
    ephemeral: bool,
    dry_run: bool,
    event: Option<PathBuf>,
    webhook: Option<String>,
    check_only: bool,
    all: bool,
    body: Option<PathBuf>,
    install: Option<String>,
    headers: Vec<String>,
    port: Option<String>,
    reason: Option<String>,
    contract_store: Option<String>,
    contract_doors: bool,
    store: Option<String>,
    team: Option<String>,
    until_idle: bool,
    max_seconds: Option<u64>,
    project_schema: bool,
    help: bool,
}

fn parse_args(argv: &[String]) -> Result<Args, String> {
    let mut args = Args {
        command: None,
        rest: Vec::new(),
        dir: std::env::current_dir().map_err(|e| e.to_string())?,
        ephemeral: false,
        dry_run: false,
        event: None,
        webhook: None,
        check_only: false,
        all: false,
        body: None,
        install: None,
        headers: Vec::new(),
        port: None,
        reason: None,
        contract_store: None,
        contract_doors: false,
        store: None,
        team: None,
        until_idle: false,
        max_seconds: None,
        project_schema: false,
        help: false,
    };
    let mut rest = argv.iter();
    while let Some(arg) = rest.next() {
        let mut value = |name: &str| rest.next().cloned().ok_or_else(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--dir" => args.dir = PathBuf::from(value("--dir")?),
            "--event" => args.event = Some(PathBuf::from(value("--event")?)),
            "--webhook" => args.webhook = Some(value("--webhook")?),
            "--check" => args.check_only = true,
            "--all" => args.all = true,
            "--body" => args.body = Some(PathBuf::from(value("--body")?)),
            "--install" => args.install = Some(value("--install")?),
            "--header" => args.headers.push(value("--header")?),
            "--port" => args.port = Some(value("--port")?),
            "--reason" => args.reason = Some(value("--reason")?),
            "--contract-doors" => args.contract_doors = true,
            "--ephemeral" => args.ephemeral = true,
            "--dry-run" => args.dry_run = true,
            "--contract-store" => args.contract_store = Some(value("--contract-store")?),
            "--store" => args.store = Some(value("--store")?),
            "--team" => args.team = Some(value("--team")?),
            "--until-idle" => args.until_idle = true,
            "--max-seconds" => {
                let raw = value("--max-seconds")?;
                args.max_seconds = Some(raw.parse().map_err(|_| format!("--max-seconds {raw}: a whole number of seconds"))?);
            }
            "--project-schema" => args.project_schema = true,
            "-h" | "--help" => args.help = true,
            flag if flag.starts_with("--dir=") => args.dir = PathBuf::from(&flag["--dir=".len()..]),
            flag if flag.starts_with('-') => return Err(format!("unknown option \"{flag}\"")),
            positional if args.command.is_none() => args.command = Some(positional.to_string()),
            positional => args.rest.push(positional.to_string()),
        }
    }
    Ok(args)
}

async fn run(argv: Vec<String>) -> Result<i32, String> {
    if let Some(code) = credential_cmd::dispatch(&argv).await {
        return code;
    }
    if let [flag, target] = argv.as_slice()
        && flag == "--contract-secrets"
    {
        return contract_secrets::serve(std::path::Path::new(target)).await.map(|()| 0);
    }
    let args = parse_args(&argv)?;
    if let Some(spec) = &args.contract_store {
        let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
        return contract_store::serve(&backend::StoreSpec::parse(spec, &cwd, args.team.as_deref())?).await.map(|()| 0);
    }
    if args.contract_doors {
        return contract_doors::serve().await.map(|()| 0);
    }
    let mut out = std::io::stdout().lock();
    if args.project_schema {
        let mut input = Vec::new();
        std::io::Read::read_to_end(&mut std::io::stdin(), &mut input).map_err(|e| e.to_string())?;
        writeln!(out, "{}", schema::probe(&json::Js::parse(&input)?)?.to_json()).map_err(|e| e.to_string())?;
        return Ok(0);
    }
    let Some(command) = args.command.clone().filter(|_| !args.help) else {
        writeln!(out, "{}", USAGE.replace("{CREDENTIAL_USAGE}", credential_cmd::USAGE)).map_err(|e| e.to_string())?;
        return Ok(if args.help { 0 } else { 2 });
    };
    match command.as_str() {
        "check" => check::run(&project::load_project(&args.dir)?, &mut out).await,
        "catalog" => match check::open_checking(&project::load_project(&args.dir)?).await? {
            check::Opened::Ready(checking) => {
                writeln!(out, "{}", checking.catalog.to_json()).map_err(|e| e.to_string())?;
                Ok(0)
            }
            check::Opened::MissingCredentials(lines) => {
                for line in lines {
                    writeln!(out, "{line}").map_err(|e| e.to_string())?;
                }
                Ok(1)
            }
        },
        "upgrade" => upgrade::run(&project::load_project(&args.dir)?, upgrade::UpgradeOptions { check_only: args.check_only, all: args.all }, &mut out).await,
        "run" => {
            if let (Some(external), Some(body)) = (&args.webhook, &args.body) {
                let project = project::load_project(&args.dir)?;
                let store = store_of(&args, &project)?;
                let session = runs::open_session(project, args.ephemeral, &store).await?;
                let delivery = serve::WebhookFile { external, install: args.install.as_deref(), body, headers: &args.headers };
                return runs::report(&serve::receive_webhook(&session, delivery).await?, &mut out);
            }
            let Some(event_file) = &args.event else {
                eprintln!("lf run needs --event <file> or --webhook <external> --body <file>");
                return Ok(2);
            };
            let project = project::load_project(&args.dir)?;
            let store = store_of(&args, &project)?;
            if args.ephemeral && matches!(store, backend::StoreSpec::Postgres { .. }) {
                eprintln!("lf-host: --ephemeral keeps its run state in a temporary file; it does not take a Postgres --store");
                return Ok(2);
            }
            let session = runs::open_session(project, args.ephemeral, &store).await?;
            let (external, event) = runs::read_event_file(event_file)?;
            let outcomes = session.fire_event(&external, &event, args.dry_run).await?;
            runs::report(&outcomes, &mut out)
        }
        "resume" => {
            let project = project::load_project(&args.dir)?;
            let store = store_of(&args, &project)?;
            let session = runs::open_session(project, false, &store).await?;
            let outcomes = match args.rest.first() {
                Some(run_id) => vec![session.resume_run(run_id).await?],
                // As the TypeScript lf: a work row that fails is retried later, unlogged.
                None => session.resume_all(&mut std::io::sink()).await?,
            };
            if outcomes.is_empty() {
                writeln!(out, "no parked runs").map_err(|e| e.to_string())?;
            }
            runs::report(&outcomes, &mut out)
        }
        "runs" => {
            let project = project::load_project(&args.dir)?;
            let store = backend::open_store(&store_of(&args, &project)?)?;
            for run in store.runs(50).map_err(|e| e.to_string())? {
                writeln!(out, "{} {} {}:{} {}", run.id, run.started_at, run.file, run.movement, run.status).map_err(|e| e.to_string())?;
            }
            Ok(0)
        }
        "drain" => {
            let project = project::load_project(&args.dir)?;
            let store = store_of(&args, &project)?;
            let session = runs::open_session(project, false, &store).await?;
            drain::drain(&session, &drain::DrainOptions { until_idle: args.until_idle, max_seconds: args.max_seconds }, &mut out).await
        }
        "serve" => {
            let project = project::load_project(&args.dir)?;
            let store = store_of(&args, &project)?;
            serve::run(project, args.ephemeral, &store, args.port.as_deref()).await
        }
        "call" => {
            let project = project::load_project(&args.dir)?;
            let store = store_of(&args, &project)?;
            serve::call_command(project, &store, args.rest.first().map(String::as_str), args.body.as_deref(), &mut out).await
        }
        "cancel" => {
            let project = project::load_project(&args.dir)?;
            serve::cancel_command(&store_of(&args, &project)?, args.rest.first().map(String::as_str), args.reason.as_deref(), &mut out).await
        }
        other if NOT_YET.contains(&other) => {
            eprintln!("lf-host: `{other}` is not in lf-host yet; use the TypeScript lf for it");
            Ok(2)
        }
        other => {
            eprintln!("unknown command \"{other}\"\n{}", USAGE.replace("{CREDENTIAL_USAGE}", credential_cmd::USAGE));
            Ok(2)
        }
    }
}

/// Where a command keeps its run state: `--store`, else lf.yaml's `store:`, else `.lf/state.db`.
fn store_of(args: &Args, project: &project::Project) -> Result<backend::StoreSpec, String> {
    backend::StoreSpec::of_command(args.store.as_deref(), project.store.as_deref(), &project.root, &project.lf_dir, args.team.as_deref())
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a tokio runtime");
    // A LocalSet, so a listener's connections run as tasks on this one thread.
    let code = match runtime.block_on(tokio::task::LocalSet::new().run_until(run(argv))) {
        Ok(code) => code,
        Err(message) => {
            eprintln!("lf-host: {message}");
            1
        }
    };
    drop(runtime);
    std::process::exit(code);
}
