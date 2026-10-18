//! `lf --contract-limiter`: lf's built-in limiter (`@lf/memory-limiter`)
//! served over stdin/stdout as the limiter slot's wire
//! (docs/contracts/limiter-slot.md), one JSON-RPC 2.0 message per line, so
//! the TypeScript contract suite (movement-engine `services/limiter/
//! contract.ts`) holds it to the meaning every limiter has.
//! `--contract-limiter-slot` serves the project's limiter slot instead, a
//! limiter module's process included.

use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::json::{Js, Obj};
use crate::limiter::Limiter;
use crate::limiter_module::{acquire_of, grant_wire};
use crate::obj;

const INVALID_PARAMS: i64 = -32602;
const METHOD_NOT_FOUND: i64 = -32601;
const PARSE_ERROR: i64 = -32700;
const LIMITER_FAILED: i64 = -32000;

pub async fn serve(limiter: Arc<dyn Limiter>) -> Result<(), String> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        if line.trim().is_empty() {
            continue;
        }
        let reply = answer(&*limiter, &line);
        stdout.write_all(format!("{}\n", reply.to_json()).as_bytes()).await.map_err(|e| e.to_string())?;
        stdout.flush().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn answer(limiter: &dyn Limiter, line: &str) -> Js {
    let request = match Js::parse(line.as_bytes()) {
        Ok(request) => request,
        Err(e) => return error_reply(Js::Null, PARSE_ERROR, format!("not JSON: {e}")),
    };
    let id = request.get("id").cloned().unwrap_or(Js::Null);
    let empty = Js::from(Obj::new());
    let params = request.get("params").unwrap_or(&empty);
    let text = |key: &str| params.get(key).and_then(Js::as_str).ok_or((INVALID_PARAMS, format!("{key}: expected a string")));
    let failed = |message: String| (LIMITER_FAILED, message);
    let result = match request.get("method").and_then(Js::as_str) {
        // The built-in takes no settings.
        Some("limiter.open") => Ok(Js::Null),
        Some("limiter.acquire") => acquire_of(params).map_err(|m| (INVALID_PARAMS, m)).and_then(|r| limiter.acquire(&r).map_err(failed)).map(|g| grant_wire(&g)),
        Some("limiter.release") => text("permit").and_then(|p| limiter.release(p).map_err(failed)).map(|()| Js::Null),
        Some("limiter.throttle") => text("key").and_then(|key| {
            let until = text("until").and_then(|u| crate::units::ms_of(u).ok_or((INVALID_PARAMS, "until: expected an instant".to_string())))?;
            limiter.throttle(key, until).map_err(failed).map(|()| Js::Null)
        }),
        Some(other) => Err((METHOD_NOT_FOUND, format!("no method \"{other}\""))),
        None => Err((INVALID_PARAMS, "a request names its method".to_string())),
    };
    match result {
        Ok(result) => Js::from(obj! { "jsonrpc" => Js::str("2.0"), "id" => id, "result" => result }),
        Err((code, message)) => error_reply(id, code, message),
    }
}

fn error_reply(id: Js, code: i64, message: String) -> Js {
    Js::from(obj! { "jsonrpc" => Js::str("2.0"), "id" => id, "error" => Js::from(obj! { "code" => Js::Num(code.into()), "message" => Js::str(message) }) })
}
