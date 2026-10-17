//! One request, read into the typed host call it is and answered in the
//! shape its builder (crate::host) documents. The only place the typed
//! route touches the wire.

use std::collections::BTreeMap;

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

impl Session {
    pub(crate) fn new(now: String) -> Session {
        Session { now, ..Session::default() }
    }

    pub(crate) fn serve(&mut self, hosts: &mut Hosts<'_>, request: &PendingRequest) -> Answer {
        let label = format!("{}.{}", request.family, request.method);
        match self.route(hosts, &label, &request.args) {
            Ok(value) => Ok(value),
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

    fn route(&mut self, hosts: &mut Hosts<'_>, label: &str, args: &Json) -> Served {
        match label {
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
                })?;
                Ok(Some(json!({ "instance": instance.id, "methods": instance.methods })))
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
                let reply = adapters.call(AdapterCall { instance: text(args, "instance", label)?.to_string(), method: text(args, "method", label)?.to_string(), args: call_args })?;
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
                Ok(Some(envelope))
            }
            "lookup.resolveActingUser" => {
                let Some(adapters) = hosts.adapters.as_deref_mut() else { return Ok(Some(Json::Null)) };
                let event = wire(args.get("event"), label)?;
                let user = adapters.acting_user(text(args, "instance", label)?, &event)?;
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
                })?;
                let mut out = vec![("parsedJson".to_string(), reply.parsed_json)];
                if let Some(raw) = reply.raw_text {
                    out.push(("rawText".into(), Data::Text(raw)));
                }
                push_cost(&mut out, &reply.cost);
                Ok(Some(Data::Map(out).to_wire()))
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
                })?;
                let mut out = vec![("index".to_string(), verdict.index.map_or(Data::Null, |i| Data::Number(i as f64)))];
                if verdict.judge_unavailable {
                    out.push(("judgeUnavailable".into(), Data::Bool(true)));
                }
                push_cost(&mut out, &verdict.cost);
                Ok(Some(Data::Map(out).to_wire()))
            }
            "llm.transforms.invoke" => {
                let modules = hosts.modules.as_deref_mut().ok_or_else(|| unserved_failure(label))?;
                let reply = modules.invoke(PluginCall {
                    plugin: text(args, "plugin", label)?.to_string(),
                    config: wire(args.get("config"), label)?,
                    extracted_context: wire(args.get("extractedContext"), label)?,
                    budget: args.get("budget").cloned().unwrap_or(Json::Null),
                })?;
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
            }
            "files.render" => {
                let files = hosts.files.as_deref_mut().ok_or_else(|| unserved_failure(label))?;
                let file = files.render(text(args, "content", label)?, text(args, "type", label)?)?;
                Ok(Some(Data::File(file).to_wire()))
            }
            "files.resolveFileText" => {
                let files = hosts.files.as_deref_mut().ok_or_else(|| unserved_failure(label))?;
                let Data::File(file) = wire(args.get("file"), label)? else { return Err(format!("{label}: file is a file the engine holds").into()) };
                let (answer, cost) = files.file_text(&FileRef { id: file.id, descriptor: file.descriptor }, args.get("budget").unwrap_or(&Json::Null))?;
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
            }
            "clock.now" => Ok(Some(json!({ "nowIso": match hosts.clock.as_deref_mut() {
                Some(clock) => clock.now_iso(),
                None => self.now.clone(),
            } }))),
            "ids.mint" => {
                let count = args.get("count").and_then(Json::as_u64).filter(|n| *n >= 1).ok_or_else(|| HostFailure::new(format!("{label}: count is a positive integer")))? as usize;
                Ok(Some(json!(match hosts.clock.as_deref_mut() {
                    Some(clock) => clock.mint_ids(count),
                    None => (0..count)
                        .map(|_| {
                            self.next_id += 1;
                            format!("id-{}", self.next_id)
                        })
                        .collect(),
                })))
            }
            "trace.append" => {
                let Data::List(entries) = wire(args.get("entries"), label)? else { return Err(format!("{label}: entries are a list").into()) };
                match hosts.trace.as_deref_mut() {
                    Some(trace) => trace.append(entries).map(|()| None),
                    None => Ok(None),
                }
            }
            "log.write" => {
                if let Some(trace) = hosts.trace.as_deref_mut() {
                    for line in args.get("lines").and_then(Json::as_array).into_iter().flatten() {
                        trace.log(LogLine {
                            level: line.get("level").and_then(Json::as_str).unwrap_or("info").to_string(),
                            message: line.get("message").and_then(Json::as_str).unwrap_or_default().to_string(),
                            fields: line.get("fields").cloned().unwrap_or(Json::Null),
                        });
                    }
                }
                Ok(None)
            }
            "locks.acquire" => {
                let names = texts(args.get("names"), label)?;
                Ok(Some(json!({ "token": store(hosts, label)?.acquire_locks(&names)? })))
            }
            "locks.release" => store(hosts, label)?.release_locks(text(args, "token", label)?).map(|()| None),
            "control.cancel.cancelled" | "control.cancel.cancelledNow" => match hosts.store.as_deref_mut() {
                Some(store) => Ok(Some(json!(store.cancelled()?))),
                None => Ok(Some(json!(false))),
            },
            "park.sink.commitTimerPark" => {
                let park = TimerPark { address: text(args, "address", label)?.into(), state: state(args, "state", label)?, wake_at: text(args, "wakeAt", label)?.into() };
                store(hosts, label)?.commit_timer_park(park).map(|()| None)
            }
            "park.sink.commitAwaitPark" => {
                let park = AwaitPark {
                    address: text(args, "address", label)?.into(),
                    state: state(args, "state", label)?,
                    adapter_type: text(args, "adapterType", label)?.into(),
                    correlation_key: args.get("correlationKey").cloned().unwrap_or(Json::Null),
                };
                store(hosts, label)?.commit_await_park(park).map(|()| None)
            }
            "park.sink.commitSuspension" => {
                let (address, state) = (text(args, "address", label)?.to_string(), state(args, "state", label)?);
                store(hosts, label)?.commit_suspension(&address, state).map(|()| None)
            }
            "park.sink.recordJoin" => {
                let count = args.get("parkedChildren").and_then(Json::as_i64).ok_or_else(|| HostFailure::new(format!("{label}: parkedChildren is a count")))?;
                store(hosts, label)?.record_join(text(args, "frameAddress", label)?, count).map(|()| None)
            }
            "park.sink.decrementJoin" => {
                let closed = store(hosts, label)?.decrement_join(text(args, "frameAddress", label)?, text(args, "branchAddress", label)?, text(args, "leafAddress", label)?)?;
                Ok(Some(json!({ "closed": closed })))
            }
            "park.sink.persistBranchExport" => {
                let export = BranchExport {
                    branch_address: text(args, "branchAddress", label)?.into(),
                    branch_index: args.get("branchIndex").and_then(Json::as_i64).ok_or_else(|| HostFailure::new(format!("{label}: branchIndex is an integer")))?,
                    exports: BranchExports(args.get("exports").cloned().unwrap_or(Json::Null)),
                };
                store(hosts, label)?.persist_branch_export(text(args, "frameAddress", label)?, export).map(|()| None)
            }
            "park.sink.collectBranchExports" => {
                let rows = store(hosts, label)?.collect_branch_exports(text(args, "frameAddress", label)?)?;
                let rows: Vec<Json> = rows
                    .into_iter()
                    .map(|r| json!(["o", [["branchAddress", r.branch_address], ["branchIndex", r.branch_index], ["exports", r.exports.0]]]))
                    .collect();
                Ok(Some(json!(["l", rows])))
            }
            "park.sink.cancelSubtrees" => {
                let subtrees = texts(args.get("subtreeAddresses"), label)?;
                store(hosts, label)?.cancel_subtrees(&subtrees, args.get("excludeLeaf").and_then(Json::as_str)).map(|()| None)
            }
            "park.wake" => {
                let key = args.get("correlationKey").cloned().unwrap_or(Json::Null);
                store(hosts, label)?.wake(text(args, "adapterType", label)?, &key).map(|()| None)
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
                let minted = store(hosts, label)?.mint_callback(mint)?;
                Ok(Some(json!({ "id": minted.id, "url": minted.url })))
            }
            "park.callbacks.calls" => {
                let id = args.get("callbackId").cloned().unwrap_or(Json::Null);
                Ok(Some(store(hosts, label)?.callback_calls(&id)?.to_wire()))
            }
            "park.sources.save" => Ok(Some(json!({ "hash": store(hosts, label)?.save_source(text(args, "source", label)?)? }))),
            "park.sources.load" => Ok(Some(match store(hosts, label)?.load_source(text(args, "hash", label)?)? {
                Some(source) => json!({ "source": source }),
                None => json!({}),
            })),
            other => Err(unserved_failure(other)),
        }
    }
}

fn unserved_failure(label: &str) -> HostFailure {
    unserved::<()>(label).unwrap_err()
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
