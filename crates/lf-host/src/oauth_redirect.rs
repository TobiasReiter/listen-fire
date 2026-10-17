//! Where the provider sends the person back after they sign in, for `lf
//! credential add` / `update` of an OAuth 2 credential (apps/cli/src/
//! oauth_redirect.ts). Three ways, because lf runs on a laptop, on a headless
//! box over ssh, and deployed behind a URL:
//!
//!   loopback (default)  lf listens on 127.0.0.1 for the one redirect
//!                       (RFC 8252); the redirect URI is
//!                       http://127.0.0.1:<port>/callback.
//!   headless            lf prints the authorize URL and reads back the URL
//!                       the browser was sent to (it fails to load; it is
//!                       copied from the address bar). Same redirect URI, so
//!                       the port must be the registered one.
//!   public              the redirect URI is <publicUrl>/oauth/callback, which
//!                       `lf serve` answers by leaving the redirect in .lf/oauth
//!                       for the waiting command to pick up
//!                       (`deliver_public_redirect`, which serve mounts).

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::http_out::{base64url, hex, random_bytes};
use crate::oauth2::{ClientApp, OAuth2Declaration, begin, exchange_code};
use crate::prompt::{Ask, Prompter};
use crate::secrets_family::Fields;

pub const LOOPBACK_CALLBACK_PATH: &str = "/callback";
pub const PUBLIC_CALLBACK_PATH: &str = "/oauth/callback";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const PICKUP_POLL: Duration = Duration::from_millis(200);
const STATE_BYTES: usize = 32;

pub enum RedirectMode {
    Loopback { port: u16, open_browser: bool },
    Headless { port: u16 },
    Public { public_url: String, lf_dir: PathBuf },
}

pub fn loopback_redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}{LOOPBACK_CALLBACK_PATH}")
}

pub fn public_redirect_uri(public_url: &str) -> String {
    format!("{}{PUBLIC_CALLBACK_PATH}", public_url.trim_end_matches('/'))
}

/// The redirect that came back, and (loopback) the browser waiting for a page.
struct Redirect {
    state: String,
    code: String,
    browser: Option<TcpStream>,
}

impl Redirect {
    /// Tell the browser how it went (loopback only).
    async fn answer(&mut self, status: u16, text: &str) {
        if let Some(stream) = self.browser.as_mut() {
            respond(stream, status, text).await;
        }
    }
}

/// Sign the person in at the provider and exchange the code: the token fields.
pub async fn authorize_at_provider(
    oauth2: &OAuth2Declaration,
    client: &ClientApp,
    mode: &RedirectMode,
    prompter: &mut Prompter,
    label: &str,
) -> Result<Fields, String> {
    let listener = match mode {
        RedirectMode::Loopback { port, .. } => {
            Some(TcpListener::bind(("127.0.0.1", *port)).await.map_err(|e| format!("the loopback listener could not start on port {port}: {e}"))?)
        }
        _ => None,
    };
    let redirect_uri = match (mode, &listener) {
        (RedirectMode::Loopback { .. }, Some(listener)) => loopback_redirect_uri(listener.local_addr().map_err(|e| e.to_string())?.port()),
        (RedirectMode::Loopback { port, .. } | RedirectMode::Headless { port }, _) => loopback_redirect_uri(*port),
        (RedirectMode::Public { public_url, .. }, _) => public_redirect_uri(public_url),
    };
    let state = base64url(&random_bytes(STATE_BYTES)?);
    let (url, attempt) = begin(oauth2, &client.client_id, &redirect_uri, &state)?;
    prompter.print(&format!("open this URL to sign in for {label}:\n  {url}"));
    let mut back = match mode {
        RedirectMode::Loopback { open_browser, .. } => {
            if *open_browser {
                open_in_browser(&url);
            }
            let listener = listener.as_ref().ok_or("the loopback listener did not start")?;
            next_redirect(listener, DEFAULT_TIMEOUT).await?
        }
        RedirectMode::Headless { .. } => {
            let pasted = prompter.ask("paste the URL your browser was sent back to (it will not load; copy it from the address bar)", Ask::default()).await?;
            let url = url::Url::parse(&pasted).map_err(|_| "that is not a URL; paste the whole address the browser was sent to".to_string())?;
            redirect_of(&url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect::<Vec<_>>(), None).await?
        }
        RedirectMode::Public { lf_dir, .. } => {
            prompter.print(&format!("waiting for the provider to send you back to {redirect_uri} (lf serve must be running there)"));
            pick_up(lf_dir, &state, DEFAULT_TIMEOUT).await?
        }
    };
    if back.state != state {
        back.answer(400, "This sign-in is not the one lf is waiting for.").await;
        return Err("the redirect carried another sign-in's state; start again".into());
    }
    match exchange_code(oauth2, client, &attempt, &back.code).await {
        Ok(fields) => {
            back.answer(200, &format!("Signed in for {label}. You can close this tab.")).await;
            Ok(fields)
        }
        Err(why) => {
            back.answer(400, &format!("Signing in for {label} failed: {why}")).await;
            Err(why)
        }
    }
}

