//! A loop guard module run as a process: the loopGuard slot filled by a
//! third-party module (crate::core), spoken to over the slot's wire
//! (docs/contracts/loop-guard-slot.md) — one JSON-RPC 2.0 message per line on
//! its stdin and stdout, as the store slot's (crate::store_module), opened
//! by `guard.open` with the module's settings.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

use crate::core::ProcessModule;
use crate::json::{Js, Obj};
use crate::loop_guard::{Answer, Asked, LoopGuard, Wrote};
use crate::obj;
use crate::store_wire::int;

pub struct ProcessGuard {
    name: String,
    wire: Mutex<Pipe>,
    child: Mutex<Child>,
}

struct Pipe {
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
}

impl ProcessGuard {
    pub fn start(name: &str, process: &ProcessModule, settings: &BTreeMap<String, String>) -> Result<ProcessGuard, String> {
        let (program, args) = process.command.split_first().ok_or_else(|| format!("the loop guard module {name} has no command"))?;
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
            .map_err(|e| format!("the loop guard module {name}: {program} could not be started ({e})"))?;
        let wire = Pipe { stdin: child.stdin.take(), stdout: BufReader::new(child.stdout.take().expect("stdout is piped")), next_id: 0 };
        let guard = ProcessGuard { name: name.to_string(), wire: Mutex::new(wire), child: Mutex::new(child) };
        let settings: Obj = settings.iter().map(|(k, v)| (k.clone(), Js::str(v))).collect();
        guard.call("guard.open", obj! { "settings" => Js::from(settings) })?;
        Ok(guard)
    }

    fn call(&self, method: &str, params: Obj) -> Result<Js, String> {
        let mut wire = self.wire.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        wire.next_id += 1;
        let id = wire.next_id;
        let request = Js::from(obj! { "jsonrpc" => Js::str("2.0"), "id" => Js::Num(id.into()), "method" => Js::str(method), "params" => Js::from(params) });
        let gone = |e: std::io::Error| format!("the loop guard module {}: {method}: {e}", self.name);
        let stdin = wire.stdin.as_mut().ok_or_else(|| format!("the loop guard module {} is closed", self.name))?;
        stdin.write_all(format!("{}\n", request.to_json()).as_bytes()).map_err(gone)?;
        stdin.flush().map_err(gone)?;
        let mut line = String::new();
        if wire.stdout.read_line(&mut line).map_err(gone)? == 0 {
            return Err(format!("the loop guard module {} exited before it answered {method}", self.name));
        }
        let reply = Js::parse(line.as_bytes()).map_err(|e| format!("the loop guard module {}: {method}: its answer is not JSON: {e}", self.name))?;
        if reply.get("id").and_then(int) != Some(id) {
            return Err(format!("the loop guard module {}: {method}: answered another request", self.name));
        }
        if let Some(error) = reply.get("error") {
            let message = error.get("message").and_then(Js::as_str).unwrap_or("no message");
            return Err(format!("the loop guard module {}: {method}: {message}", self.name));
        }
        Ok(reply.get("result").cloned().unwrap_or(Js::Null))
    }
}

impl Drop for ProcessGuard {
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

impl LoopGuard for ProcessGuard {
    fn record_write(&self, wrote: &Wrote, writer: &str) -> Result<(), String> {
        let params = obj! {
            "adapter" => Js::str(&wrote.adapter),
            "recordType" => Js::str(&wrote.record_type),
            "externalId" => Js::str(&wrote.external_id),
            "writer" => Js::str(writer),
            "record" => wrote.record.clone(),
        };
        self.call("guard.recordWrite", params).map(|_| ())
    }

    fn is_echo(&self, asked: &Asked) -> Result<Answer, String> {
        let answer = self.call("guard.isEcho", asked_params(asked))?;
        answer_of(&answer).ok_or_else(|| format!("the loop guard module {}: guard.isEcho answered {}, not an echo or a record to read", self.name, answer.to_json()))
    }
}

// ── The wire's shapes, both ways (crate::contract_guard serves them) ────────

pub fn asked_params(asked: &Asked) -> Obj {
    let mut out = obj! { "adapter" => Js::str(asked.adapter), "externalId" => Js::str(asked.external_id), "writer" => Js::str(asked.writer) };
    if let Some(current) = asked.current {
        out.insert("current".into(), Js::from(obj! { "recordType" => Js::str(current.record_type), "record" => current.record.clone() }));
    }
    out
}

pub fn answer_wire(answer: &Answer) -> Js {
    Js::from(match answer {
        Answer::Echo(echo) => obj! { "echo" => Js::Bool(*echo) },
        Answer::Read { record_type } => obj! { "read" => Js::from(obj! { "recordType" => Js::str(record_type) }) },
    })
}

fn answer_of(answer: &Js) -> Option<Answer> {
    match answer.get("echo") {
        Some(Js::Bool(echo)) => Some(Answer::Echo(*echo)),
        _ => Some(Answer::Read { record_type: answer.get("read")?.get("recordType")?.as_str()?.to_string() }),
    }
}
