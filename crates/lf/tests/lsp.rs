//! `lf lsp` end to end: the binary driven over stdio as an editor drives it —
//! initialize, didOpen, the published diagnostics, completion, hover,
//! definition, a code action, shutdown and exit.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{Value, json};

struct Client {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Client {
    fn send(&mut self, message: Value) {
        let body = serde_json::to_vec(&message).unwrap();
        write!(self.stdin, "Content-Length: {}\r\n\r\n", body.len()).unwrap();
        self.stdin.write_all(&body).unwrap();
        self.stdin.flush().unwrap();
    }

    fn receive(&mut self) -> Value {
        let mut length = 0;
        loop {
            let mut header = String::new();
            assert!(self.stdout.read_line(&mut header).unwrap() > 0, "lf lsp closed its output");
            let header = header.trim_end();
            if header.is_empty() {
                break;
            }
            if let Some(n) = header.strip_prefix("Content-Length:") {
                length = n.trim().parse().unwrap();
            }
        }
        let mut body = vec![0; length];
        self.stdout.read_exact(&mut body).unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn notify(&mut self, method: &str, params: Value) {
        self.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    /// Sends a request and answers its result, skipping notifications.
    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        loop {
            let message = self.receive();
            if message.get("id") == Some(&json!(id)) {
                assert!(message.get("error").is_none(), "{message}");
                return message["result"].clone();
            }
        }
    }

    fn notification(&mut self, method: &str) -> Value {
        loop {
            let message = self.receive();
            if message.get("method").and_then(Value::as_str) == Some(method) {
                return message["params"].clone();
            }
        }
    }
}

const SOURCE: &str = "function hello(run: <manual-[:Invocation]->>) {
  shout = UPPER(run.`Text`)
  return \"Hello, ${shout}!\"
}

listen to manual fire hello
";

#[test]
fn an_editor_session_over_stdio() {
    let dir = std::env::temp_dir().join(format!("lf-lsp-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let lf = env!("CARGO_BIN_EXE_lf");
    assert!(Command::new(lf).arg("init").arg(&dir).output().unwrap().status.success());
    let file = dir.join("movements/hello.mvt");
    std::fs::write(&file, SOURCE).unwrap();
    let uri = format!("file://{}", file.display());

    let mut child = Command::new(lf).arg("lsp").arg("--dir").arg(&dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    let (stdin, stdout) = (child.stdin.take().unwrap(), BufReader::new(child.stdout.take().unwrap()));
    let mut client = Client { child, stdin, stdout, next_id: 0 };

    let init = client.request("initialize", json!({ "processId": null, "rootUri": format!("file://{}", dir.display()), "capabilities": {} }));
    assert_eq!(init.pointer("/capabilities/hoverProvider"), Some(&json!(true)));
    client.notify("initialized", json!({}));
    client.notify("textDocument/didOpen", json!({ "textDocument": { "uri": uri, "languageId": "movement", "version": 1, "text": SOURCE } }));

    let published = client.notification("textDocument/publishDiagnostics");
    assert_eq!(published["uri"], json!(uri));
    let diagnostics = published["diagnostics"].as_array().unwrap();
    let spelling = diagnostics.iter().find(|d| d["code"] == "MOV_V5_SPELLING").unwrap_or_else(|| panic!("{published}"));

    // `run.` on line 1: the manual unit's fields.
    let completion = client.request("textDocument/completion", json!({ "textDocument": { "uri": uri }, "position": { "line": 1, "character": 20 } }));
    let labels: Vec<&str> = completion["items"].as_array().unwrap().iter().map(|i| i["label"].as_str().unwrap()).collect();
    assert!(labels.contains(&"Text") && labels.contains(&"Run by (name)"), "{labels:?}");

    // `shout` on line 2: its type.
    let hover = client.request("textDocument/hover", json!({ "textDocument": { "uri": uri }, "position": { "line": 2, "character": 21 } }));
    let contents = hover.pointer("/contents/value").and_then(Value::as_str).unwrap_or_else(|| panic!("{hover}"));
    assert!(contents.contains("shout: text") && contents.contains("https://listen-fire.github.io/docs/v5/"), "{contents}");

    // `hello` in the listen: the function's declaration.
    let definition = client.request("textDocument/definition", json!({ "textDocument": { "uri": uri }, "position": { "line": 5, "character": 24 } }));
    assert_eq!(definition["uri"], json!(uri));
    assert_eq!(definition.pointer("/range/start"), Some(&json!({ "line": 0, "character": 9 })));

    let actions = client.request("textDocument/codeAction", json!({ "textDocument": { "uri": uri }, "range": spelling["range"], "context": { "diagnostics": [spelling] } }));
    let edits = actions[0].pointer(&format!("/edit/changes/{}", uri.replace('~', "~0").replace('/', "~1"))).unwrap_or_else(|| panic!("{actions}"));
    assert!(edits.as_array().unwrap().iter().any(|e| e["newText"].as_str().unwrap().contains("Text.upper")), "{actions}");

    // An edit that fixes it publishes again, after the debounce, without it.
    let fixed = SOURCE.replace("UPPER(", "Text.upper(");
    client.notify("textDocument/didChange", json!({ "textDocument": { "uri": uri, "version": 2 }, "contentChanges": [{ "text": fixed }] }));
    let published = client.notification("textDocument/publishDiagnostics");
    assert!(!published["diagnostics"].as_array().unwrap().iter().any(|d| d["code"] == "MOV_V5_SPELLING"), "{published}");

    assert_eq!(client.request("shutdown", Value::Null), Value::Null);
    client.notify("exit", Value::Null);
    let status = client.child.wait().unwrap();
    assert!(status.success());
    let _ = std::fs::remove_dir_all(&dir);
}
