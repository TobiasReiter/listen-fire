//! lf's inbound doors, on the inbound core (crate::inbound): the core owns
//! verification, the delivery pipeline and the push doors' answers; this file
//! is what lf keeps behind them (apps/cli/src/doors.ts).
//!
//!   POST /api/public/webhook-sync/<provider>/<install>   a provider's delivery
//!        (`/hooks/<external>/<install>` is the same door under lf's older name)
//!   POST /api/public/adapter/<external>/emit  { events }  an external's new data
//!   POST /api/public/adapter/<external>/wake  { keys }    resume what is parked
//!
//! An install is a credential in the secrets file; its name is the
//! "subscription" in the URL. A delivery's signature is checked by the scheme
//! the external's manifest declares (`inbound`), or, for an external that
//! declares none, by its `lf-external.yaml` `webhook:` block (the protocol's
//! own scheme). A signed delivery with no usable secret is refused, as
//! everywhere. Events are queued as `fire_event` work rows and wakes as
//! `wake_await` rows in lf's state, drained by `lf serve`.

use std::cell::RefCell;

use rusqlite::{OptionalExtension, params};

use crate::check::LOCAL_TENANT;
use crate::credential_calls::{Sending, Target, send};
use crate::externals::RunningExternal;
use crate::inbound::{Answer, Declaration, Delivery, Extraction, InboundStore, Intercept, PushAuth, PushCaller, PushStore, Scheme, Source, Subscription, answer_delivery, same_secret};
use crate::json::Js;
use crate::obj;
use crate::run_host::queue_await_wake;
use crate::runs::{RunOutcome, Session};
use crate::secrets::{Credential, credential_for};
use crate::backend::RunHostStore;
use crate::store::{Store, StoreError};

/// The field of an install's credential that holds the webhook secret when
/// the external declares `inbound` and `lf-external.yaml` names none.
pub const DEFAULT_WEBHOOK_SECRET_FIELD: &str = "webhook_secret";

/// How an external's deliveries are verified (`InboundSetup`).
#[derive(Clone)]
pub struct InboundSetup {
    pub declaration: Declaration,
    pub secret_field: String,
}

impl InboundSetup {
    /// The provider segment its door answers to. Doors compare it upper-cased,
    /// so any casing in a URL reaches it.
    fn provider_key(&self) -> String {
        self.declaration.provider_key.to_uppercase()
    }
}

/// An external, as the doors see it: how its deliveries are verified, and
/// which credential field its pushes present.
#[derive(Clone)]
pub struct Served {
    pub external: String,
    pub inbound: Option<InboundSetup>,
    /// The field of an install's credential a push presents as its bearer.
    pub push_field: Option<String>,
}

/// `inboundSetupOf`: the manifest's `inbound`, else the `webhook:` block as
/// the protocol's own scheme.
fn served_of(running: &RunningExternal) -> Served {
    let manifest = &running.external.manifest;
    let yaml = manifest.webhook.as_ref();
    let inbound = match &running.inbound {
        Some(declaration) => Some(InboundSetup {
            declaration: declaration.clone(),
            secret_field: yaml.map(|w| w.secret_field.clone()).unwrap_or_else(|| DEFAULT_WEBHOOK_SECRET_FIELD.into()),
        }),
        None => yaml.map(|w| InboundSetup {
            declaration: Declaration { provider_key: manifest.name.clone(), scheme: Scheme::Remote, signature_headers: vec![w.header.to_lowercase()], intercepts: Vec::new() },
            secret_field: w.secret_field.clone(),
        }),
    };
    Served { external: manifest.name.clone(), inbound, push_field: manifest.auth.as_ref().map(|a| a.field.clone()) }
}

/// What reads a delivery for the doors: the external, over the protocol, in
/// lf; the inbound contract suite's adapter in its bridge.
pub trait Reader {
    /// Whether the external reads deliveries (`preprocessInbound`).
    fn reads_deliveries(&self, external: &str) -> bool;
    async fn preprocess(&self, external: &str, install: &Credential, raw: &Js, checkpoint: Option<&Js>) -> Result<Extraction, String>;
    /// The keys a delivery wakes; empty when the external names none.
    async fn wake_keys(&self, external: &str, install: &Credential, raw: &Js) -> Result<Vec<String>, String>;
}

/// Where a verified event goes.
pub enum EventSink<'a> {
    /// A `fire_event` work row, for the drain.
    Queue,
    /// Run now, inside the request, its runs kept (`/hooks/…`, `lf run --webhook`).
    Inline { session: &'a Session, outcomes: &'a RefCell<Vec<RunOutcome>> },
}

