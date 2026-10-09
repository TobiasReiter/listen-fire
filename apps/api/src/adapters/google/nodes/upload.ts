import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import {
  nodeTypeRegistry,
  createNodeTypeId,
} from '../../pipeline/outbound/nodeTypes';

export const GDRIVE_UPLOAD_NODE_TYPE = createNodeTypeId('gdrive', 'upload');

export const uploadConfigSchema = z.object({});

export type GDriveUploadConfig = z.infer<typeof uploadConfigSchema>;

export function register(): void {
  nodeTypeRegistry.register({
    id: GDRIVE_UPLOAD_NODE_TYPE,
    adapter: PipelineOutputType.GOOGLE_DRIVE,
    label: 'Upload',
    description: 'Upload files from the knowledge graph to Google Drive',
    icon: 'upload_file',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [createNodeTypeId('gdrive', 'folder')],
    allowedChildTypes: [],
    configSchema: uploadConfigSchema,
    fieldDefinitions: [],
  });
}
