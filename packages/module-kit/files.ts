// Files, from a module's side. A file the module reads out names itself by
// the module's own handle; the host makes it a file the install owns (the
// engine redeems it through the module's `resolveFileRef`). A file the module
// is handed in a write is read the way it arrived: at its `url` when a host
// exposed it there (a module served as a process is always handed one), else
// through the host's `ctx.files`.

import type { FileRef } from 'engine-contracts';
import type { ModuleContext } from './define';

/** A file this module reads out, named by its own `handle`. */
export function moduleFileRef(input: {
  /** The module's adapter type: the file's owner. */
  adapterType: string;
  handle: string;
  name?: string;
  contentType?: string;
  size?: number;
}): FileRef {
  return {
    __brand: 'FileRef',
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
    ...(input.size !== undefined ? { size: input.size } : {}),
    source: { ownerAdapterType: input.adapterType, handle: input.handle },
  };
}

/** The bytes of a file the module was handed. */
export async function readHandedFile(ctx: Pick<ModuleContext, 'fetch' | 'files'>, ref: FileRef): Promise<Uint8Array> {
  if (typeof ref.url === 'string') {
    const response = await ctx.fetch(ref.url);
    if (!response.ok) {
      throw new Error(`the file${ref.name !== undefined ? ` '${ref.name}'` : ''} could not be fetched from its url (status ${response.status})`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  return ctx.files.read(ref);
}
