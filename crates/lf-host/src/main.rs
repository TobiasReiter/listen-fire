//! `lf-host` — the local run host as one Rust binary, growing toward the sole
//! `lf` (plans/cloud-native-2026-10-06/22_everywhere_plan.md #7). Named
//! `lf-host` until it replaces the TypeScript `lf` (apps/cli), whose commands,
//! project format, state file and output it keeps.
//!
//!   lf-host check [--dir <project>]          the TypeScript `lf check`
//!   lf-host run --event <file> [--dry-run]   route an event to its listens and run each
//!   lf-host resume [<run-id>]                step a parked run, or drain due work and every parked run
//!   lf-host runs                             the runs, most recent first
//!   lf-host catalog [--dir <project>]        the catalog snapshot `check` reads, as JSON
//!   lf-host --contract-store <state.db>      the run host's backend over stdio JSON-RPC
//!   lf-host --project-schema                 one schema projection, stdin to stdout (a parity probe)
//!
//! Single-threaded: one tokio thread, every wait an await.

mod callbacks;
mod catalog;
mod check;
mod contract_store;
mod documents;
mod externals;
mod file_ref;
mod json;
mod park_files;
mod project;
mod protocol;
mod remote;
mod routing;
mod run_host;
mod runs;
mod schema;
mod secrets;
mod segment;
mod sources;
mod store;
mod wire;
mod wire_results;

use std::io::Write;
use std::path::PathBuf;

const USAGE: &str = "usage: lf-host <check|catalog|run|resume|runs> [--dir <project folder>] [--ephemeral]
       lf-host run --event <file.json> [--dry-run]
       lf-host resume [<run-id>]
       lf-host --contract-store <state.db>
       lf-host --project-schema
  check     every diagnostic the project's movement files have (as `lf check`)
  catalog   the catalog snapshot the files are checked against, as JSON
  run       route the event file's event to the listens it matches and run each (as `lf run --event`)
  resume    step every parked leaf of one run, or drain due work and every parked run (as `lf resume`)
  runs      the runs in the state file, most recent first (as `lf runs`)
  --contract-store  serve the run host's backend over stdin/stdout JSON-RPC (the contract suite's bridge)
  --project-schema  project one adapter introspection (JSON on stdin) into its schema and notes (the projection's parity probe)
not yet here (the TypeScript lf has them): init, upgrade, serve, call, cancel, run --webhook";

/// The commands the TypeScript lf has that this binary does not yet.
const NOT_YET: &[&str] = &["init", "upgrade", "serve", "call", "cancel"];

struct Args {
    command: Option<String>,
    /// Positionals after the command (`resume <run-id>`).
    rest: Vec<String>,
    dir: PathBuf,
    ephemeral: bool,
    dry_run: bool,
    event: Option<PathBuf>,
    webhook: Option<String>,
    contract_store: Option<PathBuf>,
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
        contract_store: None,
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
            "--ephemeral" => args.ephemeral = true,
            "--dry-run" => args.dry_run = true,
            "--contract-store" => args.contract_store = Some(PathBuf::from(value("--contract-store")?)),
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
    let args = parse_args(&argv)?;
    if let Some(path) = args.contract_store {
        return contract_store::serve(&path).await.map(|()| 0);
    }
    let mut out = std::io::stdout().lock();
    if args.project_schema {
        let mut input = Vec::new();
        std::io::Read::read_to_end(&mut std::io::stdin(), &mut input).map_err(|e| e.to_string())?;
        writeln!(out, "{}", schema::probe(&json::Js::parse(&input)?)?.to_json()).map_err(|e| e.to_string())?;
        return Ok(0);
    }
    let Some(command) = args.command.filter(|_| !args.help) else {
        writeln!(out, "{USAGE}").map_err(|e| e.to_string())?;
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
        "run" => {
            if args.webhook.is_some() {
                eprintln!("lf-host: `run --webhook` is not in lf-host yet; use the TypeScript lf for it");
                return Ok(2);
            }
            let Some(event_file) = &args.event else {
                eprintln!("lf run needs --event <file> or --webhook <external> --body <file>");
                return Ok(2);
            };
            let session = runs::open_session(project::load_project(&args.dir)?, args.ephemeral).await?;
            let (external, event) = runs::read_event_file(event_file)?;
            let outcomes = session.fire_event(&external, &event, args.dry_run).await?;
            runs::report(&outcomes, &mut out)
        }
        "resume" => {
            let session = runs::open_session(project::load_project(&args.dir)?, false).await?;
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
            let store = store::Store::open(&project.lf_dir.join("state.db")).map_err(|e| e.to_string())?;
            for run in store.runs(50).map_err(|e| e.to_string())? {
                writeln!(out, "{} {} {}:{} {}", run.id, run.started_at, run.file, run.movement, run.status).map_err(|e| e.to_string())?;
            }
            Ok(0)
        }
        other if NOT_YET.contains(&other) => {
            eprintln!("lf-host: `{other}` is not in lf-host yet; use the TypeScript lf for it");
            Ok(2)
        }
        other => {
            eprintln!("unknown command \"{other}\"\n{USAGE}");
            Ok(2)
        }
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a tokio runtime");
    let code = match runtime.block_on(run(argv)) {
        Ok(code) => code,
        Err(message) => {
            eprintln!("lf-host: {message}");
            1
        }
    };
    drop(runtime);
    std::process::exit(code);
}
