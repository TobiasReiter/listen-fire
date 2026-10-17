# ev1-protocol report (stream P)

Done. Branch ev1-protocol, cut from 4ba5f821. Commits: 0fc7f161 (schemas + contract tests), c6fe80b5 (spec, catalog pin, CHANGELOG).

## Names other streams build on (all exported from `engine-contracts`)

Manifest (spread into `WireManifestResult` as `WireModuleDeclarations`, all optional):
- `credentials: WireCredentialDeclaration[]`, discriminated on `kind`:
  - `{ name, kind: 'static', fields }`
  - `{ name, kind: 'oauth2', fields, oauth2: WireOAuth2Declaration }`; oauth2 = `{ authorizeUrl, tokenUrl, scopes?, clientAuth?: 'basic'|'body' (absent = basic), pkce?, authorizeParams? }`; token fields fixed: `access_token`, `refresh_token`, `expires_at` (ISO)
  - field = `WireCredentialField { name, label?, secret? (absent = secret), optional? }`
- `inbound: WireInboundDeclaration { providerKey, scheme, signatureHeaders (lower case, >= 1, first present wins), intercepts? }`
  - `INBOUND_SIGNATURE_SCHEMES` / `WireInboundSignatureScheme`: hmac_sha256_hex, airtable_mac, attio, affinity_hex_or_b64, slack_v0, telegram_secret_token, remote
  - `INBOUND_INTERCEPTS` / `WireInboundIntercept`: slack_url_verification (only one so far; D1 adds more here)
- `poll: WirePollDeclaration { intervalSeconds }`
- `periodic: WirePeriodicDeclaration[] { name, intervalSeconds }`

Envelope:
- `RpcRequest.credential?: WireCredential { name, fields: Record<string,string> }`
- both `RpcResponse` arms: `credentialUpdate?: WireCredentialUpdate { name, fields }` (partial, merged by the host)
- `WireCredentialFields` = `Record<string, string>`

Methods (in `METHODS`, optional):
- `poll`: `{ config, checkpoint? }` -> `{ events: WireDiscriminableEvent[], checkpoint? }`
- `refreshCredential`: `{}` -> `{ fields }` (the credential is the envelope's)
- `runPeriodic`: `{ name }` -> `null`

## Decisions
- Version negotiation as the spec already does it: no version bump; a method is called only if listed in `methods`, a declaration is acted on only if present. Old servers send neither; old hosts strip both.
- Added `runPeriodic` (not in the brief): a `periodic` declaration needs a method to call, or it means nothing over the wire.
- `credentialUpdate` rides failures too: a refresh followed by a refused call must still return a rotated refresh token.
- The manifest is refused when a declaration lacks its method or the reverse (poll/poll, periodic/runPeriodic; refreshCredential needs credentials, credentials do not need refreshCredential), and on duplicate names. Loud, not silent.
- Unknown scheme or intercept refuses the manifest (closed enums), so nothing goes silently unverified.
- Credential field values are strings only (matches lf's secrets files).
- `poll` has no `movementId` (only the system source used it, and system is a host unit, not a module).

## Not done (other streams)
- The installable manifest file schema (apps/api `adapters/remote/manifest.ts`) does not yet spread `WireModuleDeclarations.shape`; left alone because changing it changes what a production install stores. The stream that wires hosted modules (A0/B4) should add it.
- No client, server kit, host or backend acts on any of it.

## Tests
- engine-contracts: 4 suites, 54 tests pass (new `protocol_modules.unit.test.ts`: old messages validate, new ones round-trip, refusals).
- apps/api scoped (protocol, remote adapter, conformance, remote inbound): 10 suites, 176 tests pass after adding the three names to the pinned method catalog.
- apps/cli externals: 3/3.
- Type-check clean: engine-contracts, movement-engine, apps/cli, apps/api.

## Files outside the stream
- `apps/api/src/services/translation_graph/protocol/__test__/schema.unit.test.ts`: three method names added to the pinned catalog list.
