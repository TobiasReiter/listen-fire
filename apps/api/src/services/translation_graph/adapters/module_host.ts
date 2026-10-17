// What the platform lends a built-in module beside its credential: its models
// (routed by this deployment's model map, metered and billed to the run like
// the platform's own calls) and the files a run holds (redeemed for the
// install's team; exposed at a short-lived URL for a provider that downloads
// an attachment itself). A module asks through `ctx`; nothing here names one.

import { Readable } from 'node:stream';

import type { FileRef } from 'movement-engine/public/adapter';
import type { ModuleFiles, ModuleModels } from 'module-kit';
import type { TeamId } from '../../../generated/kysely/core/Team';

import { anthropicChat, anthropicChatStructured } from '../../../lib/anthropic';
import { streamFileRef } from '../engine/files/retrieve';
import { exposeFile } from '../engine/files/expose';

export const hostedModels: ModuleModels = {
  chat: (input) => anthropicChat(input),
  chatStructured: (input) => anthropicChatStructured(input),
};

async function bytesOf(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** The team's files, for a module installed by it. A module writes files
 *  only through the records it returns, so `put` has no store yet. */
export function hostedModuleFiles(teamId: TeamId, moduleName: string): ModuleFiles {
  return {
    put: async () => {
      throw new Error(`module ${moduleName}: ctx.files.put has no store on the platform yet (no built-in module uses it)`);
    },
    read: async (ref: FileRef) => bytesOf((await streamFileRef(ref, { teamId })).stream),
    expose: async (ref: FileRef) => {
      const resolved = await streamFileRef(ref, { teamId });
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
