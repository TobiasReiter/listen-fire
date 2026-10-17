//! OAuth 2 from what a module's manifest declares (`credentials[].oauth2`),
//! as movement-engine services/secrets/{oauth2,connect}.ts do it: the host's
//! generic refresh (the standard refresh-token grant at the declared token
//! URL), the authorize URL a person opens (state, PKCE), and the exchange of
//! the code the redirect brings back.

use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::http_out::{base64, base64url, encode_uri_component, form, post, random_bytes};
use crate::json::Js;
use crate::secrets_family::{Fields, Record, iso_instant, now_ms, redact_secrets};

/// `WireCredentialField`.
#[derive(Debug, Clone, PartialEq)]
pub struct DeclaredField {
    pub name: String,
    pub label: Option<String>,
    /// Absent means secret.
    pub secret: Option<bool>,
    pub optional: Option<bool>,
}

/// `WireOAuth2Declaration`.
#[derive(Debug, Clone, PartialEq)]
pub struct OAuth2Declaration {
    pub authorize_url: String,
    pub token_url: String,
    pub scopes: Vec<String>,
    /// Where the client id and secret go on the token call: `basic` (absent) or `body`.
    pub client_auth: Option<ClientAuth>,
    pub pkce: bool,
    pub authorize_params: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientAuth {
    Basic,
    Body,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DeclarationKind {
    Static,
    OAuth2(OAuth2Declaration),
}

/// `WireCredentialDeclaration`: a credential the module needs.
#[derive(Debug, Clone, PartialEq)]
pub struct Declaration {
    pub name: String,
    pub kind: DeclarationKind,
    pub fields: Vec<DeclaredField>,
}

impl Declaration {
    pub fn oauth2(&self) -> Option<&OAuth2Declaration> {
        match &self.kind {
            DeclarationKind::OAuth2(o) => Some(o),
            DeclarationKind::Static => None,
        }
    }
}

/// The token fields every OAuth 2 credential holds (`OAUTH2_TOKEN_FIELDS`).
pub const OAUTH2_TOKEN_FIELDS: [&str; 3] = ["access_token", "refresh_token", "expires_at"];

/// The `credentials` of a manifest answer, held to the protocol's schema.
pub fn declarations_of(manifest: &Js) -> Result<Vec<Declaration>, String> {
    let Some(raw) = manifest.get("credentials") else { return Ok(Vec::new()) };
    let items = raw.as_array().ok_or("credentials: expected an array")?;
    items.iter().map(declaration_of).collect()
}

fn string_at(value: &Js, key: &str) -> Result<Option<String>, String> {
    match value.get(key) {
        None => Ok(None),
        Some(v) => v.as_str().map(|s| Some(s.to_string())).ok_or_else(|| format!("{key}: expected string")),
    }
}

fn bool_at(value: &Js, key: &str) -> Result<Option<bool>, String> {
    match value.get(key) {
        None => Ok(None),
        Some(Js::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(format!("{key}: expected boolean")),
    }
}

fn declaration_of(raw: &Js) -> Result<Declaration, String> {
    let name = string_at(raw, "name")?.filter(|n| !n.is_empty()).ok_or("credentials.name: expected a credential name")?;
    let fields = raw
        .get("fields")
        .and_then(Js::as_array)
        .ok_or("credentials.fields: expected an array")?
        .iter()
        .map(|f| {
            Ok(DeclaredField {
                name: string_at(f, "name")?.filter(|n| !n.is_empty()).ok_or("credentials.fields.name: expected a non-empty string")?,
                label: string_at(f, "label")?,
                secret: bool_at(f, "secret")?,
                optional: bool_at(f, "optional")?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let kind = match raw.get("kind").and_then(Js::as_str) {
        Some("static") => DeclarationKind::Static,
        Some("oauth2") => {
            let o = raw.get("oauth2").ok_or("credentials.oauth2: expected an object")?;
            let url_at = |key: &str| -> Result<String, String> {
                let text = string_at(o, key)?.ok_or_else(|| format!("credentials.oauth2.{key}: expected a URL"))?;
                url::Url::parse(&text).map_err(|_| format!("credentials.oauth2.{key}: expected a URL"))?;
                Ok(text)
            };
            let scopes = match o.get("scopes") {
                None => Vec::new(),
                Some(s) => s
                    .as_array()
                    .and_then(|items| items.iter().map(|i| i.as_str().filter(|s| !s.is_empty()).map(str::to_string)).collect::<Option<Vec<_>>>())
                    .ok_or("credentials.oauth2.scopes: expected an array of non-empty strings")?,
            };
            let client_auth = match string_at(o, "clientAuth")?.as_deref() {
                None => None,
                Some("basic") => Some(ClientAuth::Basic),
                Some("body") => Some(ClientAuth::Body),
                Some(_) => return Err("credentials.oauth2.clientAuth: expected basic or body".into()),
            };
            let authorize_params = match o.get("authorizeParams") {
                None => Vec::new(),
                Some(Js::Obj(map)) => map
                    .iter()
                    .map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())).ok_or("credentials.oauth2.authorizeParams: expected strings"))
                    .collect::<Result<Vec<_>, _>>()?,
                Some(_) => return Err("credentials.oauth2.authorizeParams: expected an object".into()),
            };
            DeclarationKind::OAuth2(OAuth2Declaration {
                authorize_url: url_at("authorizeUrl")?,
                token_url: url_at("tokenUrl")?,
                scopes,
                client_auth,
                pkce: bool_at(o, "pkce")?.unwrap_or(false),
                authorize_params,
            })
        }
        _ => return Err("credentials.kind: expected static or oauth2".into()),
    };
    Ok(Declaration { name, kind, fields })
}

/// The fields of a stored credential a module that declares it is sent: the
/// ones it names, and the token fields of an `oauth2` one (`declaredFields`).
pub fn declared_fields(declaration: &Declaration, fields: &Fields) -> Fields {
    let mut names: Vec<&str> = declaration.fields.iter().map(|f| f.name.as_str()).collect();
    if declaration.oauth2().is_some() {
        names.extend(OAUTH2_TOKEN_FIELDS);
    }
    names.into_iter().filter_map(|n| fields.get(n).map(|v| (n.to_string(), v.clone()))).collect()
}

/// The fields of an update the host stores: the declaration's own. Any other
/// is refused, naming the fields and never their values (`acceptedFields`).
pub fn accepted_fields(adapter_type: &str, declaration: &Declaration, fields: Fields) -> Result<Fields, String> {
    let declared = |name: &str| declaration.fields.iter().any(|f| f.name == name) || (declaration.oauth2().is_some() && OAUTH2_TOKEN_FIELDS.contains(&name));
    let foreign: Vec<&str> = fields.keys().map(String::as_str).filter(|n| !declared(n)).collect();
    if !foreign.is_empty() {
        return Err(format!("Remote adapter \"{adapter_type}\" answered credential fields it does not declare: {}", foreign.join(", ")));
    }
    Ok(fields)
}

/// The host's own registered app at the provider.
#[derive(Debug, Clone, PartialEq)]
pub struct ClientApp {
    pub client_id: String,
    pub client_secret: Option<String>,
}

/// A credential's own `client_id` / `client_secret`, if it has them (`clientFromFields`).
pub fn client_from_fields(fields: &Fields) -> Option<ClientApp> {
    let client_id = fields.get("client_id")?.clone();
    Some(ClientApp { client_id, client_secret: fields.get("client_secret").cloned() })
}

fn token_headers() -> Vec<(String, String)> {
    vec![("content-type".into(), "application/x-www-form-urlencoded".into()), ("accept".into(), "application/json".into())]
}

/// Put the app on a token call where the declaration says (`authenticateClient`).
fn authenticate(client: &ClientApp, client_auth: Option<ClientAuth>, form: &mut Vec<(String, String)>, headers: &mut Vec<(String, String)>) {
    if client_auth.unwrap_or(ClientAuth::Basic) == ClientAuth::Basic {
        let pair = format!("{}:{}", encode_uri_component(&client.client_id), encode_uri_component(client.client_secret.as_deref().unwrap_or_default()));
        headers.push(("authorization".into(), format!("Basic {}", base64(pair.as_bytes()))));
        return;
    }
    form.retain(|(k, _)| k != "client_id" && k != "client_secret");
    form.push(("client_id".into(), client.client_id.clone()));
    if let Some(secret) = &client.client_secret {
        form.push(("client_secret".into(), secret.clone()));
    }
}

fn form_text(pairs: &[(String, String)]) -> String {
    form(&pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>())
}

const ERROR_BODY_CHARS: usize = 200;

fn head(text: &str) -> String {
    text.chars().take(ERROR_BODY_CHARS).collect()
}

/// The token fields of a token endpoint's answer; `None` when it has no access token.
fn token_fields(body: &Js) -> Option<Fields> {
    let access_token = body.get("access_token")?.as_str().filter(|t| !t.is_empty())?;
    let mut changed = Fields::from([("access_token".to_string(), access_token.to_string())]);
    // `z.coerce.number()`: a number, or text that reads as one.
    let expires_in = match body.get("expires_in") {
        None => None,
        Some(Js::Num(n)) => n.as_f64(),
        Some(Js::Str(s)) => Some(if s.trim().is_empty() { 0.0 } else { s.trim().parse::<f64>().ok()? }),
        Some(Js::Null) => Some(0.0),
        Some(Js::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        Some(_) => return None,
    };
    if let Some(seconds) = expires_in {
        changed.insert("expires_at".into(), iso_instant(now_ms() + (seconds * 1000.0) as i64));
    }
    match body.get("refresh_token") {
        None => {}
        Some(Js::Str(r)) if !r.is_empty() => {
            changed.insert("refresh_token".into(), r.clone());
        }
        Some(_) => return None,
    }
    Some(changed)
}

/// The standard refresh-token grant (`oauth2Refresher`). `client` absent: the
/// credential's own client fields, if it has them.
pub async fn refresh_grant(current: &Record, token_url: &str, client_auth: Option<ClientAuth>, client: Option<&ClientApp>) -> Result<Fields, String> {
    let refresh_token = current.fields.get("refresh_token").filter(|t| !t.is_empty()).ok_or("the credential holds no refresh_token")?;
    let own = client_from_fields(&current.fields);
    let client = client.or(own.as_ref());
    let mut form = vec![("grant_type".to_string(), "refresh_token".to_string()), ("refresh_token".to_string(), refresh_token.clone())];
    let mut headers = token_headers();
    if let Some(client) = client {
        authenticate(client, client_auth, &mut form, &mut headers);
    }
    let answer = post(token_url, &headers, form_text(&form)).await?;
    if !(200..300).contains(&answer.status) {
        return Err(format!("HTTP {} from {token_url}: {}", answer.status, head(&answer.body)));
    }
    let body = Js::parse(answer.body.as_bytes()).map_err(|_| format!("the answer from {token_url} has no access_token"))?;
    token_fields(&body).ok_or_else(|| format!("the answer from {token_url} has no access_token"))
}

// ── Connecting: the authorize URL and the code exchange ─────────────────────

/// What the redirect must bring back to be completed.
pub struct Attempt {
    pub state: String,
    pub redirect_uri: String,
    pub code_verifier: Option<String>,
}

const VERIFIER_BYTES: usize = 96;

pub fn pkce_challenge(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

/// The provider's authorize URL for one attempt (`beginOAuth2Connect`).
pub fn begin(oauth2: &OAuth2Declaration, client_id: &str, redirect_uri: &str, state: &str) -> Result<(String, Attempt), String> {
    let code_verifier = if oauth2.pkce { Some(base64url(&random_bytes(VERIFIER_BYTES)?)) } else { None };
    let mut url = url::Url::parse(&oauth2.authorize_url).map_err(|e| format!("{}: {e}", oauth2.authorize_url))?;
    let mut pairs: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    let mut set = |key: &str, value: &str| match pairs.iter().position(|(k, _)| k == key) {
        // `URLSearchParams.set`: the first keeps its place, the others go.
        Some(at) => {
            pairs[at].1 = value.to_string();
            let mut seen = 0;
            pairs.retain(|(k, _)| {
                if k != key {
                    return true;
                }
                seen += 1;
                seen == 1
            });
        }
        None => pairs.push((key.to_string(), value.to_string())),
    };
    set("response_type", "code");
    set("client_id", client_id);
    set("redirect_uri", redirect_uri);
    if !oauth2.scopes.is_empty() {
        set("scope", &oauth2.scopes.join(" "));
    }
    set("state", state);
    if let Some(verifier) = &code_verifier {
        set("code_challenge", &pkce_challenge(verifier));
        set("code_challenge_method", "S256");
    }
    for (key, value) in &oauth2.authorize_params {
        set(key, value);
    }
    url.set_query(Some(&form_text(&pairs)));
    Ok((url.to_string(), Attempt { state: state.to_string(), redirect_uri: redirect_uri.to_string(), code_verifier }))
}

const EXCHANGE_TRIES: u32 = 3;
const EXCHANGE_RETRY_DELAY_MS: u64 = 250;

/// Exchange the code the redirect brought back (`exchangeOAuth2Code`): the
/// token fields. A 5xx or a network error is retried twice.
pub async fn exchange_code(oauth2: &OAuth2Declaration, client: &ClientApp, attempt: &Attempt, code: &str) -> Result<Fields, String> {
    let token_url = &oauth2.token_url;
    let failed = |detail: String| format!("exchanging the authorization code at {token_url} failed: {detail}");
    let mut form = vec![
        ("grant_type".to_string(), "authorization_code".to_string()),
        ("code".to_string(), code.to_string()),
        ("redirect_uri".to_string(), attempt.redirect_uri.clone()),
    ];
    if let Some(verifier) = &attempt.code_verifier {
        form.push(("code_verifier".into(), verifier.clone()));
    }
    let mut headers = token_headers();
    authenticate(client, oauth2.client_auth, &mut form, &mut headers);
    let hidden: Vec<String> = [Some(code.to_string()), client.client_secret.clone(), attempt.code_verifier.clone()].into_iter().flatten().collect();
    let mut tried = 1;
    let answer = loop {
        match post(token_url, &headers, form_text(&form)).await {
            Ok(answer) if answer.status < 500 || tried >= EXCHANGE_TRIES => break answer,
            Ok(_) => {}
            Err(why) if tried >= EXCHANGE_TRIES => return Err(failed(redact_secrets(&why, hidden.iter()))),
            Err(_) => {}
        }
        tokio::time::sleep(Duration::from_millis(EXCHANGE_RETRY_DELAY_MS * 2u64.pow(tried - 1))).await;
        tried += 1;
    };
    if !(200..300).contains(&answer.status) {
        return Err(failed(format!("HTTP {}: {}", answer.status, redact_secrets(&head(&answer.body), hidden.iter()))));
    }
    let body = Js::parse(answer.body.as_bytes()).map_err(|_| failed("the answer is not JSON".into()))?;
    token_fields(&body).ok_or_else(|| failed("the answer has no access_token".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn declared(json: &str) -> Result<Vec<Declaration>, String> {
        declarations_of(&Js::parse(format!("{{\"credentials\": {json}}}").as_bytes()).unwrap())
    }

    #[test]
    fn declarations_are_read_and_held_to_the_schema() {
        let read = declared(r#"[{ "name": "acme", "kind": "oauth2", "fields": [{ "name": "workspace", "secret": false }], "oauth2": { "authorizeUrl": "https://a.test/authorize", "tokenUrl": "https://a.test/token", "scopes": ["crm.read"], "pkce": true } }]"#).unwrap();
        assert_eq!(read[0].name, "acme");
        assert_eq!(read[0].oauth2().unwrap().scopes, vec!["crm.read".to_string()]);
        assert!(declared(r#"[{ "name": "x", "kind": "magic", "fields": [] }]"#).is_err());
        assert!(declared(r#"[{ "name": "x", "kind": "oauth2", "fields": [], "oauth2": { "authorizeUrl": "nope", "tokenUrl": "https://a.test/t" } }]"#).is_err());
    }

    #[test]
    fn only_declared_fields_travel_and_only_declared_updates_land() {
        let d = &declared(r#"[{ "name": "acme", "kind": "oauth2", "fields": [{ "name": "webhook_secret" }], "oauth2": { "authorizeUrl": "https://a.test/a", "tokenUrl": "https://a.test/t" } }]"#).unwrap()[0];
        let stored: Fields = [("access_token", "a"), ("client_secret", "s"), ("webhook_secret", "w"), ("token", "t")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        assert_eq!(declared_fields(d, &stored).keys().collect::<Vec<_>>(), vec!["access_token", "webhook_secret"]);
        let foreign = accepted_fields("acme_crm", d, Fields::from([("client_secret".to_string(), "x".to_string())])).unwrap_err();
        assert_eq!(foreign, "Remote adapter \"acme_crm\" answered credential fields it does not declare: client_secret");
    }

    #[test]
    fn the_authorize_url_carries_what_the_declaration_asks() {
        let o = OAuth2Declaration {
            authorize_url: "http://127.0.0.1:9/authorize?keep=1".into(),
            token_url: "http://127.0.0.1:9/token".into(),
            scopes: vec!["a".into(), "b".into()],
            client_auth: None,
            pkce: true,
            authorize_params: vec![("access_type".into(), "offline".into())],
        };
        let (url, attempt) = begin(&o, "lf app", "http://127.0.0.1:8765/callback", "st").unwrap();
        let parsed = url::Url::parse(&url).unwrap();
        let q: Vec<(String, String)> = parsed.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        let get = |k: &str| q.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!(get("keep"), Some("1"));
        assert_eq!(get("client_id"), Some("lf app"));
        assert_eq!(get("scope"), Some("a b"));
        assert_eq!(get("code_challenge"), Some(pkce_challenge(attempt.code_verifier.as_deref().unwrap()).as_str()));
        assert_eq!(get("access_type"), Some("offline"));
        assert!(url.contains("client_id=lf+app"));
    }
}
