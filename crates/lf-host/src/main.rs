//! `lf-host` — the local run host as one Rust binary, growing toward the sole
//! `lf` (plans/cloud-native-2026-10-06/22_everywhere_plan.md #7). Named
//! `lf-host` until it replaces the TypeScript `lf` (apps/cli), whose commands,
//! project format, state file and output it keeps.
//!
//!   lf-host check [--dir <project>]          the TypeScript `lf check`
//!   lf-host catalog [--dir <project>]        the catalog snapshot `check` reads, as JSON
//!   lf-host --contract-store <state.db>      the run host's backend over stdio JSON-RPC
//!   lf-host --project-schema                 one schema projection, stdin to stdout (a parity probe)
//!
//! Single-threaded: one tokio thread, every wait an await.

mod catalog;
mod check;
mod contract_store;
mod externals;
mod json;
mod project;
mod protocol;
mod schema;
mod secrets;
mod sources;
mod store;

use std::io::Write;
use std::path::PathBuf;

const USAGE: &str = "usage: lf-host <check|catalog> [--dir <project folder>]
       lf-host --contract-store <state.db>
       lf-host --project-schema
  check     every diagnostic the project's movement files have (as `lf check`)
  catalog   the catalog snapshot the files are checked against, as JSON
  --contract-store  serve the run host's backend over stdin/stdout JSON-RPC (the contract suite's bridge)
  --project-schema  project one adapter introspection (JSON on stdin) into its schema and notes (the projection's parity probe)
not yet here (the TypeScript lf has them): init, upgrade, run, resume, serve, runs";

/// The commands the TypeScript lf has that this binary does not yet.
const NOT_YET: &[&str] = &["init", "upgrade", "run", "resume", "serve", "runs"];

struct Args {
    command: Option<String>,
    dir: PathBuf,
    contract_store: Option<PathBuf>,
    project_schema: bool,
    help: bool,
}

fn parse_args(argv: &[String]) -> Result<Args, String> {
    let mut args = Args {
        command: None,
        dir: std::env::current_dir().map_err(|e| e.to_string())?,
        contract_store: None,
        project_schema: false,
        help: false,
    };
    let mut rest = argv.iter();
    while let Some(arg) = rest.next() {
        let mut value = |name: &str| rest.next().cloned().ok_or_else(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--dir" => args.dir = PathBuf::from(value("--dir")?),
            "--contract-store" => args.contract_store = Some(PathBuf::from(value("--contract-store")?)),
            "--project-schema" => args.project_schema = true,
            "-h" | "--help" => args.help = true,
            flag if flag.starts_with("--dir=") => args.dir = PathBuf::from(&flag["--dir=".len()..]),
            flag if flag.starts_with('-') => return Err(format!("unknown option \"{flag}\"")),
            positional if args.command.is_none() => args.command = Some(positional.to_string()),
            extra => return Err(format!("unexpected argument \"{extra}\"")),
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
