//! The engine's model requests, answered: `llm.client.call` (the extraction
//! keyword's and `AI()`'s call), `llm.extractCall.call` (the extraction
//! call's, its prompt as blocks with cache breakpoints) and
//! `llm.arbitrateEntities`. A port of apps/cli `models.ts` over movement-engine
//! `llm_clients.ts` and `metered.ts`: each call runs under its request's
//! budget, is priced from the shared price table and answers what it spent, and
//! a call refused past its budget answers the refusal as data.

use std::cell::{Cell, RefCell};

use serde_json::Value as Json;

use crate::anthropic::{ChatError, ChatOptions, ChatReply, MAX_CHAT_CONTINUATIONS, Provider, UserBlock, UserMessage};
use crate::json::{Js, Obj};
use crate::models::{self, TokenCounts};
use crate::obj;
use crate::secrets::Credentials;

// ── The output ceiling ──────────────────────────────────────────────────────
//
// A loop guard for a model that loops, off unless the deployment sets
// `EXTRACTION_OUTPUT_BUDGET=1` (or `true`), as the hosted product reads it.
// Off, a call that names no ceiling gets the flat one and the chat's own five
// continuations. On, the ceiling is sized from what the call was asked about
// and one continuation is allowed: an extraction restates its own input, so a
// reply that has spent four times its input and wants more is far likelier to
// be looping than mid-answer.

/// The flat ceiling with the guard off, and the hard ceiling with it on.
const EXTRACTION_MAX_TOKENS: u64 = 32_000;
/// The floor with the guard on: a tiny input can still ask for a real answer.
const EXTRACTION_MIN_TOKENS: u64 = 8_000;
/// Output tokens allowed per token of input, with the guard on.
const EXTRACTION_OUTPUT_RATIO: f64 = 4.0;
/// Rough characters per token; only sizes a budget, so being off costs nothing.
const CHARS_PER_TOKEN: f64 = 4.0;
/// Continuations after a cut-off reply, with the guard on.
const EXTRACTION_MAX_CONTINUATIONS: u32 = 1;

const OUTPUT_BUDGET_ENV_VAR: &str = "EXTRACTION_OUTPUT_BUDGET";

/// Whether the deployment switched the guard on; anything but `1` or `true`
/// leaves it off, in every environment.
fn output_budget_on() -> bool {
    matches!(std::env::var(OUTPUT_BUDGET_ENV_VAR).as_deref(), Ok("1" | "true"))
}

/// `extractionMaxTokens`: the ceiling sized from the call's input. Lengths
/// are counted in UTF-16 units, as the TypeScript host counts them.
fn extraction_max_tokens(system: &str, user: &UserMessage) -> u64 {
    let user_units = match user {
        UserMessage::Text(text) => text.encode_utf16().count(),
        // The blocks as one text, joined as the TypeScript client joins them.
        UserMessage::Blocks(blocks) => {
            blocks.iter().map(|b| b.text.encode_utf16().count()).sum::<usize>() + 2 * blocks.len().saturating_sub(1)
        }
    };
    let input_tokens = (system.encode_utf16().count() + user_units) as f64 / CHARS_PER_TOKEN;
    let proportional = (input_tokens * EXTRACTION_OUTPUT_RATIO).ceil() as u64;
    proportional.clamp(EXTRACTION_MIN_TOKENS, EXTRACTION_MAX_TOKENS)
}

const BUDGET_SPENT: &str = "this run's cost budget is spent: the priced call was refused before it started";

/// Why a request was not answered.
pub enum Failed {
    /// The request itself is malformed: a fault in the caller, not the run's.
    Fault(String),
    /// The call failed; the run fails with this message.
    Run(String),
}

/// Serve one `llm` request of the engine.
pub async fn serve(label: &str, args: &Json, credentials: &Credentials) -> Result<Js, Failed> {
    serve_guarded(label, args, credentials, output_budget_on()).await
}

