//! Which models a run may name, what a model call costs, and the provider
//! key: the hosted engine's registry and price table (movement-engine
//! `lib/models/registry.ts` and `pricing.ts`). The price table is the very
//! file the hosted engine reads, and
//! a test keeps the model names equal to the registry's.

use std::collections::{BTreeMap, HashSet};
use std::cell::RefCell;
use std::sync::OnceLock;

use serde_json::Value as Json;

use crate::json::Js;
use crate::secrets::Credentials;

/// The chat models, in the registry's order (every one is served by
/// Anthropic: `home: 'anthropic'`).
pub const CHAT_MODELS: &[&str] = &[
    "claude-fable-5-1",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
];

/// The models a run's programs may name (`runChatModels`): the catalog's own
/// list where it has one, else every chat model; names that are no chat
/// model are dropped.
pub fn run_chat_models(catalog: &Js) -> Vec<String> {
    match catalog.get("models") {
        Some(Js::Arr(names)) => names.iter().filter_map(Js::as_str).filter(|n| CHAT_MODELS.contains(n)).map(str::to_string).collect(),
        _ => CHAT_MODELS.iter().map(|n| n.to_string()).collect(),
    }
}

/// What a call's `model` names on the provider's wire (`claudeModelId`): the
/// built-in tier aliases, or a chat model by its own name. `None` for a name
/// no call can make.
pub fn wire_model(model: &str) -> Option<&'static str> {
    match model {
        "opus" => Some("claude-opus-4-7"),
        "opus5" => Some("claude-opus-5"),
        "haiku" => Some("claude-haiku-4-5-20251001"),
        "sonnet" => Some("claude-sonnet-5"),
        other => CHAT_MODELS.iter().find(|name| **name == other).copied(),
    }
}

// ── Prices ──────────────────────────────────────────────────────────────────

/// Dollars per million tokens. A missing cache rate bills at the input rate.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: Option<f64>,
    pub cache_creation: Option<f64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct TokenCounts {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
}

static PRICES_TEXT: &str = include_str!("../data/prices.json");

fn prices() -> &'static BTreeMap<String, Price> {
    static PRICES: OnceLock<BTreeMap<String, Price>> = OnceLock::new();
    PRICES.get_or_init(|| {
        let parsed: Json = serde_json::from_str(PRICES_TEXT).expect("prices.json is JSON");
        let table = parsed.get("prices").and_then(Json::as_object).expect("prices.json has a `prices` object");
        table
            .iter()
            .map(|(key, row)| {
                let rate = |field: &str| row.get(field).and_then(Json::as_f64);
                let price = Price {
                    input: rate("input").expect("every price has an input rate"),
                    output: rate("output").expect("every price has an output rate"),
                    cache_read: rate("cacheRead"),
                    cache_creation: rate("cacheCreation"),
                };
                (key.clone(), price)
            })
            .collect()
    })
}

/// What a call cost in microdollars (`costMicrodollars`): `None` when the
/// `provider/wire-model` key has no price. The sum is taken in the order the
/// TypeScript takes it, so the rounding agrees to the microdollar.
pub fn cost_microdollars(key: &str, tokens: TokenCounts) -> Option<i64> {
    let price = prices().get(key)?;
    let input = tokens.input as f64 * price.input;
    let output = tokens.output as f64 * price.output;
    let cache_read = tokens.cache_read as f64 * price.cache_read.unwrap_or(price.input);
    let cache_creation = tokens.cache_creation as f64 * price.cache_creation.unwrap_or(price.input);
    Some((input + output + cache_read + cache_creation).round() as i64)
}

thread_local! {
    static UNPRICED_WARNED: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
}

/// Say once per key that its usage counts as free (`unpricedKeysWarned`).
pub fn warn_unpriced_once(key: &str) {
    let first = UNPRICED_WARNED.with(|warned| warned.borrow_mut().insert(key.to_string()));
    if first {
        eprintln!("lf: no price for \"{key}\": its usage counts as free. Add it to movement-engine/lib/models/prices.json.");
    }
}

// ── The provider key ────────────────────────────────────────────────────────

