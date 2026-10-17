# ev4-plugins report — the six bundled plugins as a module

Branch `ev4-plugins` from 9cfa02d3. Not pushed. Commits: c3334854 parity recording (before any move) ·
006ca096 move into `@lf/web`, lines flipped · 8b30d375 package tag, lf, example, perf · (this) baseline + report.

## Done

- **`@lf/web` (`modules/web`)**: one plugin module holding all six plugins.
  - The bodies were moved, not copied (git history follows them).
  - Each manifest is the engine package's declaration (`services/plugins`); the module fails to load
    if its bodies and the declarations differ.
  - The plugins reach their host through a tools port: models, search, scrape, profile reader,
    fetch-and-keep one address, turn a stored document into a file value.
- **Two sets of tools.**
  - Platform: `engine/transforms/hosted_tools.ts`, the exact services the plugins called before
    (hosted model routing and billing, search, Bright Data, the gated-document browser, the
    document store). So nothing the platform is asked changes.
  - Everywhere else: `modules/web/standalone.ts`, on a `web` credential whose fields are all
    optional. Models go to Anthropic, priced and returned as the answer's cost. Search and pages go
    to Bright Data, or a plain GET when no scrape provider is set. There is no profile reader,
    gated-document browser or document store, so those addresses come back as nothing.
- **Legacy line** = the module's body run with the platform's tools through the old transform
  registry. Manifests and handbook sections stay in apps/api (they are platform catalogue).
- **`BUILTIN_MODULES`**: all six plugin lines are `module`.
  - A plugin's own line decides, so one plugin can be rolled back alone.
  - A loaded plugin module is kept per team. Rebuilding it per call cost +28% p50.
- **Package import**: the hosted catalog tags the bundled specs `package: '@lf/web'`.
  - ``import { `@lf/web` as web } from plugins`` + `web.fetchUrl(u)` checks clean in both checkers.
  - Flat imports are unchanged.
- **lf / lf-host**: `@lf/web` runs as a process end to end (`module:` naming `modules/web`).
  `examples/lf-custom-plugin` (one file, no imports) runs end to end in both.
- **`limit_pause` seam**: `transformInvokerFor` is unchanged, so its mock still holds.

## Decisions (why)

- **One package, not six.** v5 already imports packages by tag. One `@lf/web` gives `web.fetchUrl`
  and keeps the flat names.
- **Port, not a rewrite.** The plugins depend on about 20k lines of platform code (browser
  crawling, the document DB, the prompt registry). Moving that into a module is not this stream.
  The port keeps the platform's behaviour identical by construction, and gives other hosts an
  honest smaller version.
- **Tools reach the bodies through an async scope.** The bodies were written against ambient
  services; threading a parameter through every research helper would have rewritten them while
  moving them.
- **Tuning settings stay in process env** (`RESEARCH_ENGINE`, …), as before.
- **New public entry `movement-engine/public/anthropic`.** It holds the client factory, metering,
  page reader, keyed provider, parseJson, model names, prices and cost envelope. It is lean, so
  serving a module does not load `public/models`' extraction clients and judge.

## Recorded parity

- **The fixture.** Recorded from the legacy plugins before any code moved. It has 15 cases
  covering all six plugins, including both research engines. Bright Data, search, model calls,
  storage and the document browser are stubbed. Each case holds every service call with its
  arguments, in order, and the run's answer.
- **The legacy line and the module line in process** replay it identically: 31/31.
- **Off the platform.** A second fixture records what each plugin asked of its tools on the
  platform. `@lf/web` then replays it identically in process and through `serve-module` as a child
  process over protocol 2: 30/30.

## Performance (`modules/web`, `pnpm bench`; interleaved, median of 5, load average ~30)

| | p50 | p99 | RSS | boot |
|---|---|---|---|---|
| legacy | 0.038 ms | 9.49 ms | 96.3 MB | 4113 ms |
| module | +0.0% | −10.9% | +1.3% | +2.8% |
| validated (dev) | +208% | +50% | −2.6% | −9.4% |

## Tests (done tier)

- `@lf/web`: 3 suites, 42/42. Type-check and module boundary clean (53 files).
- apps/api scoped: plugin parity, transforms (port, web-research, research, linkedin-research,
  registry, research_eval), transform invokers, extraction suites, limit_pause unit, plugin
  sections, plugin catalog.
  - First run: 460 tests, 7 failures, all fixed. Two causes: a fetch arity difference, and one
    mock path.
  - Then: translation_graph tests, movement tests, the handbook, trpc views and plugins:
    2056/2056.
  - Invokers, adapters and parity after the per-team cache: 230/230.
- Type-check clean: apps/api (with the oracle config and the engine boundary), movement-engine,
  module-kit, apps/cli.
  - Engine boundary baseline lowered from 779 to 761.
- apps/cli: `web_plugins.test.ts` 3/3 on TS lf, and 3/3 with `LF_BIN=lf-host`.
  - The lf-host run used `LF_SERVE_MODULE` and the main checkout's lf-host binary. No Rust changed
    here.
  - catalog, modules, externals and models: 12/12.
- No integration tests run; none needed.

## Flags

- **lf-host gives a module process 10 s to print `listening`.** `@lf/web` boots in about 4 s idle.
  Under a load average of 35 it missed the deadline once, and passed on retry. The deadline is in
  `crates/lf-host/src/externals.rs` (not touched).
- **lf-host finds `serve-module` on PATH** unless `LF_SERVE_MODULE` is set. A user needs the kit's
  bin on PATH.
- **Off the platform there is no profile reader and no gated-document browser.** Porting the
  browser (Playwright document sources) is a separate decision.
- **The standalone tools have no recorded parity against real Bright Data or Anthropic requests.**
  The fetchUrl path is proved end to end against a local page. Search and model calls are proved
  only through the port parity, which uses recorded answers.

## Files outside the stream (minimal)

- `apps/api/package.json`: the `@lf/web` dependency and its build line.
- `deploy/Dockerfile`: one COPY line. `pnpm-lock.yaml`.
- `apps/api/src/lib/utils/url.ts`: re-exports `looksLikeNonHtmlAddress` from the module.
- `movement/catalog.ts`: plugin specs carry the package; `pluginNames` added.
- `research_eval.unit.test.ts`: one mock path.
- `scripts/engine-boundary-baseline.json`: lowered.
