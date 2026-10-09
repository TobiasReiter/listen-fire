import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import {
  nodeTypeRegistry,
  createNodeTypeId,
  FieldDefinition,
} from '../../pipeline/outbound/nodeTypes';
import { durationSchema } from '../../pipeline/outbound/configSchema';
import { fieldConfigurationSchema } from './shared';

export const AFFINITY_LIST_ENTRY_NODE_TYPE = createNodeTypeId('affinity', 'list-entry');

const configSchema = z.object({
  listId: z.number(),
  listName: z.string().optional(),
  deduplicationWindow: durationSchema.optional(),
  fieldConfigurations: z.array(fieldConfigurationSchema).optional(),
});

export type AffinityListEntryConfig = z.infer<typeof configSchema>;

const fieldDefinitions: FieldDefinition[] = [
  {
    key: 'listId',
    label: 'List',
    type: 'list-select',
    required: true,
  },
  {
    key: 'deduplicationWindow',
    label: 'Deduplication Window',
    type: 'duration',
    required: false,
  },
  {
    key: 'fieldConfigurations',
    label: 'Field Mappings',
    type: 'field-select',
    required: false,
    fetchFieldsFrom: 'self',
    isPrompt: true,
  },
];

export function register(childTypeIds: { note: string }): void {
  nodeTypeRegistry.register({
    id: AFFINITY_LIST_ENTRY_NODE_TYPE,
    adapter: PipelineOutputType.AFFINITY,
    label: 'List Entry',
    description: 'Add an entry to an Affinity list',
    icon: 'list',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [
      createNodeTypeId('affinity', 'organization'),
      createNodeTypeId('affinity', 'person'),
    ],
    allowedChildTypes: [childTypeIds.note],
    configSchema,
    fieldDefinitions,
  });
}