async fn serve_guarded(label: &str, args: &Json, credentials: &Credentials, output_budget: bool) -> Result<Js, Failed> {
    match label {
        "llm.client.call" | "llm.extractCall.call" => {
            let mut request = ModelRequest::read(label, args).map_err(Failed::Fault)?;
            request.output_budget = output_budget;
            let meter = Meter::new(request.budget);
            let answered = answer(&request, credentials, &meter).await;
            match answered {
                Ok(mut answer) => {
                    answer.insert("cost".into(), meter.lines());
                    Ok(Js::Obj(answer))
                }
                Err(ChatError::BudgetSpent) => Ok(refused(&meter)),
                Err(ChatError::Failed(message)) => Err(Failed::Run(message)),
            }
        }
        // The engine decides what its rules can before it asks; a question
        // only a judge can answer goes to the judge slot's module. lf's
        // built-in one (@lf/judge, crate::core) declines and says why, the
        // answer a hosted run gives when its judge call fails.
        "llm.arbitrateEntities" => Ok(Js::Obj(obj! {
            "index" => Js::Null,
            "judgeUnavailable" => Js::str("lf's judge (@lf/judge) declines every question yet: an ambiguous match creates a new record"),
            "cost" => Js::Arr(Vec::new()),
        })),
        other => Err(Failed::Fault(format!("the host has no route for {other}"))),
    }
}

/// A budget refusal, with what the call spent first (`refusingPastBudget`).
fn refused(meter: &Meter) -> Js {
    Js::Obj(obj! {
        "error" => Js::Obj(obj! { "kind" => Js::str("budget"), "message" => Js::str(BUDGET_SPENT) }),
        "cost" => meter.lines(),
    })
}

// ── One priced call's meter ─────────────────────────────────────────────────

/// What one priced call has spent, refusing priced work past its budget
/// (`SpendMeter`).
struct Meter {
    remaining: Option<f64>,
    spent: Cell<i64>,
    by_source: RefCell<Vec<(String, i64)>>,
}

impl Meter {
    fn new(remaining: Option<f64>) -> Meter {
        Meter { remaining, spent: Cell::new(0), by_source: RefCell::new(Vec::new()) }
    }

    fn open(&self) -> bool {
        self.remaining.is_none_or(|remaining| (self.spent.get() as f64) < remaining)
    }

    fn charge(&self, source: String, microdollars: i64) {
        self.spent.set(self.spent.get() + microdollars);
        let mut by_source = self.by_source.borrow_mut();
        match by_source.iter_mut().find(|(name, _)| *name == source) {
            Some((_, total)) => *total += microdollars,
            None => by_source.push((source, microdollars)),
        }
    }

    fn lines(&self) -> Js {
        Js::Arr(
            self.by_source
                .borrow()
                .iter()
                .map(|(source, microdollars)| Js::Obj(obj! { "source" => Js::str(source), "microdollars" => Js::Num((*microdollars).into()) }))
                .collect(),
        )
    }
}

// ── The models door ─────────────────────────────────────────────────────────

/// One call through the host's models door (protocol.ts `HostModelRequest`),
/// made by the models slot's module for a module that asked: the reply's
/// text (and, for a `schema` request, the reply read as JSON in `data`), and
/// its cost as `{ microdollars, label }` lines, for the module to report on
/// its own answer. No budget: the run that pays is charged through that answer.
pub async fn host_model_call(body: &Js, credentials: &Credentials) -> Result<Js, String> {
    let text = |name: &str| body.get(name).and_then(Js::as_str).map(str::to_string);
    let (Some(label), Some(system), Some(user)) = (text("label"), text("system"), text("userMessage")) else {
        return Err("a models door request is { label, system, userMessage, model?, effort?, schema? }".into());
    };
    let model = text("model").unwrap_or_else(|| "sonnet".into());
    let wire_model = models::wire_model(&model).ok_or_else(|| format!("model {model} is not a model a call names"))?;
    // A schema is asked for in words and the reply read as JSON (the
    // TypeScript host forces a tool call instead).
    let system = match body.get("schema") {
        Some(schema) => format!("{system}\n\nAnswer with one JSON value matching this JSON schema, and nothing else:\n{}", schema.to_json()),
        None => system,
    };
    let request = ModelRequest {
        label,
        system,
        user: UserMessage::Text(user),
        wire_model,
        effort: text("effort"),
        max_tokens: None,
        budget: None,
        reports_usage: false,
        output_budget: false,
    };
    let meter = Meter::new(None);
    let answered = answer(&request, credentials, &meter).await;
    let cost = Js::Arr(
        meter
            .by_source
            .borrow()
            .iter()
            .map(|(source, microdollars)| Js::Obj(obj! { "microdollars" => Js::Num((*microdollars).into()), "label" => Js::str(source.strip_prefix("model:").map(|m| format!("anthropic/{m}")).as_deref().unwrap_or(source)) }))
            .collect(),
    );
    let mut reply = match answered {
        Ok(reply) => reply,
        Err(ChatError::BudgetSpent) => return Err(BUDGET_SPENT.into()),
        Err(ChatError::Failed(message)) => return Err(message),
    };
    let mut out = Obj::new();
    out.insert("text".into(), reply.swap_remove("rawText").unwrap_or(Js::str("")));
    if body.get("schema").is_some() {
        out.insert("data".into(), reply.swap_remove("parsedJson").unwrap_or(Js::Null));
    }
    out.insert("cost".into(), cost);
    Ok(Js::Obj(out))
}

