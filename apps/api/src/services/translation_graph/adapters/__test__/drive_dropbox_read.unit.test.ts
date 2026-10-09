// Drive + Dropbox read graphs (positions-and-edges): folders/files are
// stable nouns — collections off the meta root, children via
// `folders`/`files` edges, bytes via the file's `File` field (FileRef).
// Clients are mocked by overriding each adapter's private getClient.

jest.mock('../../../../lib/credentials', () => ({
  decryptToken: async () => '{}',
  encryptToken: async () => '',
}));

jest.mock('../../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../../../lib/recording', () => ({
  isTestHarnessTeam: () => false,
  injectFakeBaseUrl: (p: unknown) => p,
}));

import { Readable } from 'node:stream';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { FileRef } from '../../adapter';

import { isStablePosition, makeMetaPosition } from '../../types';
import * as grantedItems from '../../../credentials/granted_items';
import { GoogleDriveAdapter } from '../google_drive';
import { DropboxAdapter } from '../dropbox';

const TEAM = 'team-1' as TeamId;

async function text(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

describe('GoogleDriveAdapter read graph', () => {
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  // Under drive.file, the meta root's Folders come from the credential's GRANTED
  // items (Picker grants), not a `root` listing — so the top-level folder is a
  // grant, and its children come from `listChildren`.
  const items = {
    'fold-1': [
      { id: 'file-1', name: 'memo.txt', mimeType: 'text/plain', webViewLink: 'u2', size: 12 },
    ],
  } as Record<string, unknown[]>;

  beforeEach(() => {
    jest.spyOn(grantedItems, 'listGrantedItems').mockResolvedValue([
      { itemId: 'fold-1', mimeType: FOLDER_MIME, name: 'Deals' },
    ]);
  });
  afterEach(() => jest.restoreAllMocks());

  function adapter() {
    const a = new GoogleDriveAdapter({ teamId: TEAM, credentialsId: 'cred-1' });
    (a as unknown as { getClient: () => Promise<unknown> }).getClient = async () => ({
      listChildren: async (options: { parentId: string; kind?: string }) =>
        (items[options.parentId] ?? []).filter((i) =>
          options.kind === 'folder'
            ? (i as { mimeType: string }).mimeType === FOLDER_MIME
            : options.kind === 'file'
              ? (i as { mimeType: string }).mimeType !== FOLDER_MIME
              : true,
        ),
      downloadFile: async () => Readable.from('memo bytes'),
    });
    return a;
  }

  it('meta → Folders → files: stable positions, fields, and a working FileRef', async () => {
    const a = adapter();
    const [folder] = await a.getRelated({
      position: makeMetaPosition('google_drive'),
      fieldId: 'Folders',
      direction: 'outgoing',
    });
    expect(isStablePosition(folder.position)).toBe(true);
    expect(await a.getFieldValue({ position: folder.position, fieldId: 'Name' })).toBe(
      'Deals',
    );

    const [file] = await a.getRelated({
      position: folder.position,
      fieldId: 'Files',
      direction: 'outgoing',
    });
    expect(file.position.recordType).toBe('File');
    expect(await a.getFieldValue({ position: file.position, fieldId: 'Name' })).toBe('memo.txt');
    const ref = (await a.getFieldValue({ position: file.position, fieldId: 'File' })) as FileRef;
    expect(ref.__brand).toBe('FileRef');
    expect(ref.source).toEqual({ adapterType: 'google_drive', credentialId: 'cred-1', handle: 'file-1' });
    expect(await text((await a.resolveFileRef({ ref })).stream as Readable)).toBe('memo bytes');
  });
});

describe('DropboxAdapter read graph', () => {
  const entriesByPath: Record<string, unknown[]> = {
    '': [{ name: 'Deals', path: '/Deals', isFolder: true, size: null }],
    '/Deals': [
      { name: '2024', path: '/Deals/2024', isFolder: true, size: null },
      { name: 'notes.txt', path: '/Deals/notes.txt', isFolder: false, size: 5 },
    ],
  };

  function adapter() {
    const a = new DropboxAdapter({ teamId: TEAM, credentialsId: 'cred-1' });
    (a as unknown as { getClient: () => Promise<unknown> }).getClient = async () => ({
      listFolder: async (path: string) => entriesByPath[path] ?? [],
      download: async () => Readable.from('notes bytes'),
    });
    return a;
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
    expect(ref.source).toEqual({ adapterType: 'dropbox', credentialId: 'cred-1', handle: '/Deals/notes.txt' });
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
