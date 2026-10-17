//! `lf-host serve`: the inbound doors and the work queue, as `lf serve` has
//! them (apps/cli/src/serve.ts). A provider's delivery at
//! `/api/public/webhook-sync/<provider>/<install>` is verified and read by
//! its external and its events queued, `/hooks/<external>/<install>` being
//! lf's older name for the same door; an external's pushes arrive at
//! `/api/public/adapter/<external>/{emit,wake}` and are queued; a callback's
//! call arrives at `/api/cb/<id>` (its url) and runs its body; a provider's
//! OAuth redirect for `lf credential add --public` arrives at GET
//! `/oauth/callback`; an exposed file is fetched at GET `/files/<id>`. Due
//! work — an emitted event, a parked run's timer, a queued await wake, a
//! call's body — is drained on a tick, and at once when a door queues some.
//!
//! The server listens before the session opens, so the externals the session
//! starts are told where to push (LF_HOST_URL). Also here: `lf call`,
//! `lf cancel` and `lf run --webhook`, the other ways in.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::OnceLock;
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::sync::Notify;

use crate::callbacks::CallOutcome;
use crate::doors::{EventSink, LfDoors, Webhook, deliver_inline, hook_target};
use crate::http::{Request, Response, decode_component, query_pairs};
use crate::inbound::{Answer, Delivery, InboundStore, Push, PushStore, answer_delivery, answer_push};
use crate::json::{Js, Obj};
use crate::obj;
use crate::project::Project;
use crate::backend::{StoreSpec, open_store};
use crate::runs::{Called, Cancelled, DEFAULT_PORT, RunOutcome, Session, WORK_ROWS_PER_DRAIN, cancel_run, open_session, report};

/// The largest body a door reads; a larger batch is split by its sender.
pub const MAX_BODY_BYTES: usize = 1024 * 1024;
/// The webhook door's own limit, the hosted door's: a delivery is a
/// notification, and a provider's bigger one carries ids to pull.
const MAX_DELIVERY_BYTES: usize = 100 * 1024;
/// How often due work is drained when nothing pokes it.
const TICK: Duration = Duration::from_millis(1000);
/// Where a provider's OAuth redirect for `lf credential add --public` lands.
const PUBLIC_CALLBACK_PATH: &str = "/oauth/callback";

/// Where this process serves, once `serve` listens: every external started
/// after it is told (LF_HOST_URL), and a callback's url falls back to it.
static HOST_URL: OnceLock<String> = OnceLock::new();

pub fn host_url() -> Option<&'static str> {
    HOST_URL.get().map(String::as_str)
}

/// `lf serve [--port N]`: until SIGINT or SIGTERM.
pub async fn run(project: Project, ephemeral: bool, store: &StoreSpec, port: Option<&str>) -> Result<i32, String> {
    let port = match port {
        None => DEFAULT_PORT,
        Some(text) => text.trim().parse::<u16>().map_err(|_| format!("--port {text}: expected a port number"))?,
    };
    let listener = TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| format!("127.0.0.1:{port}: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let _ = HOST_URL.set(format!("http://127.0.0.1:{port}"));
    let session = Rc::new(open_session(project, ephemeral, store).await?);
    // A file exposed to an external is fetched from this listener.
    session.documents.serve_at(port);
    let poke = Rc::new(Notify::new());

    let doors = {
        let (session, poke) = (session.clone(), poke.clone());
        tokio::task::spawn_local(crate::http::serve(listener, MAX_BODY_BYTES, move |request| {
            let (session, poke) = (session.clone(), poke.clone());
            async move { route(&session, &poke, request).await.unwrap_or_else(|message| Response::json(500, &Js::Obj(obj! { "error" => Js::Str(message) }))) }
        }))
    };
    let drain = tokio::task::spawn_local(drain_forever(session.clone(), poke.clone()));
    println!("lf serving on http://127.0.0.1:{port}/hooks/<external>/<install>");

    stopped().await;
    for task in [doors, drain] {
        task.abort();
        let _ = task.await;
    }
    // The last holder: the session goes, and its externals with it.
    drop(session);
    Ok(0)
}

#[cfg(unix)]
async fn stopped() {
    use tokio::signal::unix::{SignalKind, signal};
    match signal(SignalKind::terminate()) {
        Ok(mut term) => {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
        }
        Err(_) => {
            let _ = tokio::signal::ctrl_c().await;
        }
    }
}

#[cfg(not(unix))]
async fn stopped() {
    let _ = tokio::signal::ctrl_c().await;
}

/// The drain: one pass at a time in this process (the run lease keeps any
/// other lf process from stepping the same run meanwhile); a poke while a
/// pass runs is one more pass after it.
async fn drain_forever(session: Rc<Session>, poke: Rc<Notify>) {
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = tick.tick() => {}
            () = poke.notified() => {}
        }
        match session.drain_work(WORK_ROWS_PER_DRAIN, &mut std::io::stdout()).await {
            Ok((_, outcomes)) => log_runs(&outcomes),
            Err(message) => println!("drain failed: {message}"),
        }
    }
}