// ── The request ─────────────────────────────────────────────────────────────

struct ModelRequest {
    label: String,
    system: String,
    user: UserMessage,
    wire_model: &'static str,
    effort: Option<String>,
    max_tokens: Option<u64>,
    budget: Option<f64>,
    /// An extraction call also answers its usage.
    reports_usage: bool,
    /// The loop guard (above) is on.
    output_budget: bool,
}

impl ModelRequest {
    fn read(method: &str, args: &Json) -> Result<ModelRequest, String> {
        let text = |name: &str| args.get(name).and_then(Json::as_str).map(str::to_string).ok_or_else(|| format!("{method} {name} must be a string"));
        if args.get("wire") != Some(&Json::Bool(true)) {
            return Err(format!("{method} takes its answer on the eval wire"));
        }
        let effort = match args.get("effort") {
            None | Some(Json::Null) => None,
            Some(Json::String(effort)) if ["low", "medium", "high", "xhigh"].contains(&effort.as_str()) => Some(effort.clone()),
            Some(other) => return Err(format!("{method} effort {other} is not an effort")),
        };
        let max_tokens = match args.get("maxTokens") {
            None | Some(Json::Null) => None,
            Some(n) => Some(n.as_u64().ok_or_else(|| format!("{method} maxTokens is an integer"))?),
        };
        let model = args.get("model").and_then(Json::as_str).unwrap_or_default();
        let wire_model = models::wire_model(model).ok_or_else(|| format!("{method} model {} is not a model a call names", Json::from(model)))?;
        let budget = match args.get("budget").and_then(|b| b.get("remainingMicrodollars")) {
            Some(Json::Null) => None,
            Some(n) => Some(n.as_f64().ok_or_else(|| "a budget is {remainingMicrodollars: number | null}".to_string())?),
            None => return Err("a budget is {remainingMicrodollars: number | null}".into()),
        };
        let (user, reports_usage) = if method == "llm.extractCall.call" {
            let blocks = args.get("blocks").and_then(Json::as_array);
            let blocks = blocks
                .and_then(|list| {
                    list.iter()
                        .map(|b| Some(UserBlock { text: b.get("text")?.as_str()?.to_string(), cache_breakpoint: b.get("cacheBreakpoint") == Some(&Json::Bool(true)) }))
                        .collect::<Option<Vec<_>>>()
                })
                .ok_or_else(|| format!("{method} blocks are [{{text, cacheBreakpoint?: true}}]"))?;
            (UserMessage::Blocks(blocks), true)
        } else {
            let message = text("userMessage")?;
            (UserMessage::Text(message), false)
        };
        Ok(ModelRequest { label: text("label")?, system: text("system")?, user, wire_model, effort, max_tokens, budget, reports_usage, output_budget: false })
    }
}

