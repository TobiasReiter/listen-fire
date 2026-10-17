// Unit tests for the Drive meta-root's granted-items entry points
// (2026-07-10): under the drive.file scope `listChildren('root')` returns
// nothing, so the meta root's `Folders`/`Files` collections must be fed from
// the install's GRANTED items (its kv, `granted/<itemId>`) instead, split by
// mimeType. Deeper hops (folder → children, file bytes) and the write path
// are unchanged and stay covered by adapter-google-drive.unit.test.ts.

import type { GetRelatedInput } from 'movement-engine/public/adapter';
import type { ModuleKv, ModuleLog } from 'module-kit';

import { META_RECORD_TYPE, makeStablePosition } from 'movement-engine/public/catalog';
import { GoogleDriveAdapter } from '../adapter';
import { DRIVE_FOLDER_MIME } from '../drive_client';
import { DISPLAY_NAME_BY_KIND, GOOGLE_DRIVE_ADAPTER_TYPE } from '../types';
import { DRIVE_FILES_COLLECTION, DRIVE_FILE_TYPE, DRIVE_FOLDERS_COLLECTION } from '../schema_catalog';

const quiet: ModuleLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function metaPosition(): GetRelatedInput['position'] {
  return makeStablePosition({
    adapterType: GOOGLE_DRIVE_ADAPTER_TYPE,
    recordType: META_RECORD_TYPE,
    recordId: 'root',
    data: {},
  });
}

describe('GoogleDriveAdapter meta-root — granted items as entry points', () => {
  const listed: string[] = [];
  const kv: ModuleKv = {
    get: async () => undefined,
    set: async () => undefined,
    delete: async () => undefined,
    list: async (prefix) => {
      listed.push(prefix);
      return [
        { key: 'granted/fold1', value: { mimeType: DRIVE_FOLDER_MIME, name: 'Folder' } },
        { key: 'granted/file1', value: { mimeType: 'application/pdf', name: 'Doc.pdf' } },
      ];
    },
  };

  function makeAdapter(): GoogleDriveAdapter {
    return new GoogleDriveAdapter({
      client: async () => {
        throw new Error('the meta root never reaches the client');
      },
      kv,
      readFile: async () => {
        throw new Error('no files');
      },
      log: quiet,
    });
  }

  it('lists granted folders under the Folders collection, not client.listChildren', async () => {
    const adapter = makeAdapter();
    const res = await adapter.getRelated({
      direction: 'outgoing',
      position: metaPosition(),
      fieldId: DRIVE_FOLDERS_COLLECTION,
    });

    expect(listed).toContain('granted/');
    expect(res).toHaveLength(1);
    expect(res[0].position.recordType).toBe(DISPLAY_NAME_BY_KIND.folder);
    expect(res[0].position.identity.kind).toBe('stable');
    expect(res[0].position.identity.kind === 'stable' && res[0].position.identity.recordId).toBe(
      'fold1',
    );
  });

  it('lists granted files under the Files collection, split from folders by mimeType', async () => {
    const adapter = makeAdapter();
    const res = await adapter.getRelated({
      direction: 'outgoing',
      position: metaPosition(),
      fieldId: DRIVE_FILES_COLLECTION,
    });

    expect(res).toHaveLength(1);
    expect(res[0].position.recordType).toBe(DRIVE_FILE_TYPE);
    expect(res[0].position.identity.kind === 'stable' && res[0].position.identity.recordId).toBe(
      'file1',
    );
  });

  it('returns [] for an unrecognised meta-root collection without touching the client', async () => {
    const adapter = makeAdapter();
    const res = await adapter.getRelated({
      direction: 'outgoing',
      position: metaPosition(),
      fieldId: 'Bogus',
    });
    expect(res).toEqual([]);
  });
});
