//! `--json`: each command's document parses and has the keys docs/lf-json.md
//! documents. One project, driven through the real binary.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

struct Project(PathBuf);

impl Project {
    fn new(name: &str) -> Project {
        let root = std::env::temp_dir().join(format!("lf-json-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let made = Command::new(env!("CARGO_BIN_EXE_lf")).arg("init").arg(&root).output().unwrap();
        assert!(made.status.success());
        std::fs::write(
            root.join("movements/nap.mvt"),
            "function nap(run: <manual-[:Invocation]->>) {\n  await sleep(1h)\n  return \"rested\"\n}\n\nlisten to manual fire nap\n",
        )
        .unwrap();
        Project(root)
    }

    /// The command's stdout as JSON, and its exit code.
    fn lf(&self, args: &[&str]) -> (Value, i32) {
        let out = Command::new(env!("CARGO_BIN_EXE_lf")).args(args).arg("--json").arg(format!("--dir={}", self.0.display())).current_dir(&self.0).output().unwrap();
        let text = String::from_utf8(out.stdout).unwrap();
        let doc = serde_json::from_str(&text).unwrap_or_else(|e| panic!("lf {args:?}: not JSON ({e}): {text}"));
        (doc, out.status.code().unwrap())
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

fn has(doc: &Value, keys: &[&str]) {
    for key in keys {
        assert!(doc.get(key).is_some(), "missing \"{key}\" in {doc}");
    }
}

const OUTCOME_KEYS: &[&str] = &["runId", "file", "movement", "entry", "status", "writes", "dryRunWrites", "traceEntries", "error"];

fn first_run(doc: &Value) -> &Value {
    let run = &doc["runs"][0];
    has(run, OUTCOME_KEYS);
    run
}

#[test]
fn check_lists_diagnostics_with_code_severity_file_span_message_and_fixes() {
    let project = Project::new("check");
    let (clean, code) = project.lf(&["check"]);
    has(&clean, &["ok", "files", "errors", "diagnostics"]);
    assert_eq!((clean["ok"].clone(), code), (Value::Bool(true), 0));

    std::fs::write(project.0.join("movements/broken.mvt"), "function broken( {\n").unwrap();
    let (broken, code) = project.lf(&["check"]);
    assert_eq!((broken["ok"].clone(), code), (Value::Bool(false), 1));
    let diagnostic = &broken["diagnostics"][0];
    has(diagnostic, &["code", "severity", "file", "span", "message", "fixes"]);
    has(&diagnostic["span"], &["line", "column", "endLine", "endColumn"]);
    assert_eq!(diagnostic["code"], "MOV_PARSE");
}

#[test]
fn catalog_is_the_snapshot() {
    let (catalog, _) = Project::new("catalog").lf(&["catalog"]);
    has(&catalog, &["contractVersion", "adapters"]);
}

#[test]
fn a_run_is_driven_listed_shown_resumed_and_cancelled() {
    let project = Project::new("runs");

    let (empty, _) = project.lf(&["runs"]);
    assert_eq!(empty["runs"].as_array().unwrap().len(), 0);

    let (done, code) = project.lf(&["run", "hello"]);
    has(&done, &["ok", "runs", "redelivered"]);
    assert_eq!((first_run(&done)["status"].clone(), code), ("completed".into(), 0));

    let (parked, _) = project.lf(&["run", "nap"]);
    let run = first_run(&parked);
    assert_eq!(run["status"], "parked");
    let run_id = run["runId"].as_str().unwrap().to_string();

    let (listed, _) = project.lf(&["runs"]);
    assert_eq!(listed["runs"].as_array().unwrap().len(), 2);
    has(&listed["runs"][0], &["runId", "file", "movement", "status", "startedAt"]);

    let (shown, _) = project.lf(&["runs", "show", &run_id]);
    let shown = &shown["run"];
    has(shown, &["runId", "file", "movement", "status", "startedAt", "firedAt", "languageVersion", "event", "writes", "error", "outcome", "costMicrodollars", "traceEntries", "trace", "parked", "cancelRequested", "cancelReason"]);
    assert_eq!(shown["parked"][0]["reason"], "timer");
    has(&shown["parked"][0], &["address", "reason", "wakeAt"]);

    let (second, _) = project.lf(&["run", "nap"]);
    let second_id = first_run(&second)["runId"].as_str().unwrap().to_string();

    let (resumed, _) = project.lf(&["resume", &run_id]);
    assert_eq!(first_run(&resumed)["runId"], run_id.as_str());
    let (cancelled, code) = project.lf(&["cancel", &second_id]);
    has(&cancelled, &["ok", "runId", "result"]);
    assert_eq!((cancelled["result"].clone(), code), ("cancelled".into(), 0));

    let (all, _) = project.lf(&["resume"]);
    has(&all, &["ok", "runs", "redelivered"]);

    let (missing, code) = project.lf(&["runs", "show", "no-such-run"]);
    assert_eq!((missing["error"].is_string(), code), (true, 1));
}

#[test]
fn call_reports_its_result() {
    let (called, code) = Project::new("call").lf(&["call", "no-such-callback"]);
    has(&called, &["ok", "callback", "result", "message", "queued", "runs"]);
    assert_eq!((called["result"].clone(), code), ("notFound".into(), 1));
}

#[test]
fn event_and_poll_runs_report_their_outcomes_or_an_error() {
    let project = Project::new("event");
    let event: &Path = &project.0.join("event.json");
    std::fs::write(event, r#"{"external":"manual","event":{"payload":{}}}"#).unwrap();
    let (fired, _) = project.lf(&["run", "--event", event.to_str().unwrap()]);
    has(&fired, &["ok", "runs", "redelivered"]);
    let (polled, code) = project.lf(&["run", "--poll", "hello"]);
    assert_eq!((polled["error"].is_string(), code), (true, 1));
}

#[test]
fn connect_and_credential_list_name_things_and_never_values() {
    let project = Project::new("connect");
    let (modules, _) = project.lf(&["connect"]);
    let module = &modules["modules"][0];
    has(module, &["name", "kind", "state"]);
    let (credentials, _) = project.lf(&["credential", "list"]);
    assert!(credentials["credentials"].is_array());

    std::fs::write(project.0.join(".lf/secrets.yaml"), "acme:\n  module: acme\n  credential: login\n  token: s3cret\n  expires_at: 2030-01-01T00:00:00Z\n").unwrap();
    let (listed, _) = project.lf(&["credential", "list"]);
    let credential = &listed["credentials"][0];
    has(credential, &["name", "module", "binding", "declaredCredential", "kept", "expiresAt"]);
    assert!(!listed.to_string().contains("s3cret"));
}
