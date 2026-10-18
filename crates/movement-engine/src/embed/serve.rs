//! One request, read into the typed host call it is and answered in the
//! shape its builder (crate::host) documents. The only place the typed
//! route touches the wire.
//!
//! A request is started (its arguments read, its host asked) and later
//! finished (its answer read back for the engine): between the two the
//! call is in flight, alongside whatever else the engine has asked.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;

use serde_json::{Value as Json, json};

use super::Hosts;
use super::data::{Data, FileRef};
use super::hosts::*;
use crate::executor::{Answer, HostError, PendingRequest};

/// What one segment's requests share: the positions it registered by
/// handle, and the failures its answers named (a run that fails on one
/// reports it by its `ref`).
#[derive(Default)]
pub(crate) struct Session {
    positions: BTreeMap<u64, Data>,
    pub(crate) failures: Vec<HostFailure>,
    next_id: u64,
    pub(crate) now: String,
}

type Served = Result<Option<Json>, HostFailure>;

/// A host's answer as it lands. An adapter's own refusal is numbered among
/// the session's failures only when it lands, so it stays whole until then.
pub(crate) enum Reply {
    Json(Option<Json>),
    Adapter(AdapterReply),
}

/// A request in flight.
pub(crate) type Serving = Pin<Box<dyn Future<Output = Result<Reply, HostFailure>>>>;

impl Session {
    pub(crate) fn new(now: String) -> Session {
        Session { now, ..Session::default() }
    }

    /// Ask the host for `request`; its answer is read by [`Session::finish`].
    pub(crate) fn start(&mut self, hosts: &mut Hosts<'_>, request: &PendingRequest) -> Serving {
        let label = format!("{}.{}", request.family, request.method);
        self.route(hosts, &label, &request.args).unwrap_or_else(|failure| Box::pin(std::future::ready(Err(failure))))
    }

    /// The landed answer to a request labelled `label`, for the engine.
    pub(crate) fn finish(&mut self, label: &str, reply: Result<Reply, HostFailure>) -> Answer {
        let served = reply.map(|reply| match reply {
            Reply::Json(value) => value,
            Reply::Adapter(reply) => Some(self.adapter_envelope(reply)),
        });
        match served {
            Ok(value) => Ok(value),
            Err(failure) if failure.is_budget() && PRICED.contains(&label) => Ok(Some(budget_refusal(label, &failure.message))),
            Err(failure) => {
                let mut detail = serde_json::Map::new();
                detail.insert("message".into(), json!(failure.message));
                if let Some(name) = &failure.name {
                    detail.insert("name".into(), json!(name));
                }
                detail.insert("ref".into(), json!(self.failures.len()));
                self.failures.push(failure);
                Err(HostError { detail: Json::Object(detail) })
            }
        }
    }

    fn adapter_envelope(&mut self, reply: AdapterReply) -> Json {
        let mut envelope = match reply.outcome {
            Ok(Some(result)) => json!({ "result": result.to_wire() }),
            Ok(None) => json!({}),
            Err(error) => {
                // Numbered as a host failure is, so a run it ends names it.
                self.failures.push(HostFailure { message: error.message.clone(), name: Some(error.kind.clone()) });
                json!({ "error": { "kind": error.kind, "message": error.message, "ref": self.failures.len() - 1 } })
            }
        };
        if !reply.cost.is_empty() {
            envelope["cost"] = json!(reply.cost);
        }
        envelope
    }

