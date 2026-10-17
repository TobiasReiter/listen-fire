// What the platform gives a module for files (`ctx.files`), and the one
// thing it adds to a file a module hands back: which install owns it.
//
// A module names a file it returns by its owner type and its own handle (a
// Dropbox path) and knows nothing of credentials. The platform redeems a file
// through the instance a run holds for that owner, and with two installs of
// one type that is only unambiguous when the descriptor names its install
// (the credential), as every adapter-owned file here always has.

import { Readable } from 'node:stream';

import type { ModuleFiles } from 'module-kit';
import type { Adapter, FileRef, GetFieldValueInput } from 'movement-engine/public/adapter';
import type { TeamId } from '../../../generated/kysely/core/Team';

import { fileDescriptorOf, ownedFileSource } from 'movement-engine/public/adapter';
import { hostedDocumentStore, streamFileRef } from '../engine/files/retrieve';

async function bytesOf(stream: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** The team's own files: a file value is read the way a target adapter's write
 *  has always read one (the run's team's bytes only), and bytes put are
 *  stored as the team's. */
export function platformFiles(teamId: TeamId): ModuleFiles {
  return {
    read: async (ref: FileRef) => {
      const { stream } = await streamFileRef(ref, { teamId });
      return bytesOf(stream);
    },
    put: ({ bytes, name, contentType }) =>
      hostedDocumentStore.put({
        tenantId: teamId,
        bytes: Buffer.from(bytes),
        name: name ?? 'file',
        contentType: contentType ?? 'application/octet-stream',
      }),
  };
}

/** `adapter`, answering a file it owns with the install named: a descriptor
 *  whose source is this adapter's type and a handle, and no credential,
 *  gains `credentialsId`. Any other value is unchanged. */
export function nameFileOwner(adapter: Adapter, credentialsId: string): Adapter {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (property !== 'getFieldValue' || typeof member !== 'function') return member;
      return async (input: GetFieldValueInput): Promise<unknown> => {
        const value: unknown = await Reflect.apply(member, target, [input]);
        const ref = fileDescriptorOf(value);
        const source = ref?.source;
        if (ref === undefined || source === undefined || 'store' in source || 'ownerAdapterType' in source) return value;
        if (source.adapterType !== target.adapterType || source.credentialId !== undefined) return value;
        return { ...ref, source: ownedFileSource({ adapterType: source.adapterType, credentialsId, handle: source.handle }) };
      };
    },
  });
}
