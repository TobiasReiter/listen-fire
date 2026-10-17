// Dropbox read graph (positions-and-edges): folders/files are stable nouns —
// collections off the meta root, children via `folders`/`files` edges, bytes
// via the file's `File` field (FileRef). The client is faked.

import { Readable } from 'node:stream';

import type { FileRef } from 'movement-engine/public/adapter';

import { isStablePosition, makeMetaPosition } from 'movement-engine/public/catalog';
import { DropboxAdapter } from '../adapter';

async function text(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

describe('DropboxAdapter read graph', () => {
  const entriesByPath: Record<string, unknown[]> = {
    '': [{ name: 'Deals', path: '/Deals', isFolder: true, size: null }],
    '/Deals': [
      { name: '2024', path: '/Deals/2024', isFolder: true, size: null },
      { name: 'notes.txt', path: '/Deals/notes.txt', isFolder: false, size: 5 },
    ],
  };

  function adapter() {
    return new DropboxAdapter({
      client: async () =>
        ({
          listFolder: async (path: string) => entriesByPath[path] ?? [],
          download: async () => Readable.from('notes bytes'),
        }) as never,
      files: { read: async () => Buffer.from('') },
      log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
  }

  it('meta → Folders → files: path-addressed positions, fields, and a working FileRef', async () => {
    const a = adapter();
    const [folder] = await a.getRelated({
      position: makeMetaPosition('dropbox'),
      fieldId: 'Folders',
      direction: 'outgoing',
    });
    expect(isStablePosition(folder.position)).toBe(true);
    expect(await a.getFieldValue({ position: folder.position, fieldId: 'Path' })).toBe('/Deals');

    const [file] = await a.getRelated({
      position: folder.position,
      fieldId: 'Files',
      direction: 'outgoing',
    });
    expect(file.position.recordType).toBe('File');
    expect(await a.getFieldValue({ position: file.position, fieldId: 'Name' })).toBe('notes.txt');
    const ref = (await a.getFieldValue({ position: file.position, fieldId: 'File' })) as FileRef;
    // The file names its owner type and its handle; the host adds the install.
    expect(ref.source).toEqual({ adapterType: 'dropbox', handle: '/Deals/notes.txt' });
    expect(await text((await a.resolveFileRef({ ref })).stream as Readable)).toBe('notes bytes');
  });

  it('file → parent and sub-folder → parent hop up the tree (path-derived, no round trip)', async () => {
    const a = adapter();
    const [file] = await a.getRelated({
      position: makeMetaPosition('dropbox'),
      fieldId: 'Folders',
      direction: 'outgoing',
    }).then(([folder]) =>
      a.getRelated({ position: folder.position, fieldId: 'Files', direction: 'outgoing' }),
    );
    const [fileParent] = await a.getRelated({
      position: file.position,
      fieldId: 'Parent',
      direction: 'outgoing',
    });
    expect(fileParent.position.recordType).toBe('Folder');
    expect(await a.getFieldValue({ position: fileParent.position, fieldId: 'Path' })).toBe('/Deals');

    // A sub-folder resolves its parent the same way.
    const [subfolder] = await a.getRelated({
      position: (
        await a.getRelated({ position: makeMetaPosition('dropbox'), fieldId: 'Folders', direction: 'outgoing' })
      )[0].position,
      fieldId: 'Folders',
      direction: 'outgoing',
    });
    const [subParent] = await a.getRelated({
      position: subfolder.position,
      fieldId: 'Parent',
      direction: 'outgoing',
    });
    expect(await a.getFieldValue({ position: subParent.position, fieldId: 'Path' })).toBe('/Deals');
  });

  it('a top-level folder honestly yields no parent (its parent is the Dropbox root)', async () => {
    const a = adapter();
    const [deals] = await a.getRelated({
      position: makeMetaPosition('dropbox'),
      fieldId: 'Folders',
      direction: 'outgoing',
    });
    const parents = await a.getRelated({
      position: deals.position,
      fieldId: 'Parent',
      direction: 'outgoing',
    });
    expect(parents).toEqual([]);
  });
});
