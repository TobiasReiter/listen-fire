// Context parts an embedder fills a module's context with when it loads the
// module in its own process: the install's credential read from the
// embedder's secrets (one tenant's vault entry), and module state kept in
// memory. The platform builds the same parts over its own tables
// (apps/api builtin_modules.ts).

import type { WireCredentialDeclarationShape } from 'engine-contracts';
import { DEFAULT_REFRESH_WINDOW_MS, declaredRefresher, expiresWithin, type OAuth2ClientApp, type SecretsFamily } from 'movement-engine/public/secrets';

import type { CredentialFields, ModuleCredential, ModuleKv } from './define';

/**
 * The credential stored at `ref` in `secrets`, as a module reads it: its
 * fields read per call, a provider's change written back through the family
 * (under the store's lock).
 *
 * With `oauth2` (the module's declaration of the credential and the
 * embedder's app at the provider), an `oauth2` credential is refreshed by the
 * declared token URL: before a call when it expires within the window, and
 * when the provider refuses its token (`refresh`). Through the family, so one
 * refresh runs at a time per credential and two callers never spend the same
 * refresh token. A `static` declaration refreshes nothing.
 */
export function secretsCredential(input: {
  name: string;
  ref: string;
  secrets: SecretsFamily;
  oauth2?: {
    declaration: WireCredentialDeclarationShape;
    /** The embedder's app at the provider. Absent: the credential's own
     *  `client_id` and `client_secret` fields, if it holds them. */
    client?: OAuth2ClientApp;
    /** How long before expiry a token is refreshed. Default 30 seconds. */
    windowMs?: number;
    fetch?: typeof fetch;
  };
}): ModuleCredential {
  const { name, ref, secrets, oauth2 } = input;
  const refresher =
    oauth2 === undefined
      ? undefined
      : declaredRefresher(oauth2.declaration, {
          ...(oauth2.client !== undefined ? { client: oauth2.client } : {}),
          ...(oauth2.fetch !== undefined ? { fetch: oauth2.fetch } : {}),
        });
  const read = async (): Promise<CredentialFields> => (await secrets.resolve(ref)).fields;
  const credential: ModuleCredential = {
    name,
    fields: read,
    update: async (fields) => {
      await secrets.update(ref, fields);
    },
  };
  if (refresher === undefined) return credential;
  const windowMs = oauth2?.windowMs ?? DEFAULT_REFRESH_WINDOW_MS;
  return {
    ...credential,
    fields: async () => {
      const record = await secrets.resolve(ref);
      if (!expiresWithin(record.fields, windowMs)) return record.fields;
      return (await secrets.refresh(ref, { seenVersion: record.version, refresher })).fields;
    },
    // The provider refused a token before its expiry.
    refresh: async () => (await secrets.refresh(ref, { seenVersion: (await secrets.resolve(ref)).version, refresher })).fields,
  };
}

/** Module state in memory: one process, gone when it exits. */
export function memoryKv(): ModuleKv {
  const entries = new Map<string, unknown>();
  return {
    get: async (key) => entries.get(key),
    set: async (key, value) => {
      entries.set(key, value);
    },
    delete: async (key) => {
      entries.delete(key);
    },
    list: async (prefix) => [...entries].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
  };
}
