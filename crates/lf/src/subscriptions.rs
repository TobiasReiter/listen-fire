//! A source's webhook, registered at the source by `lf serve` (the
//! platform's listen reconciliation, for one machine): when it starts, each
//! external that lists `ensureEventSubscription` and takes webhooks is asked
//! to register a webhook for the events its live listens name, pointed at the
//! webhook door under lf.yaml's `publicUrl`; one whose listens are all gone
//! has its webhook removed (`removeEventSubscription`).
//!
//! The registration is kept on the credential it is made under (the
//! external's user credential, whose token reaches the source), and that
//! credential names the door: `/api/public/webhook-sync/<provider>/<credential>`.
//! A secret the source issues is that credential's webhook secret, so the
//! door verifies deliveries with it. Kept there, the next start sees what is
//! registered: the same events and URL ask the module, which leaves the
//! webhook as it is; other events change it in place; another URL replaces it.

use std::collections::BTreeSet;

use crate::connect::spread;
use crate::doors::inbound_of;
use crate::externals::{RunningExternal, rpc};
use crate::check::LOCAL_TENANT;
use crate::json::Js;
use crate::runs::Session;
use crate::secret_stores::{EntryChange, change_entry};
use crate::secrets::{Credential, credential_for};

/// The source's id for the webhook it registered.
const WEBHOOK_ID_FIELD: &str = "webhook_id";
/// The events it is registered for, comma-separated.
const WEBHOOK_EVENTS_FIELD: &str = "webhook_events";
/// Where it delivers.
const WEBHOOK_URL_FIELD: &str = "webhook_url";

/// What one credential's entry holds of its registration.
struct Registered {
    id: Option<String>,
    events: Vec<String>,
    url: Option<String>,
}

impl Registered {
    fn of(credential: &Credential) -> Registered {
        let field = |name: &str| credential.fields.get(name).filter(|v| !v.is_empty()).cloned();
        Registered {
            id: field(WEBHOOK_ID_FIELD),
            events: field(WEBHOOK_EVENTS_FIELD).map(|e| e.split(',').map(str::to_string).collect()).unwrap_or_default(),
            url: field(WEBHOOK_URL_FIELD),
        }
    }
}

/// The events the external's listens need: each listen's `events`, else
/// the module's default subscription, else everything it can subscribe to.
fn wanted_events(session: &Session, running: &RunningExternal) -> Vec<String> {
    let declared = |key: &str| -> Vec<String> {
        running.listen.get(key).and_then(Js::as_array).into_iter().flatten().filter_map(Js::as_str).map(str::to_string).collect()
    };
    let fallback = {
        let defaults = declared("defaultSubscribedEvents");
        if defaults.is_empty() { declared("subscribableEvents") } else { defaults }
    };
    let mut events = BTreeSet::new();
    for listen in session.listens().iter().filter(|l| l.adapter == running.external.manifest.name) {
        match listen.config.get("events").and_then(Js::as_array) {
            Some(named) => events.extend(named.iter().filter_map(Js::as_str).map(str::to_string)),
            None => events.extend(fallback.iter().cloned()),
        }
    }
    events.into_iter().collect()
}

/// Register or remove each external's webhook, as its listens need; a line
/// per external it touched. One that fails is said and the rest go on: the
/// doors still answer whatever is registered.
pub async fn reconcile(session: &mut Session) -> Vec<String> {
    let mut lines = Vec::new();
    let names: Vec<String> = session
        .running()
        .iter()
        .filter(|r| !r.is_plugin() && r.methods.iter().any(|m| m == "ensureEventSubscription") && inbound_of(r).is_some())
        .map(|r| r.external.manifest.name.clone())
        .collect();
    let mut changed = false;
    for name in names {
        match reconcile_one(session, &name).await {
            Ok(Some((line, wrote))) => {
                changed |= wrote;
                lines.push(format!("{name}: {line}"));
            }
            Ok(None) => {}
            Err(message) => lines.push(format!("{name}: its webhook is not registered — {message}")),
        }
    }
    if changed && let Err(message) = session.reload_credentials() {
        lines.push(format!("the secrets could not be read again after the webhooks changed: {message}"));
    }
    lines
}