/// Each run an entry stepped, as `lf serve` logs it.
fn log_runs(outcomes: &[RunOutcome]) {
    let mut out = std::io::stdout();
    for o in outcomes {
        let verb = if o.entry == "fired" { "run" } else { o.entry };
        let error = o.error.as_ref().map(|e| format!(" — {e}")).unwrap_or_default();
        let _ = writeln!(out, "{verb} {} {}:{} {}{error}", o.run_id, o.file, o.movement, o.status);
    }
}

/// An outcome as the `/hooks` answer lists it.
fn outcome_js(o: &RunOutcome) -> Js {
    let mut out = obj! {
        "runId" => Js::str(&o.run_id),
        "file" => Js::str(&o.file),
        "movement" => Js::str(&o.movement),
        "entry" => Js::str(o.entry),
        "status" => Js::str(&o.status),
        "writes" => Js::Num((o.writes as u64).into()),
    };
    if let Some(captured) = &o.captured {
        out.insert("captured".into(), Js::Arr(captured.clone()));
    }
    out.insert("traceEntries".into(), Js::Num(o.trace_entries.into()));
    if let Some(error) = &o.error {
        out.insert("error".into(), Js::str(error));
    }
    Js::Obj(out)
}

fn not_found() -> Response {
    Response::json(404, &Js::Obj(obj! { "error" => Js::str("not found") }))
}

/// The path's segments after `prefix` (an optional trailing `/`), each
/// non-empty; None when the path is not under it.
fn segments<'p>(path: &'p str, prefix: &str) -> Option<Vec<&'p str>> {
    let rest = path.strip_prefix(prefix)?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let parts: Vec<&str> = rest.split('/').collect();
    parts.iter().all(|p| !p.is_empty()).then_some(parts)
}

fn decoded(segment: &str) -> Result<String, String> {
    decode_component(segment).ok_or_else(|| "URI malformed".to_string())
}

/// The answer, with the drain poked once it is composed when it asks.
fn send(answer: Answer, notify: impl FnOnce()) -> Response {
    let response = Response::json(answer.status, &answer.body);
    if answer.notify_after {
        notify();
    }
    response
}

async fn route(session: &Session, poke: &Notify, request: Request) -> Result<Response, String> {
    if request.too_large {
        return Ok(Response::json(413, &Js::Obj(obj! { "error" => Js::str("payload_too_large") })));
    }
    if request.method == "GET" {
        if request.path == PUBLIC_CALLBACK_PATH {
            let (status, text) = crate::oauth_redirect::deliver_public_redirect(&session.project.lf_dir, &request.query);
            return Ok(Response::text(status, &text));
        }
        if let Some([id]) = segments(&request.path, "/files/").as_deref() {
            return Ok(match session.documents.exposed(id) {
                Some(bytes) => Response::bytes(200, bytes),
                None => Response::bytes(404, Vec::new()),
            });
        }
        return Ok(not_found());
    }
    if request.method != "POST" {
        return Ok(not_found());
    }

    if let Some([id]) = segments(&request.path, "/api/cb/").as_deref() {
        return callback_door(session, poke, &decoded(id)?, &request).await;
    }

    let notify = || poke.notify_one();
    let doors = LfDoors::of_session(session, EventSink::Queue, &notify);
    if let Some(response) = doors_route(&doors, &request).await? {
        return Ok(response);
    }

    // lf's older name for the delivery door. Its events run inside the
    // request and the answer lists the runs, as it always has.
    let Some(hook) = segments(&request.path, "/hooks/").filter(|s| s.len() <= 2) else { return Ok(not_found()) };
    let external = decoded(hook[0])?;
    let install = hook.get(1).map(|i| decoded(i)).transpose()?;
    let Some((provider, subscription_id)) = hook_target(session, &external, install.as_deref()) else {
        return Ok(Response::json(404, &Js::Obj(obj! { "error" => Js::str("unknown_provider") })));
    };
    let delivery = Delivery { provider: &provider, subscription_id: &subscription_id, raw_body: &request.body, headers: &request.headers };
    let (answer, outcomes) = deliver_inline(session, delivery, &notify).await;
    log_runs(&outcomes);
    if answer.status != 200 {
        return Ok(send(answer, notify));
    }
    // A delivery may have queued wakes.
    poke.notify_one();
    Ok(Response::json(202, &Js::Obj(obj! { "runs" => Js::Arr(outcomes.iter().map(outcome_js).collect()) })))
}

