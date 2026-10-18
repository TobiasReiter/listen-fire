//! `lf --contract-guard`: lf's built-in loop guard (`@lf/fingerprint-guard`)
//! served over stdin/stdout as the loopGuard slot's wire
//! (docs/contracts/loop-guard-slot.md), one JSON-RPC 2.0 message per line, so
//! the TypeScript contract suite (movement-engine `services/loop_guard/
//! contract.ts`) holds it to the meaning every guard has. The built-in is
//! opened by `guard.open`, with the settings it is sent (no `path` or `url`:
//! a file in a temporary folder). `--contract-guard-slot` serves the
//! project's loopGuard slot instead, a guard module's process included.

use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::guard_module::answer_wire;
use crate::json::{Js, Obj};
use crate::loop_guard::{Asked, Current, FingerprintGuard, LoopGuard, Wrote};
use crate::obj;

const INVALID_PARAMS: i64 = -32602;
const METHOD_NOT_FOUND: i64 = -32601;
const PARSE_ERROR: i64 = -32700;
const GUARD_FAILED: i64 = -32000;

/// The guard being served: the project's, or the built-in once `guard.open` has made it.
pub enum Serving {
    Slot(Arc<dyn LoopGuard>),
    BuiltIn(Option<FingerprintGuard>),
}

pub async fn serve(mut serving: Serving) -> Result<(), String> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        if line.trim().is_empty() {
            continue;
        }
        let reply = answer(&mut serving, &line);
        stdout.write_all(format!("{}\n", reply.to_json()).as_bytes()).await.map_err(|e| e.to_string())?;
        stdout.flush().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn answer(serving: &mut Serving, line: &str) -> Js {
    let request = match Js::parse(line.as_bytes()) {
        Ok(request) => request,
        Err(e) => return error_reply(Js::Null, PARSE_ERROR, format!("not JSON: {e}")),
    };
    let id = request.get("id").cloned().unwrap_or(Js::Null);
    let empty = Js::from(Obj::new());
    let params = request.get("params").unwrap_or(&empty);
    let result = match request.get("method").and_then(Js::as_str) {
        Some("guard.open") => open(serving, params).map(|()| Js::Null).map_err(|m| (GUARD_FAILED, m)),
        Some(method @ ("guard.recordWrite" | "guard.isEcho")) => match guard_of(serving) {
            Some(guard) => call(guard, method, params),
            None => Err((GUARD_FAILED, "open me with guard.open first".to_string())),
        },
        Some(other) => Err((METHOD_NOT_FOUND, format!("no method \"{other}\""))),
        None => Err((INVALID_PARAMS, "a request names its method".to_string())),
    };
    match result {
        Ok(result) => Js::from(obj! { "jsonrpc" => Js::str("2.0"), "id" => id, "result" => result }),
        Err((code, message)) => error_reply(id, code, message),
    }
}

fn guard_of(serving: &Serving) -> Option<&dyn LoopGuard> {
    match serving {
        Serving::Slot(guard) => Some(&**guard),
        Serving::BuiltIn(guard) => guard.as_ref().map(|g| g as &dyn LoopGuard),
    }
}

fn open(serving: &mut Serving, params: &Js) -> Result<(), String> {
    let Serving::BuiltIn(guard) = serving else { return Ok(()) };
    let mut settings: std::collections::BTreeMap<String, String> = match params.get("settings") {
        Some(Js::Obj(given)) => given.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect(),
        _ => Default::default(),
    };
    let dir = std::env::temp_dir().join(format!("lf-guard-{}", uuid::Uuid::new_v4()));
    if !settings.contains_key("url") {
        settings.entry("path".into()).or_insert_with(|| "guard.db".into());
    }
    *guard = Some(FingerprintGuard::open(&settings, &dir, &dir)?);
    Ok(())
}

fn call(guard: &dyn LoopGuard, method: &str, params: &Js) -> Result<Js, (i64, String)> {
    fn text<'a>(from: &'a Js, key: &str) -> Result<&'a str, (i64, String)> {
        from.get(key).and_then(Js::as_str).ok_or((INVALID_PARAMS, format!("{key}: expected a string")))
    }
    let (adapter, external_id) = (text(params, "adapter")?, text(params, "externalId")?);
    let writer = text(params, "writer")?;
    if method == "guard.recordWrite" {
        let record = params.get("record").ok_or((INVALID_PARAMS, "record: expected the record".to_string()))?;
        let wrote = Wrote { adapter: adapter.into(), record_type: text(params, "recordType")?.into(), external_id: external_id.into(), record: record.clone() };
        return guard.record_write(&wrote, writer).map(|()| Js::Null).map_err(|m| (GUARD_FAILED, m));
    }
    let current = match params.get("current") {
        None | Some(Js::Null) => None,
        Some(current) => {
            let record = current.get("record").ok_or((INVALID_PARAMS, "current.record: expected the record".to_string()))?;
            Some(Current { record_type: text(current, "recordType")?, record })
        }
    };
    guard.is_echo(&Asked { adapter, external_id, writer, current }).map(|a| answer_wire(&a)).map_err(|m| (GUARD_FAILED, m))
}

fn error_reply(id: Js, code: i64, message: String) -> Js {
    Js::from(obj! { "jsonrpc" => Js::str("2.0"), "id" => id, "error" => Js::from(obj! { "code" => Js::Num(code.into()), "message" => Js::str(message) }) })
}
