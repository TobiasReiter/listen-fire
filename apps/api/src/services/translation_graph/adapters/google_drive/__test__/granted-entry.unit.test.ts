// Unit tests for the Drive meta-root's granted-items entry points
// (2026-07-10): under the drive.file scope `listChildren('root')` returns
// nothing, so the meta root's `Folders`/`Files` collections must be fed from
// the credential's GRANTED items (the generic `granted_items` store) instead,
// split by mimeType. Deeper hops (folder → children, file bytes) and the
// write path are unchanged and stay covered by adapter-google-drive.unit.test.ts.
//
// Same module-scope stubs as that file — the real driveClient/output_v3/
// uniqueness_constraints chains crash at load in jest.

jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => '{}',
  encryptToken: async () => '',
}));

jest.mock('movement-engine/services/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../../../../../lib/recording', () => ({
  isTestHarnessTeam: () => false,
  injectFakeBaseUrl: (p: unknown) => p,
}));

jest.mock('../../../../../adapters/google/driveClient', () => ({
  GoogleDriveClient: class {},
}));

jest.mock('../../../../../adapters/registry', () => ({
  services: { google: undefined },
}));

jest.mock('movement-engine/services/knowledge_pipeline/output_v3/schemas', () => {
  const stub: Record<string, unknown> = {};
  const ret = () => stub;
  Object.assign(stub, {
    optional: ret, nullable: ret, default: ret, array: ret,
    parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true, data: v }),
    refine: ret, transform: ret, extend: ret, merge: ret,
    pick: ret, omit: ret, partial: ret, describe: ret, or: ret, and: ret, min: ret,
  });
  return {
    traversalStepSchema: stub,
    fieldRefSchema: stub,
    expressionSchema: stub,
    filterExpressionSchema: stub,
    webhookGraphOutputConfigSchema: stub,
  };
});

jest.mock('../../../../knowledge_pipeline/uniqueness_constraints', () => {
  const stub: Record<string, unknown> = {};
  const ret = () => stub;
  Object.assign(stub, {
    optional: ret, nullable: ret, default: ret, array: ret,
    parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true, data: v }),
    refine: ret, transform: ret,
  });
  return {
    isEdgeToEntry: (entry: { kind?: string }) => entry?.kind === 'edge_to',
    storedUniquenessConstraintsSchema: stub,
  };
});

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { GetRelatedInput } from 'movement-engine/services/translation_graph/adapter';

import { GoogleDriveAdapter } from '../index';
import { DISPLAY_NAME_BY_KIND, GOOGLE_DRIVE_ADAPTER_TYPE } from '../types';
import { DRIVE_FILES_COLLECTION, DRIVE_FILE_TYPE, DRIVE_FOLDERS_COLLECTION } from '../schema_catalog';
import { META_RECORD_TYPE, makeStablePosition } from 'movement-engine/services/translation_graph/types';
import * as grantedItems from '../../../../credentials/granted_items';
import { DRIVE_FOLDER_MIME } from '../../../../credentials/granted_items';

function metaPosition(): GetRelatedInput['position'] {
  return makeStablePosition({
    adapterType: GOOGLE_DRIVE_ADAPTER_TYPE,
    recordType: META_RECORD_TYPE,
    recordId: 'root',
    data: {},
  });
}

describe('GoogleDriveAdapter meta-root — granted items as entry points', () => {
  beforeEach(() => {
    jest.spyOn(grantedItems, 'listGrantedItems').mockResolvedValue([
      { itemId: 'fold1', mimeType: DRIVE_FOLDER_MIME, name: 'Folder' },
      { itemId: 'file1', mimeType: 'application/pdf', name: 'Doc.pdf' },
    ]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeAdapter(): GoogleDriveAdapter {
    return new GoogleDriveAdapter({ teamId: 'team-drive' as TeamId, credentialsId: 'creds-1' });
  }

  it('lists granted folders under the Folders collection, not client.listChildren', async () => {
    const adapter = makeAdapter();
    const res = await adapter.getRelated({
      direction: 'outgoing',
      position: metaPosition(),
      fieldId: DRIVE_FOLDERS_COLLECTION,
    });

    expect(grantedItems.listGrantedItems).toHaveBeenCalledWith('creds-1');
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
