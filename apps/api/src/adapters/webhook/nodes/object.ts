import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import {
  nodeTypeRegistry,
  createNodeTypeId,
  FieldDefinition,
} from '../../pipeline/outbound/nodeTypes';

export const WEBHOOK_OBJECT_NODE_TYPE = createNodeTypeId('webhook', 'object');

// Schema for inline fields on an object
export const objectFieldSchema = z.object({
  key: z.string().min(1),
  prompt: z.string(), // Optional for 'documents' type since it doesn't need a prompt
  type: z.enum(['string', 'number', 'boolean', 'json', 'documents']).default('string'),
});

export type ObjectField = z.infer<typeof objectFieldSchema>;

export const objectConfigSchema = z.object({
  key: z.string().optional(), // Optional for root object, required for nested
  fields: z.array(objectFieldSchema).default([]), // Inline fields for this object
});

export type WebhookObjectConfig = z.infer<typeof objectConfigSchema>;

const fieldDefinitions: FieldDefinition[] = [
  {
    key: 'key',
    label: 'Key',
    type: 'text',
    required: false,
    hideForRootNode: true,
    requiredForChildNode: true,
    description: 'The key name for this object in the parent (e.g., "company", "metadata")',
    placeholder: 'e.g., company',
  },
  {
    key: 'fields',
    label: 'Fields',
    type: 'field-select',
    required: false,
    description: 'Fields to include in this object',
  },
];

export function register(childTypeIds: { object: string; array: string }): void {
  nodeTypeRegistry.register({
    id: WEBHOOK_OBJECT_NODE_TYPE,
    adapter: PipelineOutputType.WEBHOOK,
    label: 'Object',
    description: 'A JSON object that contains fields, nested objects, or arrays',
    icon: 'dataLossPrevention',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [null, WEBHOOK_OBJECT_NODE_TYPE, childTypeIds.array],
    allowedChildTypes: [WEBHOOK_OBJECT_NODE_TYPE, childTypeIds.array],
    configSchema: objectConfigSchema,
    fieldDefinitions,
  });
}