/// The webhook door and the push doors, over any host's stores: `lf serve`'s,
/// and the inbound contract suite's bridge (crate::contract_doors). None for
/// a path that is neither.
pub async fn doors_route<S: InboundStore + PushStore>(stores: &S, request: &Request) -> Result<Option<Response>, String> {
    if let Some([external, verb]) = segments(&request.path, "/api/public/adapter/").as_deref() {
        let push = match *verb {
            "emit" => Push::Emit,
            "wake" => Push::Wake,
            _ => return Ok(None),
        };
        let answer = answer_push(stores, push, &decoded(external)?, &request.headers, &request.body).await;
        return Ok(Some(Response::json(answer.status, &answer.body)));
    }
    if let Some([provider, install]) = segments(&request.path, "/api/public/webhook-sync/").as_deref() {
        if request.body.len() > MAX_DELIVERY_BYTES {
            return Ok(Some(send(Answer::payload_too_large(), || {})));
        }
        let (provider, install) = (decoded(provider)?, decoded(install)?);
        let delivery = Delivery { provider: &provider, subscription_id: &install, raw_body: &request.body, headers: &request.headers };
        return Ok(Some(send(answer_delivery(stores, delivery).await, || InboundStore::notify(stores))));
    }
    Ok(None)
}

/// A listener that has only the doors (the inbound contract suite's bridge):
/// the body limits, the two doors, and 404 for anything else.
pub async fn only_doors<S: InboundStore + PushStore>(stores: &S, request: Request) -> Response {
    if request.too_large {
        return Response::json(413, &Js::Obj(obj! { "error" => Js::str("payload_too_large") }));
    }
    if request.method != "POST" {
        return not_found();
    }
    match doors_route(stores, &request).await {
        Ok(Some(response)) => response,
        Ok(None) => not_found(),
        Err(message) => Response::json(500, &Js::Obj(obj! { "error" => Js::Str(message) })),
    }
}

// ── The callback door ───────────────────────────────────────────────────────

/// `POST /api/cb/<id>`: the call's values are the JSON body's keys over the
/// query string's, every key passed raw (the callback's signature judges them).
async fn callback_door(session: &Session, poke: &Notify, id: &str, request: &Request) -> Result<Response, String> {
    let Some(values) = call_values(&request.body, &request.query) else {
        return Ok(Response::json(400, &Js::Obj(obj! { "outcome" => Js::str("mismatch"), "message" => Js::str("the body is not a JSON object of values") })));
    };
    let called = session.call_callback(id, &values).await?;
    log_runs(&called.outcomes);
    let (status, message) = call_answer(&called);
    // A queued body, and the wake backstop, are drained work.
    poke.notify_one();
    Ok(Response::json(status, &Js::Obj(obj! { "outcome" => Js::str(called.call.kind()), "message" => Js::Str(message) })))
}

fn call_values(raw_body: &[u8], query: &str) -> Option<Obj> {
    let mut values: Obj = query_pairs(query).into_iter().map(|(k, v)| (k, Js::Str(v))).collect();
    if raw_body.is_empty() {
        return Some(values);
    }
    let Ok(Js::Obj(body)) = Js::parse(raw_body) else { return None };
    values.extend(body);
    Some(values)
}

/// The door's answer, as the hosted door gives it.
fn call_answer(called: &Called) -> (u16, String) {
    match &called.call {
        CallOutcome::Recorded { .. } => (if called.queued { 202 } else { 200 }, "recorded; the run is carrying on".into()),
        CallOutcome::NotFound => (404, "no such callback".into()),
        CallOutcome::Closed => (410, "this callback is closed: it was already used, or its run has finished".into()),
        CallOutcome::Expired => (410, "this callback has expired".into()),
        CallOutcome::Mismatch(message) => (400, message.clone()),
    }
}

// ── A provider's OAuth redirect ─────────────────────────────────────────────

// ── The other ways in: lf call, lf cancel, lf run --webhook ─────────────────

