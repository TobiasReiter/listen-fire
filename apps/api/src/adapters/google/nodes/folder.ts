import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import {
  nodeTypeRegistry,
  createNodeTypeId,
  FieldDefinition,
} from '../../pipeline/outbound/nodeTypes';

export const GDRIVE_FOLDER_NODE_TYPE = createNodeTypeId('gdrive', 'folder');

export const folderConfigSchema = z.object({
  parentFolderId: z.string(),
  parentFolderName: z.string().optional(),
});

export type GDriveFolderConfig = z.infer<typeof folderConfigSchema>;

const fieldDefinitions: FieldDefinition[] = [
  {
    key: 'parentFolderId',
    label: 'Parent Folder',
    type: 'drive-folder-select',
    required: true,
    description: 'The Google Drive folder to create subfolders in',
    hideForChildNode: true,
  },
];

export function register(childTypeIds: { document: string; upload: string }): void {
  nodeTypeRegistry.register({
    id: GDRIVE_FOLDER_NODE_TYPE,
    adapter: PipelineOutputType.GOOGLE_DRIVE,
    label: 'Folder',
    description: 'Create or find a folder in Google Drive',
    icon: 'folder',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [null, GDRIVE_FOLDER_NODE_TYPE],
    allowedChildTypes: [
      GDRIVE_FOLDER_NODE_TYPE,
      childTypeIds.document,
      childTypeIds.upload,
    ],
    configSchema: folderConfigSchema,
    fieldDefinitions,
  });
}
