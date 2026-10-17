//! `lf-host --contract-doors`: lf's inbound doors (crate::doors over the
//! inbound core) served over HTTP on a loopback port, the world they read
//! arranged over stdin/stdout JSON-RPC, so the TypeScript inbound contract
//! suite (movement-engine `services/inbound/contract.ts`) holds them to the
//! cases every host's doors pass. As the suite's backend over the TypeScript
//! lf (apps/cli inbound_contract.test.ts): the world's providers and installs
//! become externals and credentials, the suite's adapter reads each delivery
//! (`{ events?, wake?, checkpoint? }`), and the store calls are observed, and
//! the suite's faults injected, around lf's own stores over a scratch state
//! file.
//!
//!   doors.baseUrl   → { baseUrl }
//!   doors.arrange   the world (`ContractWorld`) → null
//!   doors.observed  → what the doors did since the world was arranged

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

use crate::doors::{EventSink, InboundSetup, LfDoors, Reader, Served};
use crate::inbound::{Declaration, Extraction, InboundStore, PushAuth, PushCaller, PushStore, Source, Subscription};
use crate::json::Js;
use crate::obj;
use crate::secrets::Credential;
use crate::store::Store;

#[derive(Default, Clone, Copy)]
struct Faults {
    /// Capturing the event whose payload has `fail: true` throws.
    capture_marked: bool,
    /// Queueing any captured event throws.
    enqueue: bool,
    /// The adapter's wakeKeys throws.
    wake_keys: bool,
    /// Queueing the wakes throws.
    enqueue_wakes: bool,
}

#[derive(Default)]
struct World {
    served: Vec<Served>,
    installs: Vec<Credential>,
    faults: Faults,
}

#[derive(Default)]
struct Observations {
    captured: u64,
    enqueued: u64,
    wakes: Vec<String>,
    checkpoints: Vec<Js>,
    notified: u64,
}

struct Bridge {
    store: Store,
    world: RefCell<World>,
    seen: RefCell<Observations>,
}

pub async fn serve() -> Result<(), String> {
    let dir = std::env::temp_dir().join(format!("lf-contract-doors-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let store = Store::open(&dir.join("state.db")).map_err(|e| e.to_string())?;
    let bridge = Rc::new(Bridge { store, world: RefCell::new(World::default()), seen: RefCell::new(Observations::default()) });
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let base_url = format!("http://127.0.0.1:{}", listener.local_addr().map_err(|e| e.to_string())?.port());
    let doors = {
        let bridge = bridge.clone();
        tokio::task::spawn_local(crate::http::serve(listener, crate::serve::MAX_BODY_BYTES, move |request| {
            let bridge = bridge.clone();
            async move {
                let doors = bridge.doors();
                crate::serve::only_doors(&doors, request).await
            }
        }))
    };
    let answered = answer_lines(&bridge, &base_url).await;
    doors.abort();
    let _ = std::fs::remove_dir_all(&dir);
    answered
}

async fn answer_lines(bridge: &Bridge, base_url: &str) -> Result<(), String> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        if line.trim().is_empty() {
            continue;
        }
        let request = Js::parse(line.as_bytes()).unwrap_or(Js::Null);
        let id = request.get("id").cloned().unwrap_or(Js::Null);
        let params = request.get("params").cloned().unwrap_or(Js::Null);
        let answered = match request.get("method").and_then(Js::as_str) {
            Some("doors.baseUrl") => Ok(Js::Obj(obj! { "baseUrl" => Js::str(base_url) })),
            Some("doors.arrange") => bridge.arrange(&params).map(|()| Js::Null),
            Some("doors.observed") => Ok(bridge.observed()),
            other => Err(format!("no method {}", other.unwrap_or("(none)"))),
        };
        let reply = match answered {
            Ok(result) => obj! { "jsonrpc" => Js::str("2.0"), "id" => id, "result" => result },
            Err(message) => obj! { "jsonrpc" => Js::str("2.0"), "id" => id, "error" => Js::Obj(obj! { "code" => Js::Num((-32602).into()), "message" => Js::Str(message) }) },
        };
        stdout.write_all(format!("{}\n", Js::Obj(reply).to_json()).as_bytes()).await.map_err(|e| e.to_string())?;
        stdout.flush().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn list<'j>(value: &'j Js, key: &str) -> Result<&'j [Js], String> {
    value.get(key).and_then(Js::as_array).ok_or_else(|| format!("{key}: expected an array"))
}

fn text<'j>(value: &'j Js, key: &str) -> Result<&'j str, String> {
    value.get(key).and_then(Js::as_str).ok_or_else(|| format!("{key}: expected a string"))
}

