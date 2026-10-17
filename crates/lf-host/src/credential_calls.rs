//! One protocol call to an external under a credential, as the TypeScript lf
//! makes it (apps/cli/src/{externals,remote,secrets}.ts over movement-engine's
//! RemoteAdapter):
//!
//! - An external whose manifest declares a credential is sent it on each call
//!   (the request's `credential`): only the fields the declaration names (and
//!   an `oauth2` one's tokens), and only over HTTPS or to a loopback address.
//!   It is refreshed by the host from the declaration (the standard OAuth 2
//!   grant at its token URL), or by the module's own `refreshCredential` when
//!   it lists one; a `credentialUpdate` it answers — on a failed answer too —
//!   is written back to the credential it was sent.
//! - Otherwise a credential holding `refresh_token` and `token_url` is
//!   refreshed by lf's own convention (the client in the form body).
//!
//! Either way the refresh runs before a call whose token expires within 30 s,
//! and once more when the call answers `unauthorized`, through the
//! credential's secrets family; the call's bearer secret is read as the
//! credential stands after it.

use serde_json::json;

use crate::externals::External;
use crate::json::Js;
use crate::oauth2::{ClientApp, ClientAuth, Declaration, accepted_fields, client_from_fields, declared_fields, refresh_grant};
use crate::protocol::{Call, RpcError, post_rpc_carrying};
use crate::remote::CallFailure;
use crate::secret_stores::{current_fields, secrets_of};
use crate::secrets::{Credential, Credentials, install_of};
use crate::secrets_family::{Fields, LocalFuture, Record, Refresher, SecretError, SecretsFamily, with_secret};

/// Where a call goes, and what the external's manifest declared (nothing yet
/// for the manifest call itself).
pub struct Target<'a> {
    pub external: &'a External,
    pub base_url: &'a str,
    pub declarations: &'a [Declaration],
    pub methods: &'a [String],
}

#[derive(Debug)]
pub enum SendError {
    /// Refused before anything was sent.
    Before(String),
    Secret(SecretError),
    Rpc(RpcError),
}

impl From<SecretError> for SendError {
    fn from(error: SecretError) -> SendError {
        SendError::Secret(error)
    }
}

impl From<SendError> for String {
    fn from(error: SendError) -> String {
        match error {
            SendError::Before(message) => message,
            SendError::Secret(error) => error.message(),
            SendError::Rpc(error) => error.message(),
        }
    }
}

impl From<SendError> for CallFailure {
    fn from(error: SendError) -> CallFailure {
        match error {
            SendError::Before(message) => CallFailure::Adapter { message, name: None, status: None },
            SendError::Secret(error) => CallFailure::Adapter { message: error.message(), name: Some(error.name().to_string()), status: None },
            SendError::Rpc(error) => error.into(),
        }
    }
}

pub struct Sending<'a> {
    pub tenant: &'a str,
    pub method: &'a str,
    pub cache_scope_id: &'a str,
    pub params: serde_json::Value,
}