    fn route(&mut self, hosts: &mut Hosts<'_>, label: &str, args: &Json) -> Result<Serving, HostFailure> {
        Ok(match label {
            "adapters.resolve" => {
                let adapters = hosts.adapters.as_deref_mut().ok_or_else(|| unserved_failure(label))?;
                let role = match args.get("role").and_then(Json::as_str) {
                    Some("source") => Role::Source,
                    Some("target") => Role::Target,
                    other => return Err(format!("{label}: role is source or target, not {other:?}").into()),
                };
                let construction_args = args
                    .get("constructionArgs")
                    .and_then(Json::as_object)
                    .map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string())).collect())
                    .unwrap_or_default();
                let instance = adapters.resolve(AdapterRequest {
                    adapter_type: text(args, "adapterType", label)?.to_string(),
                    credentials_id: args.get("credentialsId").and_then(Json::as_str).map(str::to_string),
                    construction_args,
                    role,
                    dry_run: args.get("dryRun") == Some(&json!(true)),
                });
                then(instance, |instance| Ok(Some(json!({ "instance": instance.id, "methods": instance.methods }))))
            }
            "adapters.call" => {
                let adapters = hosts.adapters.as_deref_mut().ok_or_else(|| unserved_failure(label))?;
                let mut call_args = wire(args.get("args"), label)?;
                if let Some(reference) = args.get("positionRef").and_then(Json::as_u64) {
                    if let Some(position) = args.get("position") {
                        self.positions.insert(reference, wire(Some(position), label)?);
                    }
                    let position = self.positions.get(&reference).cloned().ok_or_else(|| HostFailure::new(format!("{label}: position {reference} was never registered")))?;
                    let rest = match call_args {
                        Data::Map(entries) => entries,
                        Data::Null => Vec::new(),
                        other => return Err(format!("{label}: args are an object, not {other:?}").into()),
                    };
                    call_args = Data::Map(std::iter::once(("position".to_string(), position)).chain(rest).collect());
                }
                let reply = adapters.call(AdapterCall { instance: text(args, "instance", label)?.to_string(), method: text(args, "method", label)?.to_string(), args: call_args });
                Box::pin(async move { Ok(Reply::Adapter(reply.await?)) })
            }
            "lookup.resolveActingUser" => {
                let Some(adapters) = hosts.adapters.as_deref_mut() else { return Ok(now(Some(Json::Null))) };
                let event = wire(args.get("event"), label)?;
                let user = adapters.acting_user(text(args, "instance", label)?, &event);
                then(user, |user| {
                    Ok(Some(match user {
                        None => Json::Null,
                        Some(user) => {
                            let mut principal = vec![("id".to_string(), Data::Text(user.id))];
                            if let Some(display) = user.display {
                                principal.push(("display".into(), Data::Text(display)));
                            }
                            let mut out = vec![("principal".to_string(), Data::Map(principal))];
                            if let Some(email) = user.email {
                                out.push(("email".into(), Data::Text(email)));
                            }
                            Data::Map(out).to_wire()
                        }
                    }))
                })
            }
            "llm.client.call" | "llm.extractCall.call" => {
                let models = hosts.models.as_deref_mut().ok_or_else(|| unserved_failure(label))?;
                let prompt = if label == "llm.client.call" {
                    Prompt::Message(text(args, "userMessage", label)?.to_string())
                } else {
                    Prompt::Blocks(args.get("blocks").and_then(Json::as_array).cloned().unwrap_or_default())
                };
                let reply = models.call(ModelCall {
                    system: text(args, "system", label)?.to_string(),
                    prompt,
                    label: text(args, "label", label)?.to_string(),
                    model: text(args, "model", label)?.to_string(),
                    effort: args.get("effort").and_then(Json::as_str).map(str::to_string),
                    max_tokens: args.get("maxTokens").and_then(Json::as_u64),
                    budget: args.get("budget").cloned().unwrap_or(Json::Null),
                });
                then(reply, |reply| {
                    let mut out = vec![("parsedJson".to_string(), reply.parsed_json)];
                    if let Some(raw) = reply.raw_text {
                        out.push(("rawText".into(), Data::Text(raw)));
                    }
                    push_cost(&mut out, &reply.cost);
                    Ok(Some(Data::Map(out).to_wire()))
                })
            }
            "llm.arbitrateEntities" => {
                let judge = hosts.judge.as_deref_mut().ok_or_else(|| unserved_failure(label))?;
                let verdict = judge.arbitrate(Arbitration {
                    asserted: wire(args.get("asserted"), label)?,
                    candidates: wire(args.get("candidates"), label)?,
                    record_type: text(args, "recordType", label)?.to_string(),
                    constraints: wire(args.get("constraints"), label)?,
                    language_version: args.get("languageVersion").and_then(Json::as_u64).unwrap_or(5) as u32,
                    budget: args.get("budget").cloned().unwrap_or(Json::Null),
                });
                then(verdict, |verdict| {
                    // The judge's answer is plain JSON, unlike the other model
                    // families' (crate::host::llm::arbitrate_entities).
                    let mut out = json!({ "index": verdict.index });
                    if let Some(reason) = verdict.judge_unavailable {
                        out["judgeUnavailable"] = json!(reason);
                    }
                    if !verdict.cost.is_empty() {
                        out["cost"] = json!(verdict.cost);
                    }
                    Ok(Some(out))
                })
            }
            "llm.transforms.invoke" => {
                let modules = hosts.modules.as_deref_mut().ok_or_else(|| unserved_failure(label))?;
                let reply = modules.invoke(PluginCall {
                    plugin: text(args, "plugin", label)?.to_string(),
                    config: wire(args.get("config"), label)?,
                    extracted_context: wire(args.get("extractedContext"), label)?,
                    budget: args.get("budget").cloned().unwrap_or(Json::Null),
                });
                then(reply, |reply| {
                    let mut out = Vec::new();
                    if let Some(text) = reply.text {
                        out.push(("text".to_string(), Data::Text(text)));
                    }
                    if let Some(data) = reply.data {
                        out.push(("data".into(), data));
                    }
                    if let Some(records) = reply.records {
                        out.push(("records".into(), Data::List(records)));
                    }
                    if let Some(outcome) = reply.outcome {
                        out.push(("outcome".into(), outcome));
                    }
                    push_cost(&mut out, &reply.cost);
                    Ok(Some(Data::Map(out).to_wire()))
                })
            }
            "files.render" => {
                let files = hosts.files.as_deref_mut().ok_or_else(|| unserved_failure(label))?;
                then(files.render(text(args, "content", label)?, text(args, "type", label)?), |file| Ok(Some(Data::File(file).to_wire())))
            }
            "files.resolveFileText" => {
                let files = hosts.files.as_deref_mut().ok_or_else(|| unserved_failure(label))?;
                let Data::File(file) = wire(args.get("file"), label)? else { return Err(format!("{label}: file is a file the engine holds").into()) };
                let read = files.file_text(&FileRef { id: file.id, descriptor: file.descriptor }, args.get("budget").unwrap_or(&Json::Null));
                then(read, |(answer, cost)| {
                    let mut out = match answer {
                        FileText::Text { text, raw_text_id } => {
                            let mut out = vec![("text".to_string(), Data::Text(text))];
                            if let Some(id) = raw_text_id {
                                out.push(("rawTextId".into(), Data::Text(id)));
                            }
                            out
                        }
                        FileText::Unreadable { detail } => {
                            let mut out = vec![("unreadable".to_string(), Data::Bool(true))];
                            if let Some(detail) = detail {
                                out.push(("detail".into(), Data::Text(detail)));
                            }
                            out
                        }
                    };
                    push_cost(&mut out, &cost);
                    Ok(Some(Data::Map(out).to_wire()))
                })
            }
            "clock.now" => match hosts.clock.as_deref_mut() {
                Some(clock) => then(clock.now_iso(), |now| Ok(Some(json!({ "nowIso": now })))),
                None => now(Some(json!({ "nowIso": self.now }))),
            },
            "ids.mint" => {
                let count = args.get("count").and_then(Json::as_u64).filter(|n| *n >= 1).ok_or_else(|| HostFailure::new(format!("{label}: count is a positive integer")))? as usize;
                match hosts.clock.as_deref_mut() {
                    Some(clock) => then(clock.mint_ids(count), |ids| Ok(Some(json!(ids)))),
                    None => {
                        let ids: Vec<String> = (0..count)
                            .map(|_| {
                                self.next_id += 1;
                                format!("id-{}", self.next_id)
                            })
                            .collect();
                        now(Some(json!(ids)))
                    }
                }
            }
            "trace.append" => {
                let Data::List(entries) = wire(args.get("entries"), label)? else { return Err(format!("{label}: entries are a list").into()) };
                match hosts.trace.as_deref_mut() {
                    Some(trace) => then(trace.append(entries), |()| Ok(None)),
                    None => now(None),
                }
            }
            "log.write" => {
                let Some(trace) = hosts.trace.as_deref_mut() else { return Ok(now(None)) };
                let written: Vec<HostFuture<()>> = args
                    .get("lines")
                    .and_then(Json::as_array)
                    .into_iter()
                    .flatten()
                    .map(|line| {
                        trace.log(LogLine {
                            level: line.get("level").and_then(Json::as_str).unwrap_or("info").to_string(),
                            message: line.get("message").and_then(Json::as_str).unwrap_or_default().to_string(),
                            fields: line.get("fields").cloned().unwrap_or(Json::Null),
                        })
                    })
                    .collect();
                Box::pin(async move {
                    for line in written {
                        line.await?;
                    }
                    Ok(Reply::Json(None))
                })
            }
            // One process running one segment at a time holds a lock as soon
            // as it asks, so a host with no store still serves them.
            "locks.acquire" => {
                let names = texts(args.get("names"), label)?;
                match hosts.store.as_deref_mut() {
                    Some(store) => then(store.acquire_locks(&names), |token| Ok(Some(json!({ "token": token })))),
                    None => now(Some(json!({ "token": names.join(",") }))),
                }
            }
            "locks.release" => match hosts.store.as_deref_mut() {
                Some(store) => then(store.release_locks(text(args, "token", label)?), |()| Ok(None)),
                None => now(None),
            },
            "control.cancel.cancelled" | "control.cancel.cancelledNow" => match hosts.store.as_deref_mut() {
                Some(store) => then(store.cancelled(), |cancelled| Ok(Some(json!(cancelled)))),
                None => now(Some(json!(false))),
            },
            "park.sink.commitTimerPark" => {
                let park = TimerPark { address: text(args, "address", label)?.into(), state: state(args, "state", label)?, wake_at: text(args, "wakeAt", label)?.into() };
                then(store(hosts, label)?.commit_timer_park(park), |()| Ok(None))
            }
            "park.sink.commitAwaitPark" => {
                let park = AwaitPark {
                    address: text(args, "address", label)?.into(),
                    state: state(args, "state", label)?,
                    adapter_type: text(args, "adapterType", label)?.into(),
                    correlation_key: args.get("correlationKey").cloned().unwrap_or(Json::Null),
                };
                then(store(hosts, label)?.commit_await_park(park), |()| Ok(None))
            }
            "park.sink.commitSuspension" => {
                let (address, state) = (text(args, "address", label)?.to_string(), state(args, "state", label)?);
                then(store(hosts, label)?.commit_suspension(&address, state), |()| Ok(None))
            }
            "park.sink.recordJoin" => {
                let count = args.get("parkedChildren").and_then(Json::as_i64).ok_or_else(|| HostFailure::new(format!("{label}: parkedChildren is a count")))?;
                then(store(hosts, label)?.record_join(text(args, "frameAddress", label)?, count), |()| Ok(None))
            }
            "park.sink.decrementJoin" => {
                let closed = store(hosts, label)?.decrement_join(text(args, "frameAddress", label)?, text(args, "branchAddress", label)?, text(args, "leafAddress", label)?);
                then(closed, |closed| Ok(Some(json!({ "closed": closed }))))
            }
            "park.sink.persistBranchExport" => {
                let export = BranchExport {
                    branch_address: text(args, "branchAddress", label)?.into(),
                    branch_index: args.get("branchIndex").and_then(Json::as_i64).ok_or_else(|| HostFailure::new(format!("{label}: branchIndex is an integer")))?,
                    exports: BranchExports(args.get("exports").cloned().unwrap_or(Json::Null)),
                };
                then(store(hosts, label)?.persist_branch_export(text(args, "frameAddress", label)?, export), |()| Ok(None))
            }
            "park.sink.collectBranchExports" => then(store(hosts, label)?.collect_branch_exports(text(args, "frameAddress", label)?), |rows| {
                let rows: Vec<Json> = rows
                    .into_iter()
                    .map(|r| json!(["o", [["branchAddress", r.branch_address], ["branchIndex", r.branch_index], ["exports", r.exports.0]]]))
                    .collect();
                Ok(Some(json!(["l", rows])))
            }),
            "park.sink.cancelSubtrees" => {
                let subtrees = texts(args.get("subtreeAddresses"), label)?;
                then(store(hosts, label)?.cancel_subtrees(&subtrees, args.get("excludeLeaf").and_then(Json::as_str)), |()| Ok(None))
            }
            "park.wake" => {
                let key = args.get("correlationKey").cloned().unwrap_or(Json::Null);
                then(store(hosts, label)?.wake(text(args, "adapterType", label)?, &key), |()| Ok(None))
            }
            "park.callbacks.mint" => {
                let params = args
                    .get("params")
                    .and_then(Json::as_array)
                    .and_then(|list| list.iter().map(|p| Some((p.get("name")?.as_str()?.to_string(), p.get("type")?.as_str()?.to_string()))).collect::<Option<Vec<_>>>())
                    .ok_or_else(|| HostFailure::new(format!("{label}: params are {{name, type}} each")))?;
                let mint = CallbackMint {
                    address: text(args, "address", label)?.into(),
                    params,
                    state: state(args, "state", label)?,
                    single_use: args.get("singleUse").and_then(Json::as_bool).unwrap_or(false),
                    expires_at: args.get("expiresAt").and_then(Json::as_str).map(str::to_string),
                };
                then(store(hosts, label)?.mint_callback(mint), |minted| Ok(Some(json!({ "id": minted.id, "url": minted.url }))))
            }
            "park.callbacks.calls" => {
                let id = args.get("callbackId").cloned().unwrap_or(Json::Null);
                then(store(hosts, label)?.callback_calls(&id), |calls| Ok(Some(calls.to_wire())))
            }
            "park.sources.save" => then(store(hosts, label)?.save_source(text(args, "source", label)?), |hash| Ok(Some(json!({ "hash": hash })))),
            "park.sources.load" => then(store(hosts, label)?.load_source(text(args, "hash", label)?), |source| {
                Ok(Some(match source {
                    Some(source) => json!({ "source": source }),
                    None => json!({}),
                }))
            }),
            other => return Err(unserved_failure(other)),
        })
    }
}

