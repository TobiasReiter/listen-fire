// An adapter external, as the engine's host reaches it: the hosted product's
// own remote adapter (`RemoteAdapter`), so every call lf makes to an external
// — the run's, the catalog's, an inbound webhook's — is the same code the
// hosted product runs: its position rewriting, its file transport, its call
// count against the segment's ceiling, its validation of each answer.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { triggerTypeSchema } from 'engine-contracts';
import { createRemoteAdapter, type RemoteAdapter } from 'movement-engine/services/translation_graph/adapters/remote';
import type { DocumentStore } from 'movement-engine/services/translation_graph/engine/files/document_store';
import type { RunningExternal } from './externals';
import { secretsOf, withCredential, type Credential } from './secrets';

export function remoteAdapterOf(input: {
  running: RunningExternal;
  credential: Credential | undefined;
  documents: DocumentStore;
  tenant: string;
}): RemoteAdapter {
  const { running, credential } = input;
  const name = running.external.manifest.name;
  // The protocol carries one credential per request: the first declared.
  const declared = running.credentials[0];
  return createRemoteAdapter({
    config: {
      adapterType: name,
      teamId: input.tenant,
      baseUrl: running.baseUrl,
      authStrategy: { kind: 'bearer' },
      // A credential's id is its name in the secrets file.
      credentialsId: credential?.name ?? '',
    },
    secret: secretOf(running, credential),
    cacheScopeId: randomUUID(),
    manifest: {
      adapterType: name,
      supportedTriggers: z.array(triggerTypeSchema).parse(running.supportedTriggers),
      runtimeCapabilities: running.runtimeCapabilities,
      methods: running.methods,
      ...(running.webhookEventTypeId !== undefined ? { webhookEventTypeId: running.webhookEventTypeId } : {}),
      credentials: running.credentials,
    },
    documents: input.documents,
    ...(declared !== undefined && credential !== undefined
      ? {
          // The external declares its credential: it is sent on each call and
          // refreshed from the declaration, so the auth secret is read as it
          // stands after any refresh, with no second refresh of its own.
          credential: { name: declared.name, secrets: secretsOf(credential), ref: credential.name },
          authorize: (call) => call(secretOf(running, credential)),
        }
      : {
          // A refreshable credential is refreshed before a call that would carry a
          // stale token, and once more when the external answers `unauthorized`;
          // each attempt sends the credential's secret as it stands then.
          authorize: (call) => withCredential(credential, () => call(secretOf(running, credential))),
        }),
  });
}

/** The secret a call to this external carries: the named field of the
 *  credential. An external that declares no auth is sent none. */
function secretOf(running: RunningExternal, credential: Credential | undefined): string {
  const auth = running.external.manifest.auth;
  const name = running.external.manifest.name;
  if (auth === undefined) return '';
  if (credential === undefined) throw new Error(`external "${name}" needs a credential (its auth field is "${auth.field}")`);
  const secret = credential.fields[auth.field];
  if (secret === undefined) {
    throw new Error(`credential "${credential.name}" has no "${auth.field}" field, which external "${name}" sends`);
  }
  return secret;
}
