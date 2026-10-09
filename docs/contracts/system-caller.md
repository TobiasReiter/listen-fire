# The system caller

Version: 1

The system endpoints (`/api/v1/system/*`, the automations drain tick first) are called by an installation's own infrastructure: a scheduler, a push subscription, an operator's script. Who may call them is decided by **system caller verifiers**, asked in turn for each request. The first that accepts decides the caller; when none does, the request is refused `403`, its body naming each verifier's reason, and each reason is logged at most once a minute per caller address.

Two verifiers ship (`apps/api/src/services/system_auth/`), chosen by `SYSTEM_AUTH_MODES` (`deploy/SELF_HOSTING.md`):

- **`api_key`** (the default): an API key holding the `system` scope, or `*`. The host's own authentication verifies the key, and the verifier reads that verdict (`hostCredential`). The caller is the key, and the routes that act in a tenant act as its owner.
- **`oidc`**: an OpenID Connect identity token as the bearer, verified against the issuer's published keys: signature, expiry, issuer, audience, and a subject (`sub`, or a verified `email`) on the allow-list.

An embedder adds its own with `registerSystemCallerVerifier` before the server serves. This document is the interface it implements: an in-process one, so there is nothing on the wire to carry a version; the version is what an embedder's verifier states it was written against.

## Versions

- **The version is an integer**, held by `SYSTEM_CALLER_VERSION`. This release speaks version 1 only ([the index](README.md)).
- **What bumps it:** a member of the request removed or its meaning changed, a verdict reshaped, or an action whose meaning changed. A new optional request member, or a new action a verifier that does not know it simply never grants, keeps the version.

## The shape

The shapes are TypeScript-ish: `x?: T` may be absent.

```ts
interface SystemCallerVerifier {
  name: string;                      // names it in refusals and logs; unique among those registered
  verify(request: SystemCallerRequest): Promise<SystemCallerVerdict>;
}

interface SystemCallerRequest {
  method: string;                    // `POST`
  path: string;                      // the full path, `/api/v1/system/automations/drain`
  headers: Record<string, string | string[] | undefined>;  // names lower case, as Node reads them
  hostCredential?: HostCredential;   // the API key the host's own authentication verified, when there was one
}

interface HostCredential {
  id?: string;                       // the key's id
  scopes: string[];                  // the key's scopes
}

type SystemCallerVerdict =
  | { ok: true; principal: SystemCallerPrincipal; actions: SystemAction[] }
  | { ok: false; reason: string };   // shown to the caller and logged: never a token or a secret

interface SystemCallerPrincipal {
  id: string;                        // who called: the token's subject, the key's id
  display?: string;                  // a readable name, such as a service account's email
}

type SystemAction = 'drain';         // run a drain pass: POST /api/v1/system/automations/drain
```

- **A verifier refuses what it does not recognise** with a reason, and does not throw. One that throws has refused, with the error as its reason.
- **Actions are what the caller may do.** A route that performs an action refuses a caller that does not hold it. The routes that act in a tenant (the run listings and the system agent) need the tenant of a key the host verified, so they are the `api_key` verifier's alone, whatever another verifier grants.
- **A refused request is never half-authenticated.** When a verifier other than `api_key` is registered, a request to the system surface that the host's own authentication refused goes on to the verifiers with no principal; with `api_key` alone, the host's refusal stands as it always has.

## Changes

- **Version 1.** The first version: the request, the verdict, and the one action, `drain`.
