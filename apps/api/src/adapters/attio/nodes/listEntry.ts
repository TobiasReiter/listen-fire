import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import {
  nodeTypeRegistry,
  createNodeTypeId,
  FieldDefinition,
} from '../../pipeline/outbound/nodeTypes';
import { durationSchema } from '../../pipeline/outbound/configSchema';
import { fieldConfigurationSchema } from './shared';

export const ATTIO_LIST_ENTRY_NODE_TYPE = createNodeTypeId('attio', 'list-entry');

export const listEntryConfigSchema = z.object({
  listId: z.string(),
  listName: z.string().optional(),
  fieldConfigurations: z.array(fieldConfigurationSchema),
  deduplicationWindow: durationSchema.optional(),
});

export type AttioListEntryConfig = z.infer<typeof listEntryConfigSchema>;

const fieldDefinitions: FieldDefinition[] = [
  {
    key: 'listId',
    label: 'List',
    type: 'list-select',
    required: true,
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

export function register(childTypeIds: { note: string; task: string; upload: string }): void {
  nodeTypeRegistry.register({
    id: ATTIO_LIST_ENTRY_NODE_TYPE,
    adapter: PipelineOutputType.ATTIO,
    label: 'List Entry',
    description: 'Add an entry to an Attio list',
    icon: 'list',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [createNodeTypeId('attio', 'object')],
    allowedChildTypes: [childTypeIds.note, childTypeIds.task, childTypeIds.upload],
    configSchema: listEntryConfigSchema,
    fieldDefinitions,
  });
}