/// The Anthropic key and endpoint: the settings of the models slot's
/// module, @lf/anthropic (`lf connect @lf/anthropic`).
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderKey {
    pub api_key: String,
    /// Another endpoint speaking the same Messages API.
    pub base_url: Option<String>,
}

pub fn provider_key(credentials: &Credentials) -> Result<ProviderKey, String> {
    let module = crate::core::builtin(crate::core::ANTHROPIC).expect("@lf/anthropic is built in");
    let settings = crate::core::settings_of(credentials, module);
    match settings.get("api_key") {
        Some(api_key) => Ok(ProviderKey { api_key: api_key.clone(), base_url: settings.get("base_url").cloned() }),
        None => Err(format!(
            "a model call needs a provider key: run `lf connect {}`",
            module.name
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The published crate carries its own copy of the price table (a crate
    /// cannot include a file outside itself): it is the TypeScript one.
    #[test]
    fn the_crates_price_table_is_the_engine_packages() {
        let theirs = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/movement-engine/lib/models/prices.json")).unwrap();
        assert_eq!(PRICES_TEXT, theirs, "copy packages/movement-engine/lib/models/prices.json to crates/lf/data/prices.json");
    }

    /// The names the TypeScript registry holds as chat models, in its order.
    fn registry_chat_models() -> Vec<String> {
        let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/movement-engine/lib/models/registry.ts")).unwrap();
        text.lines()
            .filter_map(|line| {
                let line = line.trim();
                let name = line.strip_prefix('\'')?.split('\'').next()?;
                (line.contains("capability: 'chat'") && line.contains("home: 'anthropic'")).then(|| name.to_string())
            })
            .collect()
    }

    #[test]
    fn the_chat_models_are_the_registrys() {
        assert_eq!(registry_chat_models(), CHAT_MODELS);
    }

    #[test]
    fn every_chat_model_is_priced_under_anthropic() {
        for name in CHAT_MODELS {
            assert!(prices().contains_key(&format!("anthropic/{name}")), "{name}");
        }
    }

    #[test]
    fn a_price_is_the_tables_rounded_to_the_microdollar() {
        // claude-sonnet-5 is $2 in / $10 out per million: 1000 * 2 + 500 * 10.
        let counts = TokenCounts { input: 1000, output: 500, ..TokenCounts::default() };
        assert_eq!(cost_microdollars("anthropic/claude-sonnet-5", counts), Some(7000));
        assert_eq!(cost_microdollars("anthropic/not-a-model", counts), None);
    }

    #[test]
    fn prices_agree_with_the_typescript_to_the_microdollar() {
        // Worked by `costMicrodollars` in pricing.ts over the same table.
        let cases: &[(&str, [u64; 4], i64)] = &[
            ("anthropic/claude-fable-5-1", [12345, 6789, 4321, 987], 476318),
            ("anthropic/claude-haiku-4-5", [1, 1, 1, 1], 7),
            ("anthropic/claude-opus-4-6", [777777, 3, 123456, 2], 3950701),
            ("anthropic/claude-sonnet-5", [3, 0, 0, 0], 6),
            ("anthropic/claude-haiku-4-5-20251001", [33, 7, 5, 1], 70),
        ];
        for (key, [input, output, cache_read, cache_creation], expected) in cases {
            let counts = TokenCounts { input: *input, output: *output, cache_read: *cache_read, cache_creation: *cache_creation };
            assert_eq!(cost_microdollars(key, counts), Some(*expected), "{key}");
        }
    }

    #[test]
    fn aliases_name_the_models_the_typescript_names() {
        assert_eq!(wire_model("sonnet"), Some("claude-sonnet-5"));
        assert_eq!(wire_model("opus"), Some("claude-opus-4-7"));
        assert_eq!(wire_model("claude-haiku-4-5"), Some("claude-haiku-4-5"));
        assert_eq!(wire_model("gpt-4"), None);
    }

    #[test]
    fn a_catalogs_own_model_list_wins_and_loses_what_is_no_chat_model() {
        let catalog = Js::parse(br#"{"models":["claude-sonnet-5","whisper-1","nope"]}"#).unwrap();
        assert_eq!(run_chat_models(&catalog), vec!["claude-sonnet-5"]);
        assert_eq!(run_chat_models(&Js::parse(b"{}").unwrap()).len(), CHAT_MODELS.len());
    }
}