/// `lf call <callback-id> [--body <values.json>]`.
pub async fn call_command(project: Project, store: &StoreSpec, id: Option<&str>, body: Option<&Path>, out: &mut impl Write) -> Result<i32, String> {
    let io = |e: std::io::Error| e.to_string();
    let Some(id) = id else {
        eprintln!("lf call needs a callback id");
        return Ok(2);
    };
    let supplied = match body {
        None => Js::Obj(Obj::new()),
        Some(path) => Js::parse(&std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?)?,
    };
    let Js::Obj(values) = supplied else {
        eprintln!("lf call --body: the file must hold a JSON object of values");
        return Ok(2);
    };
    let session = open_session(project, false, store).await?;
    let called = session.call_callback(id, &values).await?;
    match &called.call {
        CallOutcome::Recorded { .. } => {
            if called.queued {
                writeln!(out, "callback {id}: recorded; its run is being stepped by another lf process, which runs the body next").map_err(io)?;
            } else {
                writeln!(out, "callback {id}: recorded").map_err(io)?;
            }
            if called.outcomes.is_empty() { Ok(0) } else { report(&called.outcomes, out) }
        }
        CallOutcome::Mismatch(message) => {
            writeln!(out, "callback {id}: refused — {message}").map_err(io)?;
            Ok(1)
        }
        CallOutcome::NotFound => {
            writeln!(out, "callback {id}: no such callback").map_err(io)?;
            Ok(1)
        }
        CallOutcome::Closed => {
            writeln!(out, "callback {id}: closed — it was already used, or its run has finished").map_err(io)?;
            Ok(1)
        }
        CallOutcome::Expired => {
            writeln!(out, "callback {id}: expired").map_err(io)?;
            Ok(1)
        }
    }
}

/// `lf cancel <run-id> [--reason <text>]`. Settling a run starts no segment:
/// no externals, just the store.
pub async fn cancel_command(store: &StoreSpec, run_id: Option<&str>, reason: Option<&str>, out: &mut impl Write) -> Result<i32, String> {
    let Some(run_id) = run_id else {
        eprintln!("lf cancel needs a run id");
        return Ok(2);
    };
    let store = open_store(store)?;
    let line = match cancel_run(&*store, run_id, reason).await? {
        Cancelled::Now => format!("run {run_id} cancelled"),
        Cancelled::Requested => format!("run {run_id}: cancel requested; another lf process is stepping it, and it stops at its next statement"),
    };
    writeln!(out, "{line}").map_err(|e| e.to_string())?;
    Ok(0)
}

/// `lf run --webhook <external> --body <file> [--install <credential>] [--header k:v]…`.
pub struct WebhookFile<'a> {
    pub external: &'a str,
    pub install: Option<&'a str>,
    pub body: &'a PathBuf,
    /// `name:value` each.
    pub headers: &'a [String],
}

pub async fn receive_webhook(session: &Session, file: WebhookFile<'_>) -> Result<Vec<RunOutcome>, String> {
    let raw_body = std::fs::read(file.body).map_err(|e| format!("{}: {e}", file.body.display()))?;
    let headers = file
        .headers
        .iter()
        .map(|pair| match pair.find(':').filter(|at| *at > 0) {
            Some(at) => Ok((pair[..at].trim().to_lowercase(), pair[at + 1..].trim().to_string())),
            None => Err(format!("--header {pair}: expected name:value")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    crate::doors::receive_webhook(session, Webhook { external: file.external, install: file.install, raw_body: &raw_body, headers: &headers }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_matches_its_door_with_an_optional_trailing_slash() {
        assert_eq!(segments("/api/cb/cb_1", "/api/cb/"), Some(vec!["cb_1"]));
        assert_eq!(segments("/api/cb/cb_1/", "/api/cb/"), Some(vec!["cb_1"]));
        assert_eq!(segments("/api/cb/", "/api/cb/"), None);
        assert_eq!(segments("/hooks/acme//x", "/hooks/"), None);
        assert_eq!(segments("/hooks/acme/x", "/hooks/"), Some(vec!["acme", "x"]));
    }

    #[test]
    fn a_calls_values_are_the_bodys_over_the_querys() {
        let values = call_values(br#"{"note":"body"}"#, "note=query&other=1").unwrap();
        assert_eq!(Js::Obj(values).to_json(), r#"{"note":"body","other":"1"}"#);
        assert!(call_values(b"[1]", "").is_none());
        assert!(call_values(b"not json", "").is_none());
        assert_eq!(call_values(b"", "a=b").map(|v| Js::Obj(v).to_json()).as_deref(), Some(r#"{"a":"b"}"#));
    }
}
