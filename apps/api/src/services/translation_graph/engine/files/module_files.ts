// A module's `ctx.files` on the platform. A file a module is handed in a
// write is read as any byte consumer here reads one (`streamFileRef`): a
// stored document the team owns, or a file an instance the run holds owns.
// Nothing asks the platform to keep a module's bytes yet, so `put` refuses.

import type { ModuleFiles } from 'module-kit';
import type { TeamId } from '../../../../generated/kysely/core/Team';

import { streamFileRef } from './retrieve';

export function platformModuleFiles(install: { teamId: TeamId; module: string }): ModuleFiles {
  return {
    put: async () => {
      throw new Error(`module ${install.module}: ctx.files.put has no store on the platform yet`);
    },
    read: async (ref) => {
      const { stream } = await streamFileRef(ref, { teamId: install.teamId });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return new Uint8Array(Buffer.concat(chunks));
    },
  };
}
