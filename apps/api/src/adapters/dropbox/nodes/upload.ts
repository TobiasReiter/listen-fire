import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import { nodeTypeRegistry, createNodeTypeId } from '../../pipeline/outbound/nodeTypes';

export const DROPBOX_UPLOAD_NODE_TYPE = createNodeTypeId('dropbox', 'upload');

export const uploadConfigSchema = z.object({});

export type DropboxUploadConfig = z.infer<typeof uploadConfigSchema>;

export function register(): void {
  nodeTypeRegistry.register({
    id: DROPBOX_UPLOAD_NODE_TYPE,
    adapter: PipelineOutputType.DROPBOX,
    label: 'Upload',
    description: 'Upload files from the knowledge graph to Dropbox',
    icon: 'upload_file',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [createNodeTypeId('dropbox', 'folder')],
    allowedChildTypes: [],
    configSchema: uploadConfigSchema,
    fieldDefinitions: [],
  });
}