/// lf's side of the core's two store interfaces (`createLfInboundStores`).
pub struct LfDoors<'a, R: Reader> {
    pub store: &'a dyn RunHostStore,
    pub served: Vec<Served>,
    pub installs: &'a [Credential],
    pub reader: R,
    pub sink: EventSink<'a>,
    /// Poke the drain: work rows were queued.
    pub notify: &'a dyn Fn(),
}

impl<'a> LfDoors<'a, SessionReader<'a>> {
    /// The doors over a session: its externals, its installs, its state.
    pub fn of_session(session: &'a Session, sink: EventSink<'a>, notify: &'a dyn Fn()) -> LfDoors<'a, SessionReader<'a>> {
        LfDoors {
            store: &*session.store,
            served: session.running().iter().map(served_of).collect(),
            installs: session.credentials(),
            reader: SessionReader { session },
            sink,
            notify,
        }
    }
}

impl<R: Reader> LfDoors<'_, R> {
    fn install(&self, name: &str) -> Option<&Credential> {
        self.installs.iter().find(|c| c.name == name)
    }

    fn setup_of(&self, external: &str) -> Option<&InboundSetup> {
        self.served.iter().find(|s| s.external == external).and_then(|s| s.inbound.as_ref())
    }

    fn serving(&self, provider_key: &str) -> Option<&InboundSetup> {
        self.served.iter().filter_map(|s| s.inbound.as_ref()).find(|setup| setup.provider_key() == provider_key)
    }

    async fn fire(&self, external: &str, event: Js) -> Result<(), String> {
        match &self.sink {
            EventSink::Queue => {
                let payload = Js::Obj(obj! { "external" => Js::str(external), "event" => event });
                self.store.enqueue("fire_event", &format!("fire_event:{}", uuid::Uuid::new_v4()), &payload, None, None).map_err(|e| e.to_string())
            }
            EventSink::Inline { session, outcomes } => {
                let ran = session.fire_event(external, &event, false).await?;
                outcomes.borrow_mut().extend(ran);
                Ok(())
            }
        }
    }

    fn queue_wakes(&self, adapter_type: &str, team_id: &str, keys: &[String]) -> Result<(), String> {
        for key in keys {
            queue_await_wake(self.store, adapter_type, team_id, key)?;
        }
        Ok(())
    }
}

impl<R: Reader> InboundStore for LfDoors<'_, R> {
    async fn find_subscription(&self, id: &str) -> Result<Option<Subscription>, String> {
        let Some(credential) = self.install(id) else { return Ok(None) };
        let Some(setup) = self.setup_of(&credential.external) else { return Ok(None) };
        Ok(Some(Subscription {
            id: id.to_string(),
            team_id: LOCAL_TENANT.into(),
            provider_key: setup.provider_key(),
            secret: credential.fields.get(&setup.secret_field).cloned().unwrap_or_default(),
            checkpoint: self.store.inbound_checkpoint(id).map_err(|e| e.to_string())?,
        }))
    }

    fn knows_provider(&self, provider_key: &str) -> bool {
        self.serving(provider_key).is_some()
    }

    fn intercepts(&self, provider_key: &str) -> Vec<Intercept> {
        self.serving(provider_key).map(|setup| setup.declaration.intercepts.clone()).unwrap_or_default()
    }

    async fn source_for(&self, subscription: &Subscription) -> Result<Option<Source>, String> {
        let Some(credential) = self.install(&subscription.id) else { return Ok(None) };
        let Some(setup) = self.setup_of(&credential.external) else { return Ok(None) };
        Ok(Some(Source {
            declaration: setup.declaration.clone(),
            secret: subscription.secret.clone(),
            adapter_type: credential.external.clone(),
            install: credential.name.clone(),
        }))
    }

    fn reads_deliveries(&self, source: &Source) -> bool {
        self.reader.reads_deliveries(&source.adapter_type)
    }

    async fn preprocess(&self, source: &Source, raw: &Js, checkpoint: Option<&Js>) -> Result<Extraction, String> {
        let install = self.install(&source.install).ok_or_else(|| format!("no install {}", source.install))?;
        self.reader.preprocess(&source.adapter_type, install, raw, checkpoint).await
    }

    async fn wake_keys(&self, source: &Source, raw: &Js) -> Result<Vec<String>, String> {
        let install = self.install(&source.install).ok_or_else(|| format!("no install {}", source.install))?;
        self.reader.wake_keys(&source.adapter_type, install, raw).await
    }

    // lf keeps no receipts: the event itself is what is queued.
    async fn capture(&self, event: &Js, _source: &Source) -> Result<Js, String> {
        Ok(event.clone())
    }

    async fn save_checkpoint(&self, subscription_id: &str, checkpoint: &Js) -> Result<(), String> {
        self.store.save_inbound_checkpoint(subscription_id, checkpoint).map_err(|e| e.to_string())
    }

    async fn enqueue(&self, captured: Js, source: &Source) -> Result<(), String> {
        self.fire(&source.adapter_type, captured).await
    }

    async fn enqueue_wakes(&self, adapter_type: &str, team_id: &str, keys: &[String]) -> Result<(), String> {
        self.queue_wakes(adapter_type, team_id, keys)
    }

    fn notify(&self) {
        (self.notify)();
    }
}