impl Bridge {
    /// The world as lf holds it: each provider an external declaring its
    /// inbound (its key lower-cased), each subscription an install of it with
    /// its secret as `webhook_secret`, each push install a credential whose
    /// `token` its external's pushes present.
    fn arrange(&self, world: &Js) -> Result<(), String> {
        let mut served = Vec::new();
        for provider in list(world, "providers")? {
            let key = text(provider, "providerKey")?.to_lowercase();
            let mut declared = provider.clone();
            if let Js::Obj(map) = &mut declared {
                map.insert("providerKey".into(), Js::str(&key));
            }
            let declaration = Declaration::read(&declared)?;
            served.push(Served {
                external: key,
                inbound: Some(InboundSetup { declaration, secret_field: crate::doors::DEFAULT_WEBHOOK_SECRET_FIELD.into() }),
                push_field: None,
            });
        }
        let mut installs = Vec::new();
        for sub in list(world, "subscriptions")? {
            let fields = BTreeMap::from([(crate::doors::DEFAULT_WEBHOOK_SECRET_FIELD.to_string(), text(sub, "secret")?.to_string())]);
            installs.push(Credential { name: text(sub, "id")?.to_string(), external: text(sub, "providerKey")?.to_lowercase(), fields });
        }
        for (index, install) in list(world, "pushInstalls")?.iter().enumerate() {
            let adapter_type = text(install, "adapterType")?.to_string();
            if !served.iter().any(|s| s.external == adapter_type) {
                served.push(Served { external: adapter_type.clone(), inbound: None, push_field: Some("token".into()) });
            }
            let fields = BTreeMap::from([("token".to_string(), text(install, "credential")?.to_string())]);
            installs.push(Credential { name: format!("push-{index}"), external: adapter_type, fields });
        }
        let faulted = |name: &str| Js::is_true(world.get("faults").and_then(|f| f.get(name)));
        let faults = Faults { capture_marked: faulted("captureMarked"), enqueue: faulted("enqueue"), wake_keys: faulted("wakeKeys"), enqueue_wakes: faulted("enqueueWakes") };
        *self.world.borrow_mut() = World { served, installs, faults };
        *self.seen.borrow_mut() = Observations::default();
        Ok(())
    }

    fn observed(&self) -> Js {
        let seen = self.seen.borrow();
        Js::Obj(obj! {
            "captured" => Js::Num(seen.captured.into()),
            "enqueued" => Js::Num(seen.enqueued.into()),
            "wakes" => Js::strings(&seen.wakes),
            "checkpoints" => Js::Arr(seen.checkpoints.clone()),
            "notified" => Js::Num(seen.notified.into()),
        })
    }

    /// lf's doors over the arranged world, observed.
    fn doors(&self) -> Observed<'_> {
        let world = self.world.borrow();
        Observed { bridge: self, served: world.served.clone(), installs: world.installs.clone(), faults: world.faults }
    }
}

/// lf's stores over the world, each call observed and the world's faults injected.
struct Observed<'b> {
    bridge: &'b Bridge,
    served: Vec<Served>,
    installs: Vec<Credential>,
    faults: Faults,
}

impl Observed<'_> {
    fn lf(&self) -> LfDoors<'_, SuiteReader> {
        LfDoors {
            store: &self.bridge.store,
            served: self.served.clone(),
            installs: &self.installs,
            reader: SuiteReader { wake_keys_fail: self.faults.wake_keys },
            sink: EventSink::Queue,
            notify: &|| {},
        }
    }

    fn note(&self, record: impl FnOnce(&mut Observations)) {
        record(&mut self.bridge.seen.borrow_mut());
    }

    async fn queue_wakes(&self, adapter_type: &str, team_id: &str, keys: &[String]) -> Result<(), String> {
        if self.faults.enqueue_wakes {
            return Err("wake queue unavailable".into());
        }
        InboundStore::enqueue_wakes(&self.lf(), adapter_type, team_id, keys).await?;
        self.note(|seen| seen.wakes.extend(keys.iter().cloned()));
        Ok(())
    }
}

