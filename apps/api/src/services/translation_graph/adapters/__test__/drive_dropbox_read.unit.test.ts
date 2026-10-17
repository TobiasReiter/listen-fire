// Drive read graph (the Dropbox half moved with the module, modules/dropbox):
// stable nouns — collections off the meta root, children via
// `folders`/`files` edges, bytes via the file's `File` field (FileRef).
// Drive's client and grants are what its module adapter is constructed with,
// its files named as the install's as the platform names them.

jest.mock('../../../../lib/credentials', () => ({
  decryptToken: async () => '{}',
  encryptToken: async () => '',
}));

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../../../lib/recording', () => ({
  isTestHarnessTeam: () => false,
  injectFakeBaseUrl: (p: unknown) => p,
}));

import { Readable } from 'node:stream';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { FileRef } from 'movement-engine/services/translation_graph/adapter';

import { isStablePosition, makeMetaPosition } from 'movement-engine/services/translation_graph/types';
import { GoogleDriveAdapter, type GoogleDriveClient } from '@lf/google-drive';
import { refusingFiles } from 'module-kit';
import { ownedFilesAdapter } from 'movement-engine/public/modules';

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

  function adapter() {
    const client = {
      listChildren: async (options: { parentId: string; kind?: string }) =>
        (items[options.parentId] ?? []).filter((i) =>
          options.kind === 'folder'
            ? (i as { mimeType: string }).mimeType === FOLDER_MIME
            : options.kind === 'file'
              ? (i as { mimeType: string }).mimeType !== FOLDER_MIME
              : true,
        ),
      downloadFile: async () => Readable.from('memo bytes'),
    };
    const drive = new GoogleDriveAdapter({
      client: async () => client as unknown as GoogleDriveClient,
      kv: {
        get: async () => undefined,
        set: async () => undefined,
        delete: async () => undefined,
        list: async () => [{ key: 'granted/fold-1', value: { mimeType: FOLDER_MIME, name: 'Deals' } }],
      },
      readFile: (ref) => refusingFiles('no files').read(ref),
      log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    return ownedFilesAdapter(drive, { adapterType: 'google_drive', credentialsId: 'cred-1' });
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
    expect(await text(((await a.resolveFileRef?.({ ref }))?.stream ?? Readable.from([])) as Readable)).toBe('memo bytes');
  });
});
