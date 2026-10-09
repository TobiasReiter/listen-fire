import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import {
  nodeTypeRegistry,
  createNodeTypeId,
  FieldDefinition,
} from '../../pipeline/outbound/nodeTypes';
import { fieldConfigurationSchema } from './shared';

export const AFFINITY_PERSON_NODE_TYPE = createNodeTypeId('affinity', 'person');

const configSchema = z.object({
  fieldConfigurations: z.array(fieldConfigurationSchema),
});

export type AffinityPersonConfig = z.infer<typeof configSchema>;

const fieldDefinitions: FieldDefinition[] = [
  {
    key: 'firstName',
    label: 'First Name',
    type: 'property-mapping',
    required: false,
    description: 'Maps to the built-in first_name field',
  },
  {
    key: 'lastName',
    label: 'Last Name',
    type: 'property-mapping',
    required: false,
    description: 'Maps to the built-in last_name field',
  },
  {
    key: 'name',
    label: 'Full Name',
    type: 'property-mapping',
    required: false,
    description: 'Alternative to first/last — maps to both name fields',
  },
  {
    key: 'email',
    label: 'Email',
    type: 'property-mapping',
    required: false,
    description: 'Maps to the built-in emails field',
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

export function register(childTypeIds: { listEntry: string; note: string; preview: string }): void {
  nodeTypeRegistry.register({
    id: AFFINITY_PERSON_NODE_TYPE,
    adapter: PipelineOutputType.AFFINITY,
    label: 'Person',
    description: 'Create or update an Affinity person (e.g., team member)',
    icon: 'person',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [null],
    allowedChildTypes: [childTypeIds.listEntry, childTypeIds.note, childTypeIds.preview],
    configSchema,
    fieldDefinitions,
  });
}
