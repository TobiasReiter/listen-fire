# lfr-llm report (G6: model calls and pricing in Rust lf-host)

Branch lfr-llm, cut from 9cfa02d3. Not pushed.

## What landed
- `crates/lf-host/src/models.rs`: chat model list (a test keeps it equal to registry.ts), the run's
  model list from the catalog (replaces the fixed constant in segment.rs), tier aliases, pricing from
  prices.json via include_str (the same file), `anthropic` credential lookup.
- `anthropic.rs`: Messages API client. Streamed SSE request, continuation after `max_tokens`, one
  effort step down when a turn only thought, backoff (4 attempts; 1s, 4s, 16s; +30s on 429), http and
  https (rustls + webpki roots). Verified against the real provider: a bogus key gets the provider's 401
  over TLS (`cargo test -p lf-host https -- --ignored`).
- `llm_calls.rs`: `llm.client.call`, `llm.extractCall.call`, `llm.arbitrateEntities`; per-call spend
  meter with the request budget (refusal answered as `{error:{kind:'budget'},cost}`), cost lines,
  `parseJsonReply` port (fence/trim/interior quotes/jsonrepair crate), truncation error text.
- `segment.rs` (shared, small edits): routes the llm arm to llm_calls; run models from `models.rs`;
  a segment spend ledger (the engine reports its own cost lines at `done` and the host must agree, as
  the TS shim checks); plugin cost lines (`invoke_plugin`) now charged to it too (before, any plugin
  cost failed the run).
- `main.rs`: three `mod` lines. `Cargo.toml`: rustls, tokio-rustls, webpki-roots, jsonrepair (and the
  Cargo.lock that follows; expect a lock merge with siblings).

## Verification
- cargo test -p lf-host: 56 pass, 1 ignored (network). clippy -D warnings clean.
- apps/cli models.test.ts under LF_BIN=lf-host: 2/2 (were failing). Full LF_BIN suite: 24 fail, none
  models; the rest are other streams' (callbacks/cancel, serve/webhook, secrets refresh, connect,
  upgrade) and modules.test.ts (serve-module not startable here, unrelated to models).
- Cost parity: cargo test pins six token mixes (including cache tokens) to figures worked by the
  TypeScript `costMicrodollars`; the 1000 in / 500 out sonnet case is 7000 in both.
- models_pricing.test.ts imports `modelCalls` directly, so it stays a TypeScript-only test; the Rust
  equivalent is the llm_calls cargo test over a fake HTTP provider.

## Deviations (for Henry)
- 4xx other than 408/409/429 is not retried (the TS retries everything but 401, so a 400 waits ~21s).
- No concurrency limit of 8 on model requests (TS queue); the engine bounds its own fan-out.
- No output budget guard (`EXTRACTION_OUTPUT_BUDGET`): lf has it off, so the flat 32000 ceiling and 5
  continuations are the only mode.
- jsonrepair is the Rust crate `jsonrepair` 0.1, not the npm library; it matters only for replies the
  first three parse steps cannot read. Not corpus-compared.
- Request-path logging (slow-call warnings, step-down warning) is not ported; the step-down shows in
  the reply's `effortSteppedDown` as before.
- Cost cap: lf passes the engine no cap (the TS lf does not read one either), so charging works but
  nothing refuses on a cap yet.
