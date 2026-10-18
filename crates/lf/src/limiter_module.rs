//! A limiter module run as a process: the limiter slot filled by a
//! third-party module (crate::core), spoken to over the limiter slot's wire
//! (docs/contracts/limiter-slot.md) — one JSON-RPC 2.0 message per line on
//! its stdin and stdout, as the store slot's (crate::store_module), opened
//! by `limiter.open` with the module's settings. A limiter shared by many
//! hosts (Redis, a database) is such a module; lf's in-process waiting
//! (crate::limiter::acquire) is unchanged by it.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

use crate::core::ProcessModule;
use crate::json::{Js, Obj};
use crate::limiter::{Acquire, Bucket, Grant, Limiter};
use crate::obj;
use crate::store::iso_at;
use crate::store_wire::int;

pub struct ProcessLimiter {
    name: String,
    wire: Mutex<Pipe>,
    child: Mutex<Child>,
}

struct Pipe {
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
}

impl ProcessLimiter {
    pub fn start(name: &str, process: &ProcessModule, settings: &BTreeMap<String, String>) -> Result<ProcessLimiter, String> {
        let (program, args) = process.command.split_first().ok_or_else(|| format!("the limiter module {name} has no command"))?;
        let mut child = Command::new(program)
            .args(args)
            .current_dir(&process.dir)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .envs(&process.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("the limiter module {name}: {program} could not be started ({e})"))?;
        let wire = Pipe { stdin: child.stdin.take(), stdout: BufReader::new(child.stdout.take().expect("stdout is piped")), next_id: 0 };
        let limiter = ProcessLimiter { name: name.to_string(), wire: Mutex::new(wire), child: Mutex::new(child) };
        let settings: Obj = settings.iter().map(|(k, v)| (k.clone(), Js::str(v))).collect();
        limiter.call("limiter.open", obj! { "settings" => Js::from(settings) })?;
        Ok(limiter)
    }

    fn call(&self, method: &str, params: Obj) -> Result<Js, String> {
        let mut wire = self.wire.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        wire.next_id += 1;
        let id = wire.next_id;
        let request = Js::from(obj! { "jsonrpc" => Js::str("2.0"), "id" => Js::Num(id.into()), "method" => Js::str(method), "params" => Js::from(params) });
        let gone = |e: std::io::Error| format!("the limiter module {}: {method}: {e}", self.name);
        let stdin = wire.stdin.as_mut().ok_or_else(|| format!("the limiter module {} is closed", self.name))?;
        stdin.write_all(format!("{}\n", request.to_json()).as_bytes()).map_err(gone)?;
        stdin.flush().map_err(gone)?;
        let mut line = String::new();
        if wire.stdout.read_line(&mut line).map_err(gone)? == 0 {
            return Err(format!("the limiter module {} exited before it answered {method}", self.name));
        }
        let reply = Js::parse(line.as_bytes()).map_err(|e| format!("the limiter module {}: {method}: its answer is not JSON: {e}", self.name))?;
        if reply.get("id").and_then(int) != Some(id) {
            return Err(format!("the limiter module {}: {method}: answered another request", self.name));
        }
        if let Some(error) = reply.get("error") {
            let message = error.get("message").and_then(Js::as_str).unwrap_or("no message");
            return Err(format!("the limiter module {}: {method}: {message}", self.name));
        }
        Ok(reply.get("result").cloned().unwrap_or(Js::Null))
    }
}

impl Drop for ProcessLimiter {
    fn drop(&mut self) {
        // Its stdin closing ends it; one still running a second later is killed.
        self.wire.lock().unwrap_or_else(|p| p.into_inner()).stdin.take();
        let mut child = self.child.lock().unwrap_or_else(|p| p.into_inner());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while std::time::Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Limiter for ProcessLimiter {
    fn acquire(&self, request: &Acquire) -> Result<Grant, String> {
        let answer = self.call("limiter.acquire", acquire_params(request))?;
        grant_of(&answer).ok_or_else(|| format!("the limiter module {}: limiter.acquire answered {}, not a grant", self.name, answer.to_json()))
    }

    fn release(&self, permit: &str) -> Result<(), String> {
        self.call("limiter.release", obj! { "permit" => Js::str(permit) }).map(|_| ())
    }

    fn throttle(&self, key: &str, until_ms: i64) -> Result<(), String> {
        self.call("limiter.throttle", obj! { "key" => Js::str(key), "until" => Js::str(iso_at(until_ms)) }).map(|_| ())
    }
}

// ── The wire's shapes, both ways (crate::contract_limiter serves them) ──────

pub fn acquire_params(request: &Acquire) -> Obj {
    let limits = request
        .limits
        .iter()
        .map(|limit| {
            let mut out = obj! { "key" => Js::str(&limit.key) };
            if let Some((calls, per_ms)) = limit.calls {
                out.insert("calls".into(), Js::Num(calls.into()));
                out.insert("perMs".into(), Js::Num(per_ms.into()));
            }
            if let Some(concurrent) = limit.concurrent {
                out.insert("concurrent".into(), Js::Num(concurrent.into()));
            }
            Js::from(out)
        })
        .collect();
    obj! {
        "key" => Js::str(&request.key),
        "cost" => Js::Num(request.cost.into()),
        "limits" => Js::Arr(limits),
        "holdMs" => Js::Num(request.hold_ms.into()),
    }
}

pub fn acquire_of(params: &Js) -> Result<Acquire, String> {
    let whole = |js: &Js, key: &str| -> Result<Option<u64>, String> {
        match js.get(key) {
            None | Some(Js::Null) => Ok(None),
            Some(Js::Num(n)) => n.as_u64().map(Some).ok_or_else(|| format!("{key}: expected a whole number")),
            Some(_) => Err(format!("{key}: expected a whole number")),
        }
    };
    let key = params.get("key").and_then(Js::as_str).ok_or("key: expected a string")?.to_string();
    let limits = params.get("limits").and_then(Js::as_array).ok_or("limits: expected a list")?;
    let limits = limits
        .iter()
        .map(|limit| {
            let key = limit.get("key").and_then(Js::as_str).ok_or("limits[].key: expected a string")?.to_string();
            let calls = match (whole(limit, "calls")?, whole(limit, "perMs")?) {
                (Some(calls), Some(per)) if calls > 0 && per > 0 => Some((calls, per)),
                (None, None) => None,
                _ => return Err("limits[]: calls and perMs go together, each above 0".to_string()),
            };
            Ok(Bucket { key, calls, concurrent: whole(limit, "concurrent")? })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(Acquire { key, cost: whole(params, "cost")?.unwrap_or(1), limits, hold_ms: whole(params, "holdMs")?.unwrap_or(crate::limiter::HOLD_MS) })
}

pub fn grant_wire(grant: &Grant) -> Js {
    Js::from(match grant {
        Grant::Granted { permit } => obj! { "granted" => Js::Bool(true), "permit" => Js::str(permit) },
        Grant::Refused { retry_at_ms } => obj! { "granted" => Js::Bool(false), "retryAt" => Js::str(iso_at(*retry_at_ms)) },
    })
}

fn grant_of(answer: &Js) -> Option<Grant> {
    match answer.get("granted") {
        Some(Js::Bool(true)) => Some(Grant::Granted { permit: answer.get("permit")?.as_str()?.to_string() }),
        Some(Js::Bool(false)) => Some(Grant::Refused { retry_at_ms: crate::units::ms_of(answer.get("retryAt")?.as_str()?)? }),
        _ => None,
    }
}