impl<R: Reader> PushStore for LfDoors<'_, R> {
    /// Which install of the external presented its credential: every install
    /// is compared, with no early exit.
    async fn authenticate(&self, adapter_type: &str, headers: &[(String, String)]) -> Result<PushAuth, String> {
        let Some(field) = self.served.iter().find(|s| s.external == adapter_type).and_then(|s| s.push_field.as_ref()) else {
            return Ok(PushAuth::Unauthorized);
        };
        let presented = crate::http::header(headers, "authorization");
        let mut matches = 0usize;
        for credential in self.installs.iter().filter(|c| c.external == adapter_type) {
            let Some(secret) = credential.fields.get(field) else { continue };
            if presented.is_some_and(|p| same_secret(p, &format!("Bearer {secret}"))) {
                matches += 1;
            }
        }
        Ok(match matches {
            0 => PushAuth::Unauthorized,
            1 => PushAuth::Authenticated(PushCaller { team_id: LOCAL_TENANT.into(), adapter_type: adapter_type.to_string() }),
            _ => PushAuth::Ambiguous,
        })
    }

    async fn capture_pushed(&self, caller: &PushCaller, event: &Js) -> Result<Vec<Js>, String> {
        Ok(vec![Js::Obj(obj! { "external" => Js::str(&caller.adapter_type), "event" => event.clone() })])
    }

    async fn enqueue_pushed(&self, captured: Vec<Js>) -> Result<(), String> {
        for pushed in captured {
            let external = pushed.get("external").and_then(Js::as_str).unwrap_or_default().to_string();
            self.fire(&external, pushed.get("event").cloned().unwrap_or(Js::Null)).await?;
        }
        Ok(())
    }

    async fn enqueue_pushed_wakes(&self, adapter_type: &str, team_id: &str, keys: &[String]) -> Result<(), String> {
        self.queue_wakes(adapter_type, team_id, keys)
    }

    fn notify_pushed(&self) {
        (self.notify)();
    }
}

// ── The external, as the reader ─────────────────────────────────────────────

/// Deliveries read by the external over the protocol, under the install's
/// credential. No `listEventTypes`: lf routes by the event itself, so a
/// delivery never costs the external a second call.
pub struct SessionReader<'a> {
    session: &'a Session,
}

impl SessionReader<'_> {
    async fn call(&self, external: &str, install: &Credential, method: &str, params: serde_json::Value) -> Result<Js, String> {
        let running = self.session.running().iter().find(|r| r.external.manifest.name == external).ok_or_else(|| format!("no external {external}"))?;
        // Signed by the install, carrying no user credential.
        let target = Target { external: &running.external, base_url: &running.base_url, declarations: &[], methods: &running.methods };
        let sending = Sending { tenant: LOCAL_TENANT, method, cache_scope_id: "<none>", params };
        let raw = send(&target, self.session.credentials(), None, Some(install), sending).await?;
        crate::wire_results::check(method, external, &raw)
    }

    fn lists(&self, external: &str, method: &str) -> bool {
        self.session.running().iter().any(|r| r.external.manifest.name == external && r.methods.iter().any(|m| m == method))
    }
}

impl Reader for SessionReader<'_> {
    fn reads_deliveries(&self, external: &str) -> bool {
        self.lists(external, "preprocessInbound")
    }

    async fn preprocess(&self, external: &str, install: &Credential, raw: &Js, checkpoint: Option<&Js>) -> Result<Extraction, String> {
        let mut params = serde_json::json!({ "raw": crate::wire::json_of_js(raw) });
        if let Some(checkpoint) = checkpoint {
            params["checkpoint"] = crate::wire::json_of_js(checkpoint);
        }
        let read = self.call(external, install, "preprocessInbound", params).await?;
        Ok(Extraction {
            events: read.get("events").and_then(Js::as_array).map(<[Js]>::to_vec).unwrap_or_default(),
            checkpoint: read.get("checkpoint").cloned(),
        })
    }

    async fn wake_keys(&self, external: &str, install: &Credential, raw: &Js) -> Result<Vec<String>, String> {
        if !self.lists(external, "wakeKeys") {
            return Ok(Vec::new());
        }
        let read = self.call(external, install, "wakeKeys", serde_json::json!({ "raw": crate::wire::json_of_js(raw) })).await?;
        Ok(read.as_array().unwrap_or(&[]).iter().filter_map(Js::as_str).map(str::to_string).collect())
    }
}