/// One external: the line to print and whether its credential changed; None
/// when it has nothing registered and no listen.
async fn reconcile_one(session: &Session, name: &str) -> Result<Option<(String, bool)>, String> {
    let running = session.running().iter().find(|r| r.external.manifest.name == name).ok_or("not running")?;
    let wanted = wanted_events(session, running);
    let Some(credential) = credential_for(session.credentials(), name) else {
        return Ok((!wanted.is_empty()).then(|| (format!("no credential to register its webhook under: lf credential add --module {name} <name>"), false)));
    };
    let registered = Registered::of(credential);
    let setup = inbound_of(running).ok_or("it takes no webhooks")?;
    let provider = setup.declaration.provider_key.clone();
    let issued_by_provider = setup.declaration.secret_from_provider;
    let secret_field = setup.secret_field;
    let call = |method: &'static str, params: serde_json::Value| async move {
        let raw = rpc(running, session.credentials(), LOCAL_TENANT, method, params).await?;
        crate::wire_results::check(method, name, &raw)
    };

    if wanted.is_empty() {
        let Some(id) = registered.id else { return Ok(None) };
        let url = registered.url.clone().unwrap_or_default();
        call("removeEventSubscription", serde_json::json!({ "callbackUrl": url, "externalId": id })).await?;
        // Its secret too: nothing is delivered to that door now.
        forget(credential, &[WEBHOOK_ID_FIELD, WEBHOOK_EVENTS_FIELD, WEBHOOK_URL_FIELD, &secret_field]).await?;
        return Ok(Some((format!("no listen needs its webhook any more; removed webhook {id}"), true)));
    }
    let Some(public) = session.project.public_url.as_deref() else {
        return Ok(Some((format!("set publicUrl in lf.yaml to where {name} reaches lf serve; its webhook is not registered"), false)));
    };
    let callback = format!("{}/api/public/webhook-sync/{provider}/{}", public.trim_end_matches('/'), credential.name);

    // Another URL: the webhook there is replaced, not moved.
    let mut current = registered.id.clone().map(|id| (id, registered.events.clone()));
    if let (Some((id, _)), Some(url)) = (&current, &registered.url)
        && *url != callback
    {
        call("removeEventSubscription", serde_json::json!({ "callbackUrl": url, "externalId": id })).await?;
        current = None;
    }
    let mut params = serde_json::json!({ "events": wanted, "callbackUrl": callback });
    if let Some((id, events)) = &current {
        params["current"] = serde_json::json!({ "externalId": id, "events": events });
    }
    let had_webhook = current.is_some();
    let answer = call("ensureEventSubscription", params).await?;
    let events = wanted.join(",");
    if answer == Js::Null {
        let id = current.map(|(id, _)| id).unwrap_or_default();
        return Ok(Some((format!("webhook {id} is registered for {events} at {callback}"), false)));
    }
    let id = answer.get("externalId").and_then(Js::as_str).map(str::to_string).or(current.map(|(id, _)| id)).unwrap_or_default();
    let mut fields = vec![(WEBHOOK_ID_FIELD.to_string(), id.clone()), (WEBHOOK_EVENTS_FIELD.to_string(), events.clone()), (WEBHOOK_URL_FIELD.to_string(), callback.clone())];
    let issued = answer.get("secret").and_then(Js::as_str).filter(|s| !s.is_empty());
    // The provider issues the secret (`secretIssuedBy: provider`) and none is
    // held: nothing could verify a delivery, so the webhook is withdrawn.
    let held = credential.fields.get(&secret_field).is_some_and(|s| !s.is_empty()) && had_webhook;
    if issued_by_provider && issued.is_none() && !held {
        call("removeEventSubscription", serde_json::json!({ "callbackUrl": callback, "externalId": id })).await?;
        return Ok(Some((format!("registering its webhook returned no secret, and {name} issues the secret deliveries are signed with: withdrawn, as none could be verified"), false)));
    }
    if let Some(secret) = issued {
        fields.push((secret_field, secret.to_string()));
    }
    keep(credential, fields).await?;
    Ok(Some((format!("registered webhook {id} for {events} at {callback}"), true)))
}

/// The credential's entry, as written by lf, its other fields kept.
fn writable(credential: &Credential) -> Result<&crate::secrets::SecretsFile, String> {
    match &credential.origin.file {
        Some(file) if credential.origin.env_fields.is_empty() => Ok(file),
        _ => Err(format!("credential \"{}\" comes from the environment, which lf cannot write the registration to", credential.name)),
    }
}

async fn keep(credential: &Credential, fields: Vec<(String, String)>) -> Result<(), String> {
    let file = writable(credential)?;
    change_entry(file, &credential.name, EntryChange::Replace(&|stored| Ok(spread(stored.unwrap_or_default(), fields.clone())))).await
}

async fn forget(credential: &Credential, names: &[&str]) -> Result<(), String> {
    let file = writable(credential)?;
    change_entry(file, &credential.name, EntryChange::Replace(&|stored| Ok(stored.unwrap_or_default().into_iter().filter(|(k, _)| !names.contains(&k.as_str())).collect()))).await
}
