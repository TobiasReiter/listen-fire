# Embedding the engine

Your product can let its customers write movements and run them inside it. The engine runs in your own Node process, as WebAssembly: no server of ours, no network of its own. You give it what it needs: your product as a module, a place for each customer's secrets, the models it may call, and the limits it must keep.

A working example is in [`examples/embed-saas`](../examples/embed-saas): a small HTTP app where a customer saves a movement, the app checks it, and the app's own event runs it. Its test runs it end to end.

## The packages

| package | what it is |
|---|---|
| `@lf/engine` | The engine and its host contract. Reached only through its public entries, `@lf/engine/public/<entry>`. |
| `@lf/engine-contracts` | The data the engine is handed: a run's input, the tenant id, the event, the parked state, the module protocol. |
| `@lf/module-kit` | How a module is defined (`defineModule`) and loaded, in your process or served as a process. |
| `@lf/movement-lang` | The language: parser, checker, catalog types. The engine depends on it. |
| `@lf/model-providers` | Model vendors beyond Anthropic (OpenAI, Gemini, Claude on Vertex). Optional. |
| `@lf/file-text` | A file's text: PDF, decks, spreadsheets, audio. Optional. |
| `@lf/<name>` | Ready-made modules: `@lf/attio`, `@lf/slack`, `@lf/google-sheets`, `@lf/web`, and the rest. |