/// One call as `credential`, its bearer secret read off `signer` (the entry
/// whose secret the external checks; today the credential itself).
pub async fn send(
    target: &Target<'_>,
    credentials: &Credentials,
    credential: Option<&Credential>,
    signer: Option<&Credential>,
    sending: Sending<'_>,
) -> Result<Js, SendError> {
    let Some(credential) = credential else {
        let bearer = bearer_of(target.external, signer.map(|s| (s.name.as_str(), current_fields(s)))).map_err(SendError::Before)?;
        return post(target, &sending, bearer.as_deref(), None).await.0.map_err(SendError::Rpc);
    };
    let family = secrets_of(credential);
    let bearer_for = |record: &Record| -> Result<Option<String>, SendError> {
        let signed_by = match signer {
            Some(s) if s.name == credential.name => Some((s.name.as_str(), record.fields.clone())),
            Some(s) => Some((s.name.as_str(), current_fields(s))),
            None => None,
        };
        bearer_of(target.external, signed_by).map_err(SendError::Before)
    };
    let unauthorized = |error: &SendError| matches!(error, SendError::Rpc(RpcError::Protocol { code, .. }) if code == "unauthorized");

    // The protocol carries one credential per request: the first declared.
    let Some(declaration) = target.declarations.first() else {
        let refresher = fields_refresher(credential);
        return with_secret(&family, &credential.name, refresher.as_deref(), unauthorized, |record| {
            let sending = &sending;
            async move {
                let bearer = bearer_for(&record)?;
                post(target, sending, bearer.as_deref(), None).await.0.map_err(SendError::Rpc)
            }
        })
        .await;
    };
    let adapter_type = &target.external.manifest.name;
    if !is_credential_channel(target.base_url) {
        return Err(SendError::Before(format!(
            "Remote adapter \"{adapter_type}\" at {}: a credential is sent only over HTTPS or to a loopback address",
            target.base_url
        )));
    }
    let refresher = declared_refresher(target, credentials, credential, declaration, &sending, &bearer_for);
    with_secret(&family, &credential.name, refresher.as_deref(), unauthorized, |record| {
        let (sending, family) = (&sending, &family);
        async move {
            let bearer = bearer_for(&record)?;
            let sent = json!({ "name": declaration.name, "fields": declared_fields(declaration, &record.fields) });
            let (answer, update) = post(target, sending, bearer.as_deref(), Some(sent)).await;
            if let Some(update) = update {
                store_update(family, &credential.name, adapter_type, declaration, &update, &record.version).await?;
            }
            answer.map_err(SendError::Rpc)
        }
    })
    .await
}

async fn post(target: &Target<'_>, sending: &Sending<'_>, bearer: Option<&str>, credential: Option<serde_json::Value>) -> (Result<Js, RpcError>, Option<Js>) {
    let call = Call {
        base_url: target.base_url,
        bearer,
        team_id: sending.tenant,
        method: sending.method,
        cache_scope_id: sending.cache_scope_id,
        params: sending.params.clone(),
    };
    post_rpc_carrying(call, credential).await
}

/// The `Authorization` secret: the named field of the signing entry (externals.ts `callSecret`).
fn bearer_of(external: &External, signer: Option<(&str, Fields)>) -> Result<Option<String>, String> {
    let Some(auth) = &external.manifest.auth else { return Ok(None) };
    let name = &external.manifest.name;
    let Some((signer, fields)) = signer else {
        return Err(format!("external \"{name}\" needs a credential (its auth field is \"{}\")", auth.field));
    };
    match fields.get(&auth.field) {
        Some(secret) => Ok(Some(secret.clone())),
        None => Err(format!("credential \"{signer}\" has no \"{}\" field, which external \"{name}\" sends", auth.field)),
    }
}

/// HTTPS, or plain HTTP to a loopback address (`isCredentialChannel`).
fn is_credential_channel(base_url: &str) -> bool {
    let Ok(url) = url::Url::parse(base_url) else { return false };
    match url.scheme() {
        "https" => true,
        "http" => match url.host() {
            Some(url::Host::Domain(d)) => d == "localhost",
            Some(url::Host::Ipv4(ip)) => ip.octets()[0] == 127,
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            None => false,
        },
        _ => false,
    }
}

/// lf's own convention for a credential no manifest declares: `refresh_token`
/// and `token_url` among its fields, the client in the form body.
fn fields_refresher<'a>(credential: &Credential) -> Option<Box<Refresher<'a>>> {
    let fields = current_fields(credential);
    let token_url = fields.get("token_url")?.clone();
    fields.get("refresh_token")?;
    Some(Box::new(move |current: Record| -> LocalFuture<'a, Result<Fields, String>> {
        let token_url = token_url.clone();
        Box::pin(async move { refresh_grant(&current, &token_url, Some(ClientAuth::Body), None).await })
    }))
}