/// The reply the engine reads: `llm_clients.ts` `makeAnthropicLlmClient`.
async fn answer(request: &ModelRequest, credentials: &Credentials, meter: &Meter) -> Result<Obj, ChatError> {
    let key = models::provider_key(credentials).map_err(ChatError::Failed)?;
    let provider = Provider::new(key);
    // The caller's own ceiling wins where it named one.
    let max_tokens = request.max_tokens.unwrap_or_else(|| {
        if request.output_budget { extraction_max_tokens(&request.system, &request.user) } else { EXTRACTION_MAX_TOKENS }
    });
    let options = ChatOptions {
        system: request.system.clone(),
        user: match &request.user {
            UserMessage::Text(text) => UserMessage::Text(text.clone()),
            UserMessage::Blocks(blocks) => {
                UserMessage::Blocks(blocks.iter().map(|b| UserBlock { text: b.text.clone(), cache_breakpoint: b.cache_breakpoint }).collect())
            }
        },
        model: request.wire_model.to_string(),
        max_tokens,
        effort: request.effort.clone(),
        max_continuations: if request.output_budget { EXTRACTION_MAX_CONTINUATIONS } else { MAX_CHAT_CONTINUATIONS },
    };
    let reply = provider.chat_detailed(&options, &|| meter.open()).await;
    // Charged as the call returns, truncated or not: the tokens were spent.
    if let Ok(reply) = &reply {
        charge_to_run(meter, request.wire_model, reply.usage);
    }
    let reply = reply?;
    // A truncated body still parses and the damage would land as silently
    // nulled fields: fail loudly instead.
    if reply.truncated {
        return Err(ChatError::Failed(format!(
            "Extraction '{}' produced no complete answer: {} (EXTRACTION_OUTPUT_BUDGET {}).",
            request.label,
            describe_truncation(&reply, max_tokens),
            if request.output_budget { "on" } else { "off" }
        )));
    }
    let mut out = Obj::new();
    out.insert("parsedJson".into(), parse_json_reply(&reply.text));
    out.insert("rawText".into(), Js::Str(reply.text.clone()));
    if let Some((from, to)) = &reply.stepped_down {
        out.insert("effortSteppedDown".into(), Js::Obj(obj! { "from" => Js::str(from), "to" => Js::str(to) }));
    }
    if reply.continuations > 0 {
        out.insert("continuations".into(), Js::Num(reply.continuations.into()));
    }
    if request.reports_usage {
        let usage = reply.usage;
        out.insert(
            "usage".into(),
            Js::Obj(obj! {
                "inputTokens" => Js::Num(usage.input.into()),
                "outputTokens" => Js::Num(usage.output.into()),
                "cacheReadTokens" => Js::Num(usage.cache_read.into()),
                "cacheCreationTokens" => Js::Num(usage.cache_creation.into()),
            }),
        );
    }
    Ok(out)
}

/// `chargeToRun`: the usage priced from the shared table, under `model:<wire model>`.
fn charge_to_run(meter: &Meter, wire_model: &str, usage: TokenCounts) {
    let key = format!("anthropic/{wire_model}");
    match models::cost_microdollars(&key, usage) {
        Some(microdollars) => meter.charge(format!("model:{wire_model}"), microdollars),
        None => models::warn_unpriced_once(&key),
    }
}

/// `describeTruncation`.
fn describe_truncation(reply: &ChatReply, ceiling: u64) -> String {
    let spent = format!("{} continuation{}", reply.continuations, if reply.continuations == 1 { "" } else { "s" });
    if reply.thinking_only {
        let at = reply.effort.as_deref().map(|e| format!(" at effort {e}")).unwrap_or_default();
        return format!("the model spent the whole {ceiling}-token output ceiling thinking{at} and produced no text, after {spent}");
    }
    format!("the model hit the {ceiling}-token output ceiling and was still truncated after {spent}")
}

// ── A reply's JSON ──────────────────────────────────────────────────────────

/// `parseJsonReply`: an empty reply is null, a reply no repair can parse is
/// its raw text.
pub fn parse_json_reply(text: &str) -> Js {
    if text.trim().is_empty() {
        return Js::Null;
    }
    parse_json(text).unwrap_or_else(|| Js::str(text))
}