impl InboundStore for Observed<'_> {
    async fn find_subscription(&self, id: &str) -> Result<Option<Subscription>, String> {
        self.lf().find_subscription(id).await
    }

    fn knows_provider(&self, provider_key: &str) -> bool {
        self.lf().knows_provider(provider_key)
    }

    fn intercepts(&self, provider_key: &str) -> Vec<crate::inbound::Intercept> {
        self.lf().intercepts(provider_key)
    }

    async fn source_for(&self, subscription: &Subscription) -> Result<Option<Source>, String> {
        self.lf().source_for(subscription).await
    }

    fn reads_deliveries(&self, source: &Source) -> bool {
        self.lf().reads_deliveries(source)
    }

    async fn preprocess(&self, source: &Source, raw: &Js, checkpoint: Option<&Js>) -> Result<Extraction, String> {
        self.lf().preprocess(source, raw, checkpoint).await
    }

    async fn wake_keys(&self, source: &Source, raw: &Js) -> Result<Vec<String>, String> {
        self.lf().wake_keys(source, raw).await
    }

    async fn capture(&self, event: &Js, source: &Source) -> Result<Js, String> {
        if self.faults.capture_marked && Js::is_true(event.get("payload").and_then(|p| p.get("fail"))) {
            return Err("receipt store unavailable".into());
        }
        let captured = self.lf().capture(event, source).await?;
        self.note(|seen| seen.captured += 1);
        Ok(captured)
    }

    async fn save_checkpoint(&self, subscription_id: &str, checkpoint: &Js) -> Result<(), String> {
        self.lf().save_checkpoint(subscription_id, checkpoint).await?;
        self.note(|seen| seen.checkpoints.push(checkpoint.clone()));
        Ok(())
    }

    async fn enqueue(&self, captured: Js, source: &Source) -> Result<(), String> {
        if self.faults.enqueue {
            return Err("work table unavailable".into());
        }
        self.lf().enqueue(captured, source).await?;
        self.note(|seen| seen.enqueued += 1);
        Ok(())
    }

    async fn enqueue_wakes(&self, adapter_type: &str, team_id: &str, keys: &[String]) -> Result<(), String> {
        self.queue_wakes(adapter_type, team_id, keys).await
    }

    fn notify(&self) {
        self.note(|seen| seen.notified += 1);
    }
}

impl PushStore for Observed<'_> {
    async fn authenticate(&self, adapter_type: &str, headers: &[(String, String)]) -> Result<PushAuth, String> {
        self.lf().authenticate(adapter_type, headers).await
    }

    async fn capture_pushed(&self, caller: &PushCaller, event: &Js) -> Result<Vec<Js>, String> {
        let captured = self.lf().capture_pushed(caller, event).await?;
        self.note(|seen| seen.captured += captured.len() as u64);
        Ok(captured)
    }

    async fn enqueue_pushed(&self, captured: Vec<Js>) -> Result<(), String> {
        let count = captured.len() as u64;
        self.lf().enqueue_pushed(captured).await?;
        self.note(|seen| seen.enqueued += count);
        Ok(())
    }

    async fn enqueue_pushed_wakes(&self, adapter_type: &str, team_id: &str, keys: &[String]) -> Result<(), String> {
        self.queue_wakes(adapter_type, team_id, keys).await
    }

    fn notify_pushed(&self) {
        self.note(|seen| seen.notified += 1);
    }
}

/// The suite's adapter: a delivery's JSON body is `{ events?, wake?,
/// checkpoint? }`; each event object is one event's payload.
struct SuiteReader {
    wake_keys_fail: bool,
}

/// A delivery as the suite's adapter reads it.
struct SuiteDelivery {
    events: Vec<Js>,
    wake: Vec<String>,
    checkpoint: Option<Js>,
}

/// The delivery, read as the suite's adapter reads it (a zod parse there).
fn delivery(raw: &Js) -> Result<SuiteDelivery, String> {
    let Js::Obj(_) = raw else { return Err("the delivery is not an object".into()) };
    let events = match raw.get("events") {
        None => Vec::new(),
        Some(Js::Arr(items)) if items.iter().all(|i| matches!(i, Js::Obj(_))) => items.clone(),
        Some(_) => return Err("events: expected an array of objects".into()),
    };
    let wake = match raw.get("wake") {
        None => Vec::new(),
        Some(Js::Arr(items)) => items.iter().map(|i| i.as_str().map(str::to_string).ok_or("wake: expected an array of strings")).collect::<Result<_, _>>()?,
        Some(_) => return Err("wake: expected an array of strings".into()),
    };
    Ok(SuiteDelivery { events, wake, checkpoint: raw.get("checkpoint").cloned() })
}

impl Reader for SuiteReader {
    fn reads_deliveries(&self, _external: &str) -> bool {
        true
    }

    async fn preprocess(&self, _external: &str, _install: &Credential, raw: &Js, _checkpoint: Option<&Js>) -> Result<Extraction, String> {
        let SuiteDelivery { events, checkpoint, .. } = delivery(raw)?;
        Ok(Extraction { events: events.into_iter().map(|payload| Js::Obj(obj! { "payload" => payload })).collect(), checkpoint })
    }

    async fn wake_keys(&self, _external: &str, _install: &Credential, raw: &Js) -> Result<Vec<String>, String> {
        if self.wake_keys_fail {
            return Err("wake door down".into());
        }
        Ok(delivery(raw)?.wake)
    }
}
