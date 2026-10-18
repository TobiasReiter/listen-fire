//! `lf` — the local run host as one Rust binary: the `lf` command
//! (plans/cloud-native-2026-10-06/22_everywhere_plan.md #7).
//!
//!   lf init [dir]                       scaffold a starter project
//!   lf check [--dir <project>]          every diagnostic the project's files have
//!   lf run <movement> [--dry-run]      run a movement a `listen to manual` fires
//!   lf run --event <file> [--dry-run]   route an event to its listens and run each
//!   lf run --poll <movement>            poll now the polled sources of the listens that fire it
//!   lf resume [<run-id>]                step a parked run, or drain due work and every parked run
//!   lf upgrade [--check] [--all]        rewrite the movement files into the current language version
//!   lf runs [show <run-id>]             the runs, most recent first; one run in full
//!   --json                              (check, catalog, run, resume, runs, call, cancel, connect, credential list) one JSON document
//!   lf drain [--until-idle] [--max-seconds N]  a worker over the work queue (scale from zero)
//!   lf serve [--port N]                 the inbound doors, the callback door and the work drain
//!   lf call <callback-id> [--body <values.json>]
//!   lf cancel <run-id> [--reason <text>]
//!   lf catalog [--dir <project>]        the catalog snapshot `check` reads, as JSON
//!   lf connect [<module>]               set a module up (src/connect.rs)
//!   lf credential add|update|delete|list   user credentials (src/credential_cmd.rs)
//!   lf completion <bash|zsh|fish>       the shell's tab completion
//!   lf --contract-store <state.db|postgres://…> [--team <uuid>]  the run host's backend over stdio JSON-RPC
//!   lf --contract-store-slot [--dir <project>]                   the same, over the project's store slot
//!   lf --contract-limiter                                        the built-in limiter over stdio JSON-RPC
//!   lf --contract-limiter-slot [--dir <project>]                 the same, over the project's limiter slot
//!   lf --contract-secrets <file|env>    a secrets store over stdio JSON-RPC
//!   lf --contract-doors                 the inbound doors over HTTP, their world arranged over stdio JSON-RPC
//!
//! `run`, `resume`, `runs`, `drain`, `serve`, `call` and `cancel` keep run
//! state in the store slot's module (lf.yaml `core: { store: … }`, src/core.rs):
//! @lf/sqlite-store, `.lf/state.db` by default, or @lf/postgres-store, its own
//! `lf` schema; `--store <spec>` names a SQLite file or `postgres://…` outright.
//!   lf --project-schema                 one schema projection, stdin to stdout (a parity probe)
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
mod contract_limiter;
mod contract_store;
mod core;
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
mod init;
mod json;
mod lfjson;
mod json_repair;
mod limiter;
mod limiter_module;
mod llm_calls;
mod models;
mod oauth2;
mod oauth_redirect;
mod park_files;
mod pg_store;
mod pg_tls;
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
mod store_module;
mod store_wire;
mod units;
mod upgrade;
mod wire;
mod wire_results;

use std::io::Write;
use std::path::PathBuf;

