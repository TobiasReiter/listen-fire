//! `lf-host --contract-secrets <secrets file | env>`: one of lf's secrets
//! stores (src/secret_stores.rs) served over stdin/stdout, one JSON-RPC 2.0
//! message per line, so the TypeScript secrets contract suite (movement-engine
//! services/secrets/contract.ts) holds this binary's stores to the meaning
//! every store has — the same cases the TypeScript lf's file and environment
//! stores pass. The client is apps/cli/src/__test__/rpc_secrets.ts.
//!
//!   resolve { ref }                            → { fields, version } | null
//!   writeBack { ref, fields, expectedVersion } → { kind, record | current, why? }
//!   lock { ref } / unlock { ref }              the store's lock file (a file store)
//!   assertWritable { ref }
//!   env.set { key, value }                     a variable the environment store reads
//!
//! Requests are answered one at a time, in order: a `lock` another process
//! holds is waited for before the next request is read.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::json::{Js, Obj};
use crate::obj;
use crate::secret_stores::{EnvSecrets, FileSecrets};
use crate::secrets_family::{FileLock, Fields, Record, SecretsBackend, WriteBack};

const INVALID_PARAMS: i64 = -32602;
const METHOD_NOT_FOUND: i64 = -32601;
const PARSE_ERROR: i64 = -32700;
const STORE_FAILED: i64 = -32000;

enum Store {
    File(FileSecrets),
    Env(EnvSecrets),
}

impl Store {
    fn backend(&self) -> &dyn SecretsBackend {
        match self {
            Store::File(file) => file,
            Store::Env(env) => env,
        }
    }
}

pub async fn serve(target: &Path) -> Result<(), String> {
    let store = if target == Path::new("env") {
        Store::Env(EnvSecrets::new(Rc::new(RefCell::new(Vec::new()))))
    } else {
        Store::File(FileSecrets::at(target)?)
    };
    let mut held: HashMap<String, FileLock> = HashMap::new();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        if line.trim().is_empty() {
            continue;
        }
        let reply = answer(&store, &mut held, &line).await;
        stdout.write_all(format!("{}\n", reply.to_json()).as_bytes()).await.map_err(|e| e.to_string())?;
        stdout.flush().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

enum Failure {
    Params(String),
    Unknown,
    Store(String),
}

async fn answer(store: &Store, held: &mut HashMap<String, FileLock>, line: &str) -> Js {
    let request = match Js::parse(line.as_bytes()) {
        Ok(request) => request,
        Err(e) => return reply(Js::Null, Err((PARSE_ERROR, format!("not JSON: {e}")))),
    };
    let id = request.get("id").cloned().unwrap_or(Js::Null);
    let Some(method) = request.get("method").and_then(Js::as_str) else {
        return reply(id, Err((INVALID_PARAMS, "a request names its method".into())));
    };
    let empty = Js::from(Obj::new());
    let params = request.get("params").unwrap_or(&empty);
    match dispatch(store, held, method, params).await {
        Ok(result) => reply(id, Ok(result)),
        Err(Failure::Params(message)) => reply(id, Err((INVALID_PARAMS, message))),
        Err(Failure::Unknown) => reply(id, Err((METHOD_NOT_FOUND, format!("no method \"{method}\"")))),
        Err(Failure::Store(message)) => reply(id, Err((STORE_FAILED, message))),
    }
}

fn reply(id: Js, outcome: Result<Js, (i64, String)>) -> Js {
    match outcome {
        Ok(result) => Js::from(obj! { "jsonrpc" => Js::str("2.0"), "id" => id, "result" => result }),
        Err((code, message)) => {
            let error = obj! { "code" => Js::Num(code.into()), "message" => Js::str(message) };
            Js::from(obj! { "jsonrpc" => Js::str("2.0"), "id" => id, "error" => Js::from(error) })
        }
    }
}

fn text<'p>(params: &'p Js, key: &str) -> Result<&'p str, Failure> {
    params.get(key).and_then(Js::as_str).ok_or_else(|| Failure::Params(format!("{key}: expected a string")))
}

fn fields_of(params: &Js) -> Result<Fields, Failure> {
    match params.get("fields") {
        Some(Js::Obj(map)) => map
            .iter()
            .map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())).ok_or_else(|| Failure::Params("fields: expected strings".into())))
            .collect(),
        _ => Err(Failure::Params("fields: expected an object".into())),
    }
}

fn record_js(record: &Record) -> Js {
    let fields: Obj = record.fields.iter().map(|(k, v)| (k.clone(), Js::str(v))).collect();
    Js::from(obj! { "fields" => Js::from(fields), "version" => Js::str(&record.version) })
}

async fn dispatch(store: &Store, held: &mut HashMap<String, FileLock>, method: &str, params: &Js) -> Result<Js, Failure> {
    let backend = store.backend();
    match method {
        "resolve" => {
            let found = backend.resolve(text(params, "ref")?).map_err(Failure::Store)?;
            Ok(found.as_ref().map(record_js).unwrap_or(Js::Null))
        }
        "writeBack" => {
            let outcome = backend.write_back(text(params, "ref")?, &fields_of(params)?, text(params, "expectedVersion")?).map_err(Failure::Store)?;
            Ok(Js::from(match outcome {
                WriteBack::Written(record) => obj! { "kind" => Js::str("written"), "record" => record_js(&record) },
                WriteBack::NotPersisted { record, why } => obj! { "kind" => Js::str("not_persisted"), "record" => record_js(&record), "why" => Js::str(why) },
                WriteBack::Conflict(current) => obj! { "kind" => Js::str("conflict"), "current" => record_js(&current) },
                WriteBack::Missing => obj! { "kind" => Js::str("missing") },
            }))
        }
        "lock" => {
            let reference = text(params, "ref")?.to_string();
            if let Some(path) = backend.locked_file() {
                held.insert(reference, FileLock::acquire(&path).await.map_err(Failure::Store)?);
            }
            Ok(Js::Null)
        }
        "unlock" => {
            held.remove(text(params, "ref")?);
            Ok(Js::Null)
        }
        "assertWritable" => backend.assert_writable(text(params, "ref")?).map(|()| Js::Null).map_err(Failure::Store),
        "env.set" => match store {
            Store::Env(env) => {
                let (key, value) = (text(params, "key")?.to_string(), text(params, "value")?.to_string());
                env.env.borrow_mut().push((key, value));
                Ok(Js::Null)
            }
            Store::File(_) => Err(Failure::Params("env.set: this is a file store".into())),
        },
        _ => Err(Failure::Unknown),
    }
}