// ── The pull cursor ─────────────────────────────────────────────────────────

impl Store {
    /// The install's saved pull cursor, or None.
    pub fn inbound_checkpoint(&self, subscription_id: &str) -> Result<Option<Js>, StoreError> {
        let text: Option<String> =
            self.db.query_row("select checkpoint from inbound_checkpoint where subscription_id = ?", params![subscription_id], |r| r.get(0)).optional()?;
        match text {
            None => Ok(None),
            Some(text) => {
                let value = Js::parse(text.as_bytes()).map_err(|e| StoreError::Invalid(format!("a stored checkpoint is not JSON: {e}")))?;
                Ok((value != Js::Null).then_some(value))
            }
        }
    }

    pub fn save_inbound_checkpoint(&self, subscription_id: &str, checkpoint: &Js) -> Result<(), StoreError> {
        self.db.execute(
            "insert into inbound_checkpoint (subscription_id, checkpoint) values (?, ?) on conflict (subscription_id) do update set checkpoint = excluded.checkpoint",
            params![subscription_id, checkpoint.to_json()],
        )?;
        Ok(())
    }
}

// ── The legacy name: /hooks/<external>/<install> ───────────────────────────

/// The door's provider segment and subscription for lf's older
/// `/hooks/<external>[/<install>]` (`hookTarget`): the install is the
/// external's only credential when the URL names none. None: the external
/// takes no webhooks.
pub fn hook_target(session: &Session, external: &str, install: Option<&str>) -> Option<(String, String)> {
    let running = session.running().iter().find(|r| r.external.manifest.name == external)?;
    let setup = served_of(running).inbound?;
    let subscription = install.map(str::to_string).or_else(|| credential_for(session.credentials(), external).map(|c| c.name.clone())).unwrap_or_default();
    Some((setup.declaration.provider_key, subscription))
}

/// One delivery through the core with its events run inside the request, as
/// `/hooks/...` and `lf run --webhook` have always answered (`deliverInline`).
pub async fn deliver_inline(session: &Session, delivery: Delivery<'_>, notify: &dyn Fn()) -> (Answer, Vec<RunOutcome>) {
    let outcomes = RefCell::new(Vec::new());
    let doors = LfDoors::of_session(session, EventSink::Inline { session, outcomes: &outcomes }, notify);
    let answer = answer_delivery(&doors, delivery).await;
    drop(doors);
    (answer, outcomes.into_inner())
}

/// A delivery addressed by external, as `lf run --webhook` names it.
pub struct Webhook<'a> {
    pub external: &'a str,
    /// The install it is for; the external's only one when None.
    pub install: Option<&'a str>,
    pub raw_body: &'a [u8],
    pub headers: &'a [(String, String)],
}

/// `lf run --webhook`: a delivery taken as production takes one, its runs
/// returned; a refusal is an error (`receiveWebhook`).
pub async fn receive_webhook(session: &Session, webhook: Webhook<'_>) -> Result<Vec<RunOutcome>, String> {
    let Webhook { external, install, raw_body, headers } = webhook;
    let Some((provider, subscription_id)) = hook_target(session, external, install) else {
        return Err(format!("external \"{external}\" takes no webhooks"));
    };
    let delivery = Delivery { provider: &provider, subscription_id: &subscription_id, raw_body, headers };
    let (answer, outcomes) = deliver_inline(session, delivery, &|| {}).await;
    if answer.status == 200 {
        return Ok(outcomes);
    }
    let code = answer.body.get("error").and_then(Js::as_str).unwrap_or("unreadable");
    Err(if code == "signature_invalid" {
        format!("signature did not verify for external \"{external}\"")
    } else {
        format!("delivery refused: {code} ({})", answer.status)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_checkpoint_round_trips_and_null_reads_as_none() {
        let dir = std::env::temp_dir().join(format!("lf-doors-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("state.db")).unwrap();
        assert_eq!(store.inbound_checkpoint("sub").unwrap(), None);
        store.save_inbound_checkpoint("sub", &Js::parse(br#"{"cursor":"c-2"}"#).unwrap()).unwrap();
        assert_eq!(store.inbound_checkpoint("sub").unwrap().map(|c| c.to_json()).as_deref(), Some(r#"{"cursor":"c-2"}"#));
        store.save_inbound_checkpoint("sub", &Js::Null).unwrap();
        assert_eq!(store.inbound_checkpoint("sub").unwrap(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