/// An answer the session has in hand already.
fn now(value: Option<Json>) -> Serving {
    Box::pin(std::future::ready(Ok(Reply::Json(value))))
}

/// The host's call, its answer read into the wire's shape as it lands.
fn then<T: 'static>(call: HostFuture<T>, read: impl FnOnce(T) -> Served + 'static) -> Serving {
    Box::pin(async move { read(call.await?).map(Reply::Json) })
}

/// The calls whose answer may be a budget refusal.
const PRICED: [&str; 5] = ["llm.client.call", "llm.extractCall.call", "llm.transforms.invoke", "llm.arbitrateEntities", "files.resolveFileText"];

/// `{error: {kind: "budget", message}}`: plain JSON for the judge, on the
/// eval wire for the rest, as their answers are read.
fn budget_refusal(label: &str, message: &str) -> Json {
    if label == "llm.arbitrateEntities" {
        json!({ "error": { "kind": "budget", "message": message } })
    } else {
        Data::map([("error", Data::map([("kind", Data::text("budget")), ("message", Data::text(message))]))]).to_wire()
    }
}

fn store<'a>(hosts: &'a mut Hosts<'_>, label: &str) -> Result<&'a mut dyn Store, HostFailure> {
    match hosts.store.as_deref_mut() {
        Some(store) => Ok(store),
        None => Err(unserved_failure(label)),
    }
}

