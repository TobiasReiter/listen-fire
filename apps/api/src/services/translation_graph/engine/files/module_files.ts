// A module's `ctx.files` on the platform. A file a module is handed in a
// write is read as any byte consumer here reads one (`streamFileRef`): a
// stored document the team owns, or a file an instance the run holds owns.
// A provider that downloads an attachment itself is handed it at a
// short-lived URL (`exposeFile`). Nothing asks the platform to keep a
// module's bytes yet, so `put` refuses.

import { Readable } from 'node:stream';

import type { ModuleFiles } from 'module-kit';
import type { TeamId } from '../../../../generated/kysely/core/Team';

import { streamFileRef } from './retrieve';
import { exposeFile } from './expose';

async function bytesOf(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

export function platformModuleFiles(install: { teamId: TeamId; module: string }): ModuleFiles {
  return {
    put: async () => {
      throw new Error(`module ${install.module}: ctx.files.put has no store on the platform yet`);
    },
    read: async (ref) => bytesOf((await streamFileRef(ref, { teamId: install.teamId })).stream),
    expose: async (ref) => {
      const resolved = await streamFileRef(ref, { teamId: install.teamId });
      // Unstamped, as the adapters that exposed files before modules did (the
      // row's team is best-effort; see `exposeFile`).
      const contentType = resolved.contentType ?? ref.contentType;
      const exposed = await exposeFile({
        stream: Readable.from(await bytesOf(resolved.stream)),
        ...(ref.name !== undefined ? { filename: ref.name } : {}),
        ...(contentType !== undefined ? { contentType } : {}),
      });
      return { url: exposed.url };
    },
  };
}