/// The code and state in a redirect's query, or the provider's refusal (told
/// to the browser too, when one waits).
async fn redirect_of(query: &[(String, String)], mut browser: Option<TcpStream>) -> Result<Redirect, String> {
    let get = |key: &str| query.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
    let (error, code, state) = (get("error"), get("code"), get("state"));
    match (error, code, state) {
        (None, Some(code), Some(state)) => Ok(Redirect { state, code, browser }),
        (error, _, _) => {
            let why = match error {
                Some(error) => {
                    let detail = get("error_description").filter(|d| !d.is_empty()).map(|d| format!(" ({d})")).unwrap_or_default();
                    format!("the provider answered {error}{detail}")
                }
                None => "the redirect carried no code or state".to_string(),
            };
            if let Some(stream) = browser.as_mut() {
                respond(stream, 400, &format!("Signing in failed: {why}")).await;
            }
            Err(format!("signing in failed: {why}"))
        }
    }
}

/// The provider's one redirect to the loopback listener; anything else asked
/// of it meanwhile is not found.
async fn next_redirect(listener: &TcpListener, timeout: Duration) -> Result<Redirect, String> {
    let waited = async {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { continue };
            let Some((method, target)) = request_line(&mut stream).await else { continue };
            let url = url::Url::parse(&format!("http://127.0.0.1{target}")).ok();
            match url {
                Some(url) if method == "GET" && url.path() == LOOPBACK_CALLBACK_PATH => {
                    let query: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
                    return redirect_of(&query, Some(stream)).await;
                }
                _ => respond(&mut stream, 404, "not found").await,
            }
        }
    };
    tokio::time::timeout(timeout, waited).await.map_err(|_| format!("no redirect came back within {}s", timeout.as_secs()))?
}

/// A request's method and target, its head read off the stream.
async fn request_line(stream: &mut TcpStream) -> Option<(String, String)> {
    let mut head = Vec::new();
    let mut buf = [0u8; 4096];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut buf).await.ok()?;
        if n == 0 || head.len() > 64 * 1024 {
            return None;
        }
        head.extend_from_slice(&buf[..n]);
    }
    let text = String::from_utf8_lossy(&head);
    let mut parts = text.lines().next()?.split(' ');
    Some((parts.next()?.to_string(), parts.next()?.to_string()))
}

async fn respond(stream: &mut TcpStream, status: u16, text: &str) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        _ => "Not Found",
    };
    let body = format!("{text}\n");
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

// ── The public redirect, through lf serve ──────────────────────────────────
// The waiting command leaves a marker named by the state's hash; `lf serve`
// writes a redirect only where a marker waits, so its route cannot be used to
// write arbitrary files, and the state itself never names a file. The same
// files the TypeScript lf uses, so either binary's serve hands over to either
// binary's command.