Every package has the same version as the engine. Node 22 or later. With TypeScript, use `moduleResolution` `node16`, `nodenext` or `bundler` (plain `node` works too, through the packages' `typesVersions`).

```sh
npm install @lf/engine @lf/engine-contracts @lf/module-kit
```

The public entries of `@lf/engine` you will use:

| entry | for |
|---|---|
| `public/movement-engine` | `runMovement`, `resumeMovement`, `checkPinnedInRust`, `parsePinned` |
| `public/embed` | `inProcessHost`, `introspectAdapter`, `collectFileListeners`, `pricedModels`, `MovementEngineError` |
| `public/catalog` | `buildCatalogSnapshot`: what a customer's movements are checked and run against |
| `public/inbound` | `eventMatchesTriggerScope`, `triggerEventOf`: from your event to a run |
| `public/secrets` | the secrets family, and an in-memory vault to start from |
| `public/adapter` | what an adapter is |
| `public/models`, `public/anthropic` | the Anthropic clients and model prices |
| `public/run-host` | the store and rules for runs that park (`await`, `sleep`) |
| `public/testing` | for your tests: the store contract suite your own store must pass |

## The shape of it

- **One customer is one tenant.** Every run names its tenant (`teamId`), and everything the run reaches is answered for that tenant only.
- **A customer's movement is checked when it is saved.** The checker reads the customer's catalog: your modules as that customer sees them, and the connections that customer holds.
- **A movement says what it listens for.** Its `listen … fire …` statements are your routing table: when something happens in your product, you run each movement that listens for it.
- **The engine asks your host for everything.** Adapter calls, model calls, the clock, ids, parks, file text: each is a family on the host you build. A piece you do not supply is refused by name when a run reaches it, never answered with a silent default.

## 1. Your product as a module

A movement reaches your product through a module: an adapter over your own data. Define it once with the module kit.

```ts
import { defineModule } from '@lf/module-kit';

export const crm = defineModule({
  kind: 'adapter',
  name: '@acme/crm',                     // answers to adapter type `crm`
  manifest: { adapterType: 'crm', displayName: 'CRM', supportedTriggers: ['webhook'], methods: [...], subscribableEvents: ['company.created'], declaredCredentials: ['crm'], introspectedSchema: true },
  credentials: [{ name: 'crm', kind: 'static', fields: [{ name: 'api_key' }] }],
  create: (ctx) => crmAdapter(ctx),      // the adapter methods, over ctx.config.tenant
});
```

Load it in your process for one tenant with `adapterInProcess(crm, host)`. The `host` is the module's context: the tenant, its credential, a log, files, and a small store of its own (`kv`). `secretsCredential` reads the credential from your secrets; `memoryKv` keeps module state in memory. Set `validateResults: true` while you develop: every answer is checked against the protocol.

The ready-made modules (`@lf/attio`, `@lf/slack`, …) load the same way. A module can also run as its own process (`serve-module`, in `@lf/module-kit`), reached over the module protocol (`public/modules`); see [docs/contracts/adapter-protocol.md](contracts/adapter-protocol.md).

## 2. The catalog

The catalog is what a customer's movements are checked and run against, as plain data. Build it per tenant.

```ts
const { schema } = await introspectAdapter(adapterFor(tenant), crm.manifest);
const catalog = buildCatalogSnapshot({
  adapters: [{ manifest: crm.manifest, schemas: { workspace: schema } }],
  credentials: { workspace: { adapters: ['crm'], credential: 'crm' } },
  plugins: {},
});
```

- `introspectAdapter` asks the adapter its entry points and describes each one.
- A schema is keyed by the connection's name, here `workspace`: the name a movement imports (`import { workspace } from credentials`).
- The connection fills the module's declared credential (`credential: 'crm'`).

## 3. Check a customer's movement

```ts
checkPinnedInRust({ source, catalog, languageVersion: 5 });
```

It throws `MovementEngineError` when the movement does not check, with the code `MOVENG_CHECK` (or `MOVENG_PARSE`, `MOVENG_LANGUAGE_VERSION`) and every problem in its message. `isCheckFailure(error)` tells a check failure from anything else. Save the source with the language version you checked it under: a saved movement is pinned to it ([language versions](contracts/language-versions.md)).

Read its routing table once, as you save it:

```ts
const listeners = collectFileListeners(parsePinned({ source, languageVersion: 5 }));
// [{ adapter: 'crm', config: { events: ['company.created'] }, movementName: 'welcome', … }]
```

## 4. Run it when its event happens

```ts
if (listener.adapter === 'crm' && eventMatchesTriggerScope(event, listener.config)) {
  const { triggerEvent } = triggerEventOf({ pipelineInputId, adapterType: 'crm', triggerType: 'webhook', event, eventTypes, now: new Date() });
  const result = await runMovement({
    source, languageVersion: 5, movementName: listener.movementName,
    event: triggerEvent,
    teamId: tenantIdOf(tenant),
    catalog,
    credentialIds: { workspace: credentialRefOf(tenant) },
    costCapMicrodollars: 50_000,
    limits: { maxSteps: 100_000, maxTextBytes: 1 << 20, maxCollectionItems: 10_000, maxResultBytes: 4 << 20 },
    host,
  });
}
```

- `event` is your product's event (`{ payload, externalId, eventType, recordType, … }`); `eventTypes` are your adapter's `listEventTypes()`, which turn it into a typed record the movement receives.
- `credentialIds` maps each connection name to your own id for it. Your adapter resolver receives that id; it never crosses into the movement.
- `result.writes` lists what the run wrote; `result.runSpentMicrodollars` what it spent. A run that fails throws; its message says why.

## 5. The host: filling the slots

```ts
const host = inProcessHost({
  adapters: { resolve: ({ adapterType, teamId, credentialsId }) => adapterFor(teamId, credentialsId) },
  llm: pricedModels({ client: models }),
});
```

The host has the same slots as `lf.yaml`'s `core:` section. You fill each with your own part.

| slot | what a run asks of it | how you fill it |
|---|---|---|
| models | `ai(…)` and `extract(…)` calls | `llm: pricedModels({ client, extractCall })`. A client answers `{ parsedJson }` and may report what it cost. The Anthropic clients are `makeAnthropicLlmClient` and `makeAnthropicExtractCallClient` (`public/models`), over `anthropicClient` (`public/anthropic`). |
| judge | whether a written record is one already there, when the rules alone cannot tell | `llm.arbitrateEntities`. Absent: such a write fails, naming it. |
| store | parks: `await`, `sleep`, callbacks | `park.sink`, `park.wake`, `park.bindings`, `park.callbacks`, with the run-host store (`public/run-host`) behind them. Absent: a movement that parks fails. Your store must pass the contract suite in `public/testing`. |
| files | reading a file's text, rendering a file | `files.resolveFileText` (`@lf/file-text` reads PDFs, decks and sheets), `files.render`. |

Two more pieces are yours and have safe defaults:

- **Secrets.** `createSecretsFamily({ backend })` over your vault: one entry per connection, never shared between tenants. `createMemoryVault` is the in-memory one; a real vault implements `SecretsBackend` (resolve, write back at a version, a lock), and the contract cases in `public/secrets-testing` hold it. OAuth 2 refresh is `declaredRefresher` and the family's `refresh`.
- **Write locks.** Two runs writing the same record take turns. The default is in memory, which holds within one process; across processes, supply `locks` over your database.

## 6. Limits and the cost cap

A customer's movement is code you did not write. Set every limit, and a cost cap on every run.

- **`limits`** on the run's input: steps (statements and expressions, the CPU bound), one text's size, one collection's size, and the result's size. Past one, the run fails with `MOVENG_LIMIT_STEPS`, `MOVENG_LIMIT_TEXT_SIZE`, `MOVENG_LIMIT_COLLECTION_SIZE` or `MOVENG_LIMIT_RESULT_SIZE`. Nothing in the movement can catch it. Absent, each is the engine's default, which is generous.
- **`costCapMicrodollars`** on the run's input: the most the run may spend on model calls and priced plugins. Past it, the engine refuses the next priced call itself. One call already under way may overshoot by its own cost.
- **`maxSegmentSeconds`** on the run's input: how long one segment may take, waits on your host included (default 900, or `MOVEMENT_MAX_SEGMENT_SECONDS`). The engine reads no clock, so the host keeps this one. Past it, the calls already at your host finish, nothing more is asked, and the run fails with `MOVENG_LIMIT_WALL_CLOCK`.
- **Calls your modules make are not priced.** A module that pays for a service counts against the cap only if it reports its cost.

The full table is [docs/contracts/run-limits.md](contracts/run-limits.md).

## 7. One tenant cannot reach another

- Every run names its tenant, and the host answers every call for the tenant of the segment it was made in.
- Build each tenant's catalog from that tenant's connections only, and keep each tenant's credentials under its own ids.
- Check in your adapter resolver that the credential id a run names belongs to the run's tenant. The engine passes the id through; holding it to the tenant is yours. The example does this in `crmFor`.
- A movement reaches the network only through modules. The engine has no network code, and no family takes a URL from a movement.

## What the example leaves out

- Parks. The example's movements do not `await` or `sleep`; a durable host supplies the store slot (section 5).
- A real vault and a database for write locks.
- The live Anthropic path is wired (`ANTHROPIC_API_KEY`) but the test uses the fake model.