const USAGE: &str = "usage: lf <init|check|catalog|run|resume|runs|drain|serve|call|cancel|upgrade|connect|credential|completion> [--dir <project folder>] [--ephemeral] [--store <state.db|postgres://…>] [--team <uuid>]
       lf run <movement> [--dry-run]
       lf run --event <file.json> [--dry-run]
       lf run --poll <movement>
       lf run --webhook <external> --body <file> [--install <credential>] [--header k:v]...
       lf resume [<run-id>]
       lf drain [--until-idle] [--max-seconds <n>] [--kinds <kind,…>]
       lf serve [--port N]
       lf call <callback-id> [--body <values.json>]
       lf cancel <run-id> [--reason <text>]
       lf runs [show <run-id>]
       lf --contract-store <state.db|postgres://…> [--team <uuid>]
       lf --contract-store-slot [--dir <project>]
       lf --contract-limiter
       lf --contract-limiter-slot [--dir <project>]
       lf --contract-secrets <secrets file | env>
       lf --contract-doors
       lf --project-schema
       lf --version
  init      scaffold a starter project in the folder (default: the current one): lf.yaml, a movement, .gitignore
  check     every diagnostic the project's movement files have (as `lf check`)
  catalog   the catalog snapshot the files are checked against, as JSON
  run       run <movement>: one manual invocation, to the `listen to manual fire <movement>` listens; --event: route the event file's event to the listens it matches and run each; --poll <movement>: poll now, once, the source of each listen that fires it on a polled source (its manifest declares `poll`), and run the listen on each new event
  resume    step every parked leaf of one run, or drain due work and every parked run (as `lf resume`)
  upgrade   rewrite the movement files by the fixes that keep their meaning (--all: every fix offered; --check: print the diff, write nothing)
  runs      the runs in the state file, most recent first (as `lf runs`); `runs show <run-id>`: one run, its event, trace and park
  --json    check, catalog, run, resume, runs, call, cancel, connect, credential list: one JSON document (docs/lf-json.md); a failure is {\"error\": …}
  drain     fire each cron listen's due tick (once, however many workers drain), then claim due work rows one at a time and run them (a polled listen's row is its next poll, due every interval its source declares); with --until-idle exit once none is due, with --max-seconds stop claiming after n seconds, with --kinds only rows of those kinds (resume_timer, wake_await, fire_event, fire_callback, poll_listen) and the cron ticks only when it names cron
  serve     the inbound doors, the callback door and the work queue's drain (as `lf serve`)
  call      call a callback, as its url's POST does (the values: a JSON object)
  cancel    cancel a run: settled failed now, or at its next statement if another lf is stepping it
  --store   where run state is kept: a SQLite file or a Postgres database (set up by `lf connect @lf/postgres-store`), instead of lf.yaml's `core: { store: … }`
  --team    the tenant (a uuid) of a Postgres store's rows
  --start-timeout  seconds a started external has to print `listening <port>` (default 30, or lf.yaml's `startTimeout`)
  --contract-store  serve the run host's backend over stdin/stdout JSON-RPC (the contract suite's bridge)
  --contract-store-slot  the same, over the store module the project's store slot names
  --contract-limiter  serve lf's built-in limiter over stdin/stdout JSON-RPC (the limiter contract suite's bridge)
  --contract-limiter-slot  the same, over the limiter module the project's limiter slot names
  --contract-doors  serve the inbound doors over HTTP, their world arranged over stdin/stdout JSON-RPC (the inbound contract suite's bridge)
  --project-schema  project one adapter introspection (JSON on stdin) into its schema and notes (the projection's parity probe)
  --contract-secrets  serve one secrets store over stdin/stdout JSON-RPC (the secrets contract suite's bridge)
  --version  this lf's version (a release tag lf-v<version> is built from the crate at that version)
{CREDENTIAL_USAGE}";

struct Args {
    command: Option<String>,
    /// Positionals after the command (`resume <run-id>`).
    rest: Vec<String>,
    dir: PathBuf,
    ephemeral: bool,
    dry_run: bool,
    event: Option<PathBuf>,
    webhook: Option<String>,
    poll: Option<String>,
    check_only: bool,
    all: bool,
    body: Option<PathBuf>,
    install: Option<String>,
    headers: Vec<String>,
    port: Option<String>,
    reason: Option<String>,
    contract_store: Option<String>,
    contract_store_slot: bool,
    contract_limiter: bool,
    contract_limiter_slot: bool,
    contract_doors: bool,
    store: Option<String>,
    team: Option<String>,
    until_idle: bool,
    max_seconds: Option<u64>,
    kinds: Option<String>,
    start_timeout: Option<std::time::Duration>,
    project_schema: bool,
    json: bool,
    help: bool,
    version: bool,
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
        poll: None,
        check_only: false,
        all: false,
        body: None,
        install: None,
        headers: Vec::new(),
        port: None,
        reason: None,
        contract_store: None,
        contract_store_slot: false,
        contract_limiter: false,
        contract_limiter_slot: false,
        contract_doors: false,
        store: None,
        team: None,
        until_idle: false,
        max_seconds: None,
        kinds: None,
        start_timeout: None,
        project_schema: false,
        json: false,
        help: false,
        version: false,
    };
    let mut rest = argv.iter();
    while let Some(arg) = rest.next() {
        let mut value = |name: &str| rest.next().cloned().ok_or_else(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--dir" => args.dir = PathBuf::from(value("--dir")?),
            "--event" => args.event = Some(PathBuf::from(value("--event")?)),
            "--webhook" => args.webhook = Some(value("--webhook")?),
            "--poll" => args.poll = Some(value("--poll")?),
            "--check" => args.check_only = true,
            "--all" => args.all = true,
            "--body" => args.body = Some(PathBuf::from(value("--body")?)),
            "--install" => args.install = Some(value("--install")?),
            "--header" => args.headers.push(value("--header")?),
            "--port" => args.port = Some(value("--port")?),
            "--reason" => args.reason = Some(value("--reason")?),
            "--contract-doors" => args.contract_doors = true,
            "--ephemeral" => args.ephemeral = true,
            "--json" => args.json = true,
            "--dry-run" => args.dry_run = true,
            "--contract-store" => args.contract_store = Some(value("--contract-store")?),
            "--contract-store-slot" => args.contract_store_slot = true,
            "--contract-limiter" => args.contract_limiter = true,
            "--contract-limiter-slot" => args.contract_limiter_slot = true,
            "--store" => args.store = Some(value("--store")?),
            "--team" => args.team = Some(value("--team")?),
            "--until-idle" => args.until_idle = true,
            "--kinds" => args.kinds = Some(value("--kinds")?),
            "--max-seconds" => {
                let raw = value("--max-seconds")?;
                args.max_seconds = Some(raw.parse().map_err(|_| format!("--max-seconds {raw}: a whole number of seconds"))?);
            }
            "--start-timeout" => {
                let raw = value("--start-timeout")?;
                let seconds = raw.parse().map_err(|_| format!("--start-timeout {raw}: a number of seconds"))?;
                args.start_timeout = Some(project::start_timeout_of(seconds, "--start-timeout")?);
            }
            "--project-schema" => args.project_schema = true,
            "-h" | "--help" => args.help = true,
            "-V" | "--version" => args.version = true,
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
    if args.contract_store_slot {
        let project = project::load_project(&args.dir)?;
        let env: Vec<(String, String)> = std::env::vars().collect();
        return contract_store::serve(&backend::StoreSpec::of_command(None, &project, args.team.as_deref(), &env)?).await.map(|()| 0);
    }
    if args.contract_limiter {
        return contract_limiter::serve(std::sync::Arc::new(limiter::MemoryLimiter::default())).await.map(|()| 0);
    }
    if args.contract_limiter_slot {
        let project = project::load_project(&args.dir)?;
        let env: Vec<(String, String)> = std::env::vars().collect();
        return contract_limiter::serve(limiter::of_project(&project, &env)?).await.map(|()| 0);
    }
    if args.contract_doors {
        return contract_doors::serve().await.map(|()| 0);
    }
    let mut out = std::io::stdout().lock();
    if args.version {
        writeln!(out, "lf {}", env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
        return Ok(0);
    }
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
    let load = || -> Result<project::Project, String> {
        let mut project = project::load_project(&args.dir)?;
        if let Some(waited) = args.start_timeout {
            project.start_timeout = waited;
        }
        Ok(project)
    };
    match command.as_str() {
        "init" => init::run(&args.rest.first().map(PathBuf::from).unwrap_or_else(|| args.dir.clone()), &mut out),
        "check" => check::run(&load()?, args.json, &mut out).await,
        "catalog" => match check::open_checking(&load()?).await? {
            check::Opened::Ready(checking) => {
                writeln!(out, "{}", checking.catalog.to_json()).map_err(|e| e.to_string())?;
                Ok(0)
            }
            check::Opened::MissingCredentials(missing) => {
                if args.json {
                    return lfjson::emit(&mut out, &lfjson::missing_doc(&missing), 1);
                }
                for m in &missing {
                    writeln!(out, "{}", check::missing_line(m)).map_err(|e| e.to_string())?;
                }
                Ok(1)
            }
        },
        "upgrade" => upgrade::run(&load()?, upgrade::UpgradeOptions { check_only: args.check_only, all: args.all }, &mut out).await,
        "run" => {
            if let (Some(external), Some(body)) = (&args.webhook, &args.body) {
                let project = load()?;
                let store = store_of(&args, &project)?;
                let session = runs::open_session(project, args.ephemeral, &store).await?;
                let delivery = serve::WebhookFile { external, install: args.install.as_deref(), body, headers: &args.headers };
                return report_runs(&serve::receive_webhook(&session, delivery).await?, args.json, &mut out);
            }
            if let Some(movement) = &args.poll {
                let project = load()?;
                let store = store_of(&args, &project)?;
                let session = runs::open_session(project, args.ephemeral, &store).await?;
                return report_fired(&session.run_poll(movement).await?, args.json, &mut out);
            }
            let Some(event_file) = &args.event else {
                let Some(movement) = args.rest.first() else {
                    eprintln!("lf run needs a movement (run on manual), --event <file>, or --webhook <external> --body <file>");
                    return Ok(2);
                };
                let project = load()?;
                let store = store_of(&args, &project)?;
                let session = runs::open_session(project, args.ephemeral, &store).await?;
                return report_fired(&session.run_manual(movement, None, args.dry_run).await?, args.json, &mut out);
            };
            let project = load()?;
            let store = store_of(&args, &project)?;
            if args.ephemeral && matches!(store, backend::StoreSpec::Postgres { .. }) {
                eprintln!("lf: --ephemeral keeps its run state in a temporary file; it does not take a Postgres --store");
                return Ok(2);
            }
            let session = runs::open_session(project, args.ephemeral, &store).await?;
            let (external, event) = runs::read_event_file(event_file)?;
            report_fired(&session.fire_event(&external, &event, args.dry_run).await?, args.json, &mut out)
        }
        "resume" => {
            let project = load()?;
            let store = store_of(&args, &project)?;
            let session = runs::open_session(project, false, &store).await?;
            let outcomes = match args.rest.first() {
                Some(run_id) => vec![session.resume_run(run_id).await?],
                // A work row that fails is retried later, unlogged.
                None => session.resume_all(&mut std::io::sink()).await?,
            };
            if outcomes.is_empty() && !args.json {
                writeln!(out, "no parked runs").map_err(|e| e.to_string())?;
            }
            report_runs(&outcomes, args.json, &mut out)
        }
        "runs" => {
            let project = load()?;
            let store = backend::open_store(&store_of(&args, &project)?)?;
            if let Some("show") = args.rest.first().map(String::as_str) {
                let Some(run_id) = args.rest.get(1) else {
                    eprintln!("lf runs show needs a run id");
                    return Ok(2);
                };
                let doc = lfjson::run_show_doc(&*store, run_id)?;
                if args.json {
                    return lfjson::emit(&mut out, &doc, 0);
                }
                writeln!(out, "{}", serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                return Ok(0);
            }
            let rows = store.runs(50).map_err(|e| e.to_string())?;
            if args.json {
                return lfjson::emit(&mut out, &lfjson::runs_list_doc(&rows), 0);
            }
            for run in rows {
                writeln!(out, "{} {} {}:{} {}", run.id, run.started_at, run.file, run.movement, run.status).map_err(|e| e.to_string())?;
            }
            Ok(0)
        }
        "drain" => {
            let project = load()?;
            let store = store_of(&args, &project)?;
            let pool = args.kinds.as_deref().map(drain::Pool::of).transpose()?.unwrap_or_default();
            let mut session = runs::open_session(project, false, &store).await?;
            session.pool = pool;
            drain::drain(&session, &drain::DrainOptions { until_idle: args.until_idle, max_seconds: args.max_seconds }, &mut out).await
        }
        "serve" => {
            let project = load()?;
            let store = store_of(&args, &project)?;
            serve::run(project, args.ephemeral, &store, args.port.as_deref()).await
        }
        "call" => {
            let project = load()?;
            let store = store_of(&args, &project)?;
            serve::call_command(project, &store, serve::CallArgs { id: args.rest.first().map(String::as_str), body: args.body.as_deref(), json: args.json }, &mut out).await
        }
        "cancel" => {
            let project = load()?;
            serve::cancel_command(&store_of(&args, &project)?, args.rest.first().map(String::as_str), args.reason.as_deref(), args.json, &mut out).await
        }
        other => {
            eprintln!("unknown command \"{other}\"\n{}", USAGE.replace("{CREDENTIAL_USAGE}", credential_cmd::USAGE));
            Ok(2)
        }
    }
}

fn report_runs(outcomes: &[runs::RunOutcome], json: bool, out: &mut impl Write) -> Result<i32, String> {
    if json { lfjson::emit(out, &lfjson::runs_doc(outcomes, &[]), lfjson::exit_of(outcomes)) } else { runs::report(outcomes, out) }
}

fn report_fired(fired: &runs::Fired, json: bool, out: &mut impl Write) -> Result<i32, String> {
    if json { lfjson::emit(out, &lfjson::fired_doc(fired), lfjson::exit_of(&fired.outcomes)) } else { fired.report(out) }
}

/// Where a command keeps its run state: `--store`, else the store slot's module.
fn store_of(args: &Args, project: &project::Project) -> Result<backend::StoreSpec, String> {
    backend::StoreSpec::of_command(args.store.as_deref(), project, args.team.as_deref(), &connect::process_env())
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let wants_json = argv.iter().any(|a| a == "--json");
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a tokio runtime");
    // A LocalSet, so a listener's connections run as tasks on this one thread.
    let code = match runtime.block_on(tokio::task::LocalSet::new().run_until(run(argv))) {
        Ok(code) => code,
        Err(message) if wants_json => {
            println!("{}", json::Js::Obj(crate::obj! { "error" => json::Js::str(&message) }).to_json());
            1
        }
        Err(message) => {
            eprintln!("lf: {message}");
            1
        }
    };
    drop(runtime);
    std::process::exit(code);
}