/// `parseJson`: the text as JSON; else the code fence's content, trimmed to
/// the first opening and last closing bracket; else with its unescaped
/// interior quotes escaped; else repaired.
fn parse_json(text: &str) -> Option<Js> {
    if let Ok(parsed) = Js::parse(text.as_bytes()) {
        return Some(parsed);
    }
    let before_trim = code_fence_content(text).unwrap_or(text);
    let opening = before_trim.find(['[', '{']).unwrap_or(before_trim.len());
    let mut json = &before_trim[opening..];
    if let Some(last) = json.rfind(['}', ']']) {
        json = &json[..=last];
    }
    if let Ok(parsed) = Js::parse(json.as_bytes()) {
        return Some(parsed);
    }
    let escaped = escape_interior_quotes(json);
    if let Ok(parsed) = Js::parse(escaped.as_bytes()) {
        return Some(parsed);
    }
    // A truncated reply: repair the original, which keeps the entries the
    // trim above dropped. Only for a reply that is bare JSON from its first
    // character; on prose the repair makes junk of the words.
    if before_trim.trim_start().starts_with(['[', '{'])
        && let Some(parsed) = repaired(before_trim)
    {
        return Some(parsed);
    }
    repaired(&escaped)
}

fn repaired(text: &str) -> Option<Js> {
    let fixed = crate::json_repair::repair(text).ok()?;
    Js::parse(fixed.as_bytes()).ok()
}

/// The first <code>```</code> fence's content (/```(?:json)?\s*([\s\S]*?)```/).
fn code_fence_content(text: &str) -> Option<&str> {
    let open = text.find("```")? + 3;
    let after = &text[open..];
    let after = after.strip_prefix("json").unwrap_or(after);
    let after = after.trim_start();
    let close = after.find("```")?;
    Some(&after[..close])
}

