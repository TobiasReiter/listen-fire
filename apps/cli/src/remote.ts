// An adapter external, as the engine's host reaches it: the hosted product's
// own remote adapter (`RemoteAdapter`), so every call lf makes to an external
// — the run's, the catalog's, an inbound webhook's — is the same code the
// hosted product runs: its position rewriting, its file transport, its call
// count against the segment's ceiling, its validation of each answer.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { triggerTypeSchema } from 'engine-contracts';
import { createRemoteAdapter, type RemoteAdapter } from 'movement-engine/public/modules';
import type { DocumentStore } from 'movement-engine/public/files';
import type { RunningExternal } from './externals';
import { clientFromFields } from 'movement-engine/public/secrets';
import { neverAsAny } from 'movement-engine/public/utils';
import { bindingOf, installOf, secretsOf, withCredential, type Credential } from './secrets';

export function remoteAdapterOf(input: {
  running: RunningExternal;
  /** The credential the connection names (`using`), or the external's own
   *  when it names none. */
  credential: Credential | undefined;
  /** Every loaded secrets entry: the external's install is found among them. */
  secrets: Map<string, Credential>;
  documents: DocumentStore;
  tenant: string;
}): RemoteAdapter {
  const { running, credential } = input;
  const name = running.external.manifest.name;
  const binding = credential !== undefined ? bindingOf(credential) : undefined;
  // The server secret belongs to the install; a hand-written entry is install
  // and credential in one, as it always was.
  const signer = binding?.kind === 'legacy' ? credential : (installOf(input.secrets, name) ?? credential);
  const install = signer !== undefined && bindingOf(signer).kind === 'install' ? signer : undefined;
  const provider = providerOf(running, credential);
  return createRemoteAdapter({
    config: {
      adapterType: name,
      teamId: input.tenant,
      baseUrl: running.baseUrl,
      authStrategy: { kind: 'bearer' },
      // A credential's id is its name in the secrets file.
      credentialsId: credential?.name ?? '',
    },
    secret: secretOf(running, signer),
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
    ...(provider !== undefined
      ? {
          // The external declares the credential: it is sent on each call and
          // refreshed from the declaration with the install's OAuth app (a
          // hand-written entry's own client fields), and a rotation is written
          // back to the entry the connection named. The server secret is the
          // install's, read per attempt.
          credential: {
            name: provider.declared,
            secrets: secretsOf(provider.credential),
            ref: provider.credential.name,
            ...(install !== undefined && clientFromFields(install.fields) !== undefined ? { client: clientFromFields(install.fields) } : {}),
          },
          authorize: (call) => call(secretOf(running, signer)),
        }
      : {
          // A refreshable credential is refreshed before a call that would carry a
          // stale token, and once more when the external answers `unauthorized`;
          // each attempt sends the credential's secret as it stands then.
          authorize: (call) => withCredential(signer, () => call(secretOf(running, signer))),
        }),
  });
}

/** The declared credential a call carries, and the entry it comes from: a
 *  user credential carries the one it was made for; a hand-written entry
 *  carries the first the external declares, as it always did. */
function providerOf(running: RunningExternal, credential: Credential | undefined): { declared: string; credential: Credential } | undefined {
  if (credential === undefined) return undefined;
  const binding = bindingOf(credential);
  const name = running.external.manifest.name;
  switch (binding.kind) {
    case 'install':
      return undefined;
    case 'legacy': {
      const first = running.credentials[0];
      return first !== undefined ? { declared: first.name, credential } : undefined;
    }
    case 'credential':
      if (!running.credentials.some((declared) => declared.name === binding.declared)) {
        throw new Error(`credential "${credential.name}" is for "${binding.declared}", which external "${name}" does not declare; it is not sent`);
      }
      return { declared: binding.declared, credential };
    default:
      return neverAsAny(binding);
  }
}

/** The secret a call to this external carries: the named field of the
 *  credential. An external that declares no auth is sent none. */
function secretOf(running: RunningExternal, credential: Credential | undefined): string {
  const auth = running.external.manifest.auth;
  const name = running.external.manifest.name;
  if (auth === undefined) return '';
  if (credential === undefined) throw new Error(`external "${name}" needs its install set up (\`lf connect ${name}\`; its auth field is "${auth.field}")`);
  const secret = credential.fields[auth.field];
  if (secret === undefined) {
    throw new Error(`credential "${credential.name}" has no "${auth.field}" field, which external "${name}" sends`);
  }
  return secret;
}