/// The host's refresher for a declared credential: the module's own
/// `refreshCredential` when it lists one, else the generic grant for an
/// `oauth2` one (the app: the credential's own client fields, else its
/// install's), none for a `static` one.
fn declared_refresher<'a>(
    target: &'a Target<'a>,
    credentials: &Credentials,
    credential: &Credential,
    declaration: &'a Declaration,
    sending: &'a Sending<'a>,
    bearer_for: &'a (dyn Fn(&Record) -> Result<Option<String>, SendError> + 'a),
) -> Option<Box<Refresher<'a>>> {
    if target.methods.iter().any(|m| m == "refreshCredential") {
        return Some(Box::new(move |current: Record| -> LocalFuture<'a, Result<Fields, String>> {
            Box::pin(async move {
                let bearer = bearer_for(&current).map_err(String::from)?;
                let sent = json!({ "name": declaration.name, "fields": declared_fields(declaration, &current.fields) });
                let refreshing = Sending { tenant: sending.tenant, method: "refreshCredential", cache_scope_id: sending.cache_scope_id, params: json!({}) };
                let (answer, update) = post(target, &refreshing, bearer.as_deref(), Some(sent)).await;
                let result = answer.map_err(|e| e.message())?;
                let mut changed = match update {
                    Some(update) => update_of(&target.external.manifest.name, &update)?.1,
                    None => Fields::new(),
                };
                let fields = result.get("fields").and_then(string_fields).ok_or_else(|| {
                    crate::protocol::shape_error("refreshCredential", &target.external.manifest.name, &result, "fields: expected a record of strings")
                })?;
                changed.extend(fields);
                accepted_fields(&target.external.manifest.name, declaration, changed)
            })
        }));
    }
    let oauth2 = declaration.oauth2()?.clone();
    let own = client_from_fields(&current_fields(credential));
    let client: Option<ClientApp> = own.or_else(|| install_of(credentials, &credential.external).and_then(|i| client_from_fields(&current_fields(i))));
    Some(Box::new(move |current: Record| -> LocalFuture<'a, Result<Fields, String>> {
        let (oauth2, client) = (oauth2.clone(), client.clone());
        Box::pin(async move { refresh_grant(&current, &oauth2.token_url, oauth2.client_auth, client.as_ref()).await })
    }))
}

fn string_fields(value: &Js) -> Option<Fields> {
    match value {
        Js::Obj(map) => map.iter().map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect(),
        _ => None,
    }
}

/// A `credentialUpdate` held to `WireCredentialUpdate`.
fn update_of(adapter_type: &str, update: &Js) -> Result<(String, Fields), String> {
    let name = update.get("name").and_then(Js::as_str).filter(|n| !n.is_empty());
    let fields = update.get("fields").and_then(string_fields);
    match (name, fields) {
        (Some(name), Some(fields)) => Ok((name.to_string(), fields)),
        _ => Err(crate::protocol::shape_error("credentialUpdate", adapter_type, update, "expected { name, fields }")),
    }
}

/// Store a `credentialUpdate` over the credential the call was sent. If the
/// stored one moved on meanwhile, the update still lands over it: losing a
/// rotated refresh token is worse than replacing a newer access token.
async fn store_update(family: &SecretsFamily, reference: &str, adapter_type: &str, declaration: &Declaration, update: &Js, sent_version: &str) -> Result<(), SendError> {
    let (name, fields) = update_of(adapter_type, update).map_err(SendError::Before)?;
    if name != declaration.name {
        return Err(SendError::Before(format!(
            "Remote adapter \"{adapter_type}\" answered an update for credential \"{name}\", which it was not sent"
        )));
    }
    let fields = accepted_fields(adapter_type, declaration, fields).map_err(SendError::Before)?;
    match family.write_back(reference, &fields, sent_version).await {
        Ok(_) => Ok(()),
        Err(SecretError::Conflict(_)) => family.update(reference, &fields).await.map(drop).map_err(SendError::Secret),
        Err(other) => Err(SendError::Secret(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::is_credential_channel;

    #[test]
    fn a_credential_goes_only_over_https_or_to_loopback() {
        assert!(is_credential_channel("https://crm.example.com/rpc"));
        assert!(is_credential_channel("http://127.0.0.1:5557/"));
        assert!(is_credential_channel("http://localhost:5557/"));
        assert!(is_credential_channel("http://[::1]:5557/"));
        assert!(!is_credential_channel("http://crm.example.com/"));
        assert!(!is_credential_channel("http://10.0.0.1/"));
    }
}
