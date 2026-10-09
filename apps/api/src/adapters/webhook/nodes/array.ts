import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import {
  nodeTypeRegistry,
  createNodeTypeId,
  FieldDefinition,
} from '../../pipeline/outbound/nodeTypes';
import { objectFieldSchema } from './object';

export const WEBHOOK_ARRAY_NODE_TYPE = createNodeTypeId('webhook', 'array');

export const arrayConfigSchema = z.object({
  key: z.string().min(1), // Required - the key name for this array
  fields: z.array(objectFieldSchema).default([]), // Fields for each object in the array
});

export type WebhookArrayConfig = z.infer<typeof arrayConfigSchema>;

const fieldDefinitions: FieldDefinition[] = [
  {
    key: 'key',
    label: 'Key',
    type: 'text',
    required: true,
    description: 'The key name for this array in the parent (e.g., "founders", "tags")',
    placeholder: 'e.g., founders',
  },
  {
    key: 'fields',
    label: 'Fields',
    type: 'field-select',
    required: false,
    description: 'Fields to include in each object in the array',
  },
];

export function register(parentTypeIds: { object: string }): void {
  nodeTypeRegistry.register({
    id: WEBHOOK_ARRAY_NODE_TYPE,
    adapter: PipelineOutputType.WEBHOOK,
    label: 'Array',
    description: 'A JSON array - use granularity to iterate over companies or founders',
    icon: 'list',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [parentTypeIds.object], // Arrays must be inside objects
    allowedChildTypes: [parentTypeIds.object], // Arrays contain objects (which have fields)
    configSchema: arrayConfigSchema,
    fieldDefinitions,
  });
}
