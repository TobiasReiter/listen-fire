import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import { nodeTypeRegistry, createNodeTypeId, FieldDefinition } from '../../pipeline/outbound/nodeTypes';

export const DROPBOX_FOLDER_NODE_TYPE = createNodeTypeId('dropbox', 'folder');

export const folderConfigSchema = z.object({
  parentFolderPath: z.string(),
});

export type DropboxFolderConfig = z.infer<typeof folderConfigSchema>;

const fieldDefinitions: FieldDefinition[] = [
  {
    key: 'parentFolderPath',
    label: 'Parent Folder',
    type: 'dropbox-folder-select',
    required: true,
    description: 'Select a folder in your Dropbox',
    hideForChildNode: true,
  },
];

export function register(childTypeIds: { document: string; upload: string }): void {
  nodeTypeRegistry.register({
    id: DROPBOX_FOLDER_NODE_TYPE,
    adapter: PipelineOutputType.DROPBOX,
    label: 'Folder',
    description: 'Create or find a folder in Dropbox',
    icon: 'folder',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [null, DROPBOX_FOLDER_NODE_TYPE],
    allowedChildTypes: [
      DROPBOX_FOLDER_NODE_TYPE,
      childTypeIds.document,
      childTypeIds.upload,
    ],
    configSchema: folderConfigSchema,
    fieldDefinitions,
  });
}