fn text<'a>(args: &'a Json, name: &str, label: &str) -> Result<&'a str, HostFailure> {
    args.get(name).and_then(Json::as_str).ok_or_else(|| HostFailure::new(format!("{label}: {name} is a text")))
}

fn texts(value: Option<&Json>, label: &str) -> Result<Vec<String>, HostFailure> {
    value
        .and_then(Json::as_array)
        .and_then(|list| list.iter().map(|n| n.as_str().map(str::to_string)).collect())
        .ok_or_else(|| HostFailure::new(format!("{label}: a list of texts")))
}

fn wire(value: Option<&Json>, label: &str) -> Result<Data, HostFailure> {
    Data::from_wire(value.unwrap_or(&Json::Null)).map_err(|e| HostFailure::new(format!("{label}: {e}")))
}

fn state(args: &Json, name: &str, label: &str) -> Result<ParkedState, HostFailure> {
    args.get(name).cloned().map(ParkedState).ok_or_else(|| HostFailure::new(format!("{label}: no {name}")))
}

fn push_cost(out: &mut Vec<(String, Data)>, cost: &[Cost]) {
    if !cost.is_empty() {
        let lines = cost.iter().map(|c| Data::map([("source", Data::text(c.source.clone())), ("microdollars", Data::Number(c.microdollars))])).collect();
        out.push(("cost".into(), Data::List(lines)));
    }
}
