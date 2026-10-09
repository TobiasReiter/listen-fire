import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import {
  nodeTypeRegistry,
  createNodeTypeId,
} from '../../pipeline/outbound/nodeTypes';

export const AFFINITY_PREVIEW_NODE_TYPE = createNodeTypeId('affinity', 'preview');

const configSchema = z.object({});

export type AffinityPreviewConfig = z.infer<typeof configSchema>;

export function register(): void {
  nodeTypeRegistry.register({
    id: AFFINITY_PREVIEW_NODE_TYPE,
    adapter: PipelineOutputType.AFFINITY,
    label: 'Preview',
    description: 'Add an HTML note with the email body to an organization or person',
    icon: 'preview',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [
      createNodeTypeId('affinity', 'organization'),
      createNodeTypeId('affinity', 'person'),
    ],
    allowedChildTypes: [],
    configSchema,
    fieldDefinitions: [],
  });
}