fn pickup_base(lf_dir: &Path, state: &str) -> PathBuf {
    lf_dir.join("oauth").join(hex(&Sha256::digest(state.as_bytes())))
}

fn with_extension(base: &Path, extension: &str) -> PathBuf {
    let mut name = base.as_os_str().to_owned();
    name.push(extension);
    PathBuf::from(name)
}

fn write_private(path: &Path, text: &str) -> Result<(), String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    std::io::Write::write_all(&mut file, text.as_bytes()).map_err(|e| format!("{}: {e}", path.display()))
}

async fn pick_up(lf_dir: &Path, state: &str, timeout: Duration) -> Result<Redirect, String> {
    let dir = lf_dir.join("oauth");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    #[cfg(unix)]
    let _ = std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(0o700));
    let base = pickup_base(lf_dir, state);
    let (waiting, json) = (with_extension(&base, ".waiting"), with_extension(&base, ".json"));
    write_private(&waiting, "")?;
    let started = Instant::now();
    let picked = async {
        loop {
            if json.exists() {
                let text = std::fs::read_to_string(&json).map_err(|e| format!("{}: {e}", json.display()))?;
                let query = serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .and_then(|v| v.get("query").and_then(|q| q.as_str()).map(str::to_string))
                    .ok_or_else(|| format!("{}: expected {{ query }}", json.display()))?;
                let pairs: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes()).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
                return redirect_of(&pairs, None).await;
            }
            if started.elapsed() > timeout {
                return Err(format!("no redirect came back within {}s", timeout.as_secs()));
            }
            tokio::time::sleep(PICKUP_POLL).await;
        }
    };
    let outcome = picked.await;
    let _ = std::fs::remove_file(&waiting);
    let _ = std::fs::remove_file(&json);
    outcome
}

/// `lf serve`'s answer to GET /oauth/callback?<query>: hand the redirect to
/// the command waiting for its state. The status and the page's text.
pub fn deliver_public_redirect(lf_dir: &Path, query: &str) -> (u16, String) {
    let state = url::form_urlencoded::parse(query.as_bytes()).find(|(k, _)| k == "state").map(|(_, v)| v.into_owned());
    let Some(state) = state.filter(|s| !s.is_empty()) else { return (400, "This redirect carries no state.".into()) };
    let base = pickup_base(lf_dir, &state);
    if !with_extension(&base, ".waiting").exists() {
        return (404, "No `lf credential` command is waiting for this sign-in; start it again.".into());
    }
    let written = serde_json::json!({ "query": query }).to_string();
    match write_private(&with_extension(&base, ".json"), &written) {
        Ok(()) => (200, "lf has the sign-in. Return to the terminal where `lf credential` is waiting.".into()),
        Err(why) => (500, why),
    }
}

/// The system's own opener; a failure to open is not fatal, the URL is printed.
fn open_in_browser(url: &str) {
    let (command, args): (&str, Vec<&str>) = if cfg!(target_os = "macos") {
        ("open", vec![url])
    } else if cfg!(windows) {
        ("cmd", vec!["/c", "start", "", url])
    } else {
        ("xdg-open", vec![url])
    };
    let _ = std::process::Command::new(command)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_public_redirect_is_written_only_where_a_command_waits() {
        let dir = std::env::temp_dir().join(format!("lf-host-oauth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("oauth")).unwrap();
        assert_eq!(deliver_public_redirect(&dir, "code=x").0, 400);
        assert_eq!(deliver_public_redirect(&dir, "code=x&state=nobody").0, 404);
        let base = pickup_base(&dir, "s1");
        write_private(&with_extension(&base, ".waiting"), "").unwrap();
        let (status, text) = deliver_public_redirect(&dir, "code=c1&state=s1");
        assert_eq!(status, 200, "{text}");
        let written = std::fs::read_to_string(with_extension(&base, ".json")).unwrap();
        assert_eq!(written, r#"{"query":"code=c1&state=s1"}"#);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