/// `escapeInteriorQuotes`: a `"` inside a string is a real close-quote only
/// when the next non-whitespace character is one of `:`, `,`, `}`, `]` (or
/// there is none); otherwise it is escaped.
fn escape_interior_quotes(json: &str) -> String {
    let chars: Vec<char> = json.chars().collect();
    let mut result = String::with_capacity(json.len());
    let mut in_string = false;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if !in_string {
            result.push(ch);
            if ch == '"' {
                in_string = true;
            }
            i += 1;
        } else if ch == '\\' {
            result.push(ch);
            if let Some(next) = chars.get(i + 1) {
                result.push(*next);
            }
            i += 2;
        } else if ch == '"' {
            let next = chars[i + 1..].iter().find(|c| !c.is_whitespace());
            if next.is_none_or(|c| matches!(c, ',' | ':' | '}' | ']')) {
                result.push('"');
                in_string = false;
            } else {
                result.push_str("\\\"");
            }
            i += 1;
        } else {
            result.push(ch);
            i += 1;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::anthropic::tests::{Scripted, fake_anthropic, stream_of};
    use crate::secrets::{Binding, Credential, Origin};

    fn parsed(text: &str) -> String {
        parse_json_reply(text).to_json()
    }

    #[test]
    fn a_reply_is_json_however_the_model_wrapped_it() {
        assert_eq!(parsed(r#"{"a":1}"#), r#"{"a":1}"#);
        assert_eq!(parsed("Here you go:\n```json\n{\"a\": [1, 2]}\n```\nDone."), r#"{"a":[1,2]}"#);
        assert_eq!(parsed("Sure! {\"a\":1} hope that helps"), r#"{"a":1}"#);
        assert_eq!(parsed(r#"{"q":"the "forever" chemicals"}"#), r#"{"q":"the \"forever\" chemicals"}"#);
        assert_eq!(parsed(r#"{"a":[1,2"#), r#"{"a":[1,2]}"#);
        assert_eq!(parsed("   "), "null");
        assert_eq!(parsed("no json at all"), r#""no json at all""#);
    }

    /// Every reply in the fixture reads as the TypeScript engine reads it
    /// (apps/cli `json_replies.test.ts` holds the fixture to that engine).
    #[test]
    fn replies_read_as_the_typescript_engine_reads_them() {
        let cases: Vec<Json> = serde_json::from_str(include_str!("testdata/json_replies.json")).unwrap();
        // Valid JSON whose value lf cannot hold, so it reads the raw text: a
        // number past a double's range (JavaScript's Infinity) and a lone
        // UTF-16 surrogate (a Rust string is UTF-8).
        const UNREPRESENTABLE: &[&str] = &[r#"{"a":1e400}"#, r#"{"a":"\ud83d"}"#];
        let differences: Vec<String> = cases
            .iter()
            .filter_map(|case| {
                let reply = case["reply"].as_str().unwrap();
                if UNREPRESENTABLE.contains(&reply) {
                    assert_eq!(parse_json_reply(reply), Js::str(reply));
                    return None;
                }
                let expected = case["parsed"].as_str().unwrap();
                let read = parse_json_reply(reply);
                let expected_value: Option<Json> = serde_json::from_str(expected).ok();
                let same = serde_json::to_value(&read).is_ok_and(|read| expected_value.is_some_and(|expected| same_value(&read, &expected)));
                (!same).then(|| format!("{reply:?}\n  typescript: {expected}\n  lf:         {}", read.to_json()))
            })
            .collect();
        assert!(differences.is_empty(), "{} of {} replies read differently:\n{}", differences.len(), cases.len(), differences.join("\n"));
    }

    /// Equal as JavaScript sees them: a number is its double, so `12.0` is `12`.
    fn same_value(a: &Json, b: &Json) -> bool {
        match (a, b) {
            (Json::Number(a), Json::Number(b)) => a.as_f64() == b.as_f64(),
            (Json::Array(a), Json::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_value(a, b)),
            (Json::Object(a), Json::Object(b)) => a.len() == b.len() && a.iter().all(|(key, a)| b.get(key).is_some_and(|b| same_value(a, b))),
            _ => a == b,
        }
    }

    fn credentials(base_url: &str) -> Credentials {
        vec![Credential {
            name: "anthropic".into(),
            external: "@lf/anthropic".into(),
            binding: Binding::Legacy,
            fields: [("api_key".to_string(), "k".to_string()), ("base_url".to_string(), base_url.to_string())].into_iter().collect(),
            origin: Origin::default(),
        }]
    }

    fn request(budget: Json) -> Json {
        json!({ "system": "s", "userMessage": "u", "model": "sonnet", "label": "test", "wire": true, "segmentId": "seg", "budget": budget })
    }

    fn cost_of(answer: &Js) -> String {
        answer.get("cost").unwrap().to_json()
    }

    #[tokio::test]
    async fn a_call_answers_the_json_and_the_cost_the_shared_table_prices_its_tokens_at() {
        let (url, _) = fake_anthropic(vec![Scripted::Stream(stream_of(&[("text", "{\"a\":1}")], "end_turn", (1000, 500)))]).await;
        let answer = serve("llm.client.call", &request(json!({ "remainingMicrodollars": null })), &credentials(&url)).await.ok().unwrap();
        assert_eq!(answer.get("parsedJson").unwrap().to_json(), r#"{"a":1}"#);
        // claude-sonnet-5 is $2 in / $10 out per million: 1000 * 2 + 500 * 10.
        assert_eq!(cost_of(&answer), r#"[{"source":"model:claude-sonnet-5","microdollars":7000}]"#);
    }

    #[tokio::test]
    async fn an_extraction_call_sends_blocks_with_breakpoints_and_answers_its_usage() {
        let (url, seen) = fake_anthropic(vec![Scripted::Stream(stream_of(&[("text", "{}")], "end_turn", (10, 2)))]).await;
        let mut args = request(json!({ "remainingMicrodollars": 1_000_000 }));
        args.as_object_mut().unwrap().remove("userMessage");
        args["blocks"] = json!([{ "text": "a", "cacheBreakpoint": true }, { "text": "b" }]);
        let answer = serve("llm.extractCall.call", &args, &credentials(&url)).await.ok().unwrap();
        assert_eq!(answer.get("usage").unwrap().get("inputTokens"), Some(&Js::Num(10.into())));
        let sent = &seen.lock().unwrap()[0].0["messages"][0]["content"];
        assert_eq!(*sent, json!([{ "type": "text", "text": "a", "cache_control": { "type": "ephemeral" } }, { "type": "text", "text": "b" }]));
    }

    #[tokio::test]
    async fn a_call_past_its_budget_answers_the_refusal_without_calling() {
        let (url, seen) = fake_anthropic(vec![Scripted::Stream(stream_of(&[("text", "{}")], "end_turn", (1, 1)))]).await;
        let answer = serve("llm.client.call", &request(json!({ "remainingMicrodollars": 0 })), &credentials(&url)).await.ok().unwrap();
        assert_eq!(answer.get("error").unwrap().get("kind"), Some(&Js::str("budget")));
        assert_eq!(cost_of(&answer), "[]");
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_truncated_extraction_fails_naming_the_ceiling() {
        let (url, _) = fake_anthropic(vec![Scripted::Stream(stream_of(&[("text", "{\"a\":")], "max_tokens", (1, 1)))]).await;
        let mut args = request(json!({ "remainingMicrodollars": null }));
        args["maxTokens"] = json!(50);
        // Every continuation is cut off too, so the call ends truncated.
        let Err(Failed::Run(message)) = serve("llm.client.call", &args, &credentials(&url)).await else { panic!("expected a run failure") };
        assert_eq!(
            message,
            "Extraction 'test' produced no complete answer: the model hit the 50-token output ceiling and was still truncated after 5 continuations (EXTRACTION_OUTPUT_BUDGET off)."
        );
    }

    #[tokio::test]
    async fn with_the_output_budget_on_the_ceiling_follows_the_input_and_one_continuation_is_allowed() {
        let (url, seen) = fake_anthropic(vec![Scripted::Stream(stream_of(&[("text", "{\"a\":")], "max_tokens", (1, 1)))]).await;
        let Err(Failed::Run(message)) = serve_guarded("llm.client.call", &request(json!({ "remainingMicrodollars": null })), &credentials(&url), true).await else {
            panic!("expected a run failure")
        };
        // A two-character input is under the floor.
        assert_eq!(
            message,
            "Extraction 'test' produced no complete answer: the model hit the 8000-token output ceiling and was still truncated after 1 continuation (EXTRACTION_OUTPUT_BUDGET on)."
        );
        let seen = seen.lock().unwrap();
        assert_eq!((seen.len(), &seen[0].0["max_tokens"]), (2, &json!(8000)));
    }

    #[test]
    fn the_guarded_ceiling_is_four_times_the_input_between_the_floor_and_the_cap() {
        let user = |chars: usize| UserMessage::Text("x".repeat(chars));
        assert_eq!(extraction_max_tokens("", &user(10)), 8_000);
        // 12,000 characters is 3,000 tokens in, so 12,000 out.
        assert_eq!(extraction_max_tokens("", &user(12_000)), 12_000);
        assert_eq!(extraction_max_tokens("", &user(1_000_000)), 32_000);
        // Two blocks count as one text joined by a blank line: 5,999 + 2 + 5,999.
        let blocks = UserMessage::Blocks(vec![
            UserBlock { text: "x".repeat(5_999), cache_breakpoint: false },
            UserBlock { text: "x".repeat(5_999), cache_breakpoint: false },
        ]);
        assert_eq!(extraction_max_tokens("", &blocks), 12_000);
        // UTF-16 units: an emoji is two.
        assert_eq!(extraction_max_tokens(&"😀".repeat(4_000), &user(4_000)), 12_000);
    }

    #[tokio::test]
    async fn no_provider_key_fails_naming_the_secrets_entry() {
        let Err(Failed::Run(message)) = serve("llm.client.call", &request(json!({ "remainingMicrodollars": null })), &Vec::new()).await else {
            panic!("expected a run failure")
        };
        assert!(message.starts_with("a model call needs a provider key"), "{message}");
    }

    #[tokio::test]
    async fn the_models_door_answers_the_text_the_data_and_the_cost_as_labelled_lines() {
        let (url, _) = fake_anthropic(vec![Scripted::Stream(stream_of(&[("text", "{\"city\":\"Paris\"}")], "end_turn", (1000, 500)))]).await;
        let body = Js::parse(br#"{"label":"affinity.formatLocation","system":"s","userMessage":"u","model":"claude-sonnet-5","schema":{"type":"object"}}"#).unwrap();
        let answer = host_model_call(&body, &credentials(&url)).await.unwrap();
        assert_eq!(answer.get("data").and_then(|d| d.get("city")).and_then(Js::as_str), Some("Paris"));
        assert_eq!(answer.get("cost").unwrap().to_json(), r#"[{"microdollars":7000,"label":"anthropic/claude-sonnet-5"}]"#);
    }

    #[tokio::test]
    async fn the_judge_is_declined_and_says_why() {
        let answer = serve("llm.arbitrateEntities", &json!({}), &Vec::new()).await.ok().unwrap();
        assert_eq!(answer.get("index"), Some(&Js::Null));
        assert!(answer.get("judgeUnavailable").is_some());
    }
}
