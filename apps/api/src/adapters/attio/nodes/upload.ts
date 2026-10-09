import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import {
  nodeTypeRegistry,
  createNodeTypeId,
} from '../../pipeline/outbound/nodeTypes';

export const ATTIO_UPLOAD_NODE_TYPE = createNodeTypeId('attio', 'upload');

export const uploadConfigSchema = z.object({});

export type AttioUploadConfig = z.infer<typeof uploadConfigSchema>;

export function register(): void {
  nodeTypeRegistry.register({
    id: ATTIO_UPLOAD_NODE_TYPE,
    adapter: PipelineOutputType.ATTIO,
    label: 'Upload',
    description: 'Upload files from the knowledge graph to an Attio record',
    icon: 'upload_file',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [
      createNodeTypeId('attio', 'object'),
      createNodeTypeId('attio', 'list-entry'),
    ],
    allowedChildTypes: [],
    configSchema: uploadConfigSchema,
    fieldDefinitions: [],
  });
}
