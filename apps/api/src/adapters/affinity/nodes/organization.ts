import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import {
  nodeTypeRegistry,
  createNodeTypeId,
  FieldDefinition,
} from '../../pipeline/outbound/nodeTypes';
import { fieldConfigurationSchema } from './shared';

export const AFFINITY_ORGANIZATION_NODE_TYPE = createNodeTypeId('affinity', 'organization');

const configSchema = z.object({
  fieldConfigurations: z.array(fieldConfigurationSchema),
});

export type AffinityOrganizationConfig = z.infer<typeof configSchema>;

const fieldDefinitions: FieldDefinition[] = [
  {
    key: 'name',
    label: 'Organization Name',
    type: 'property-mapping',
    required: true,
    description: 'Maps to the built-in name field',
    expressionCapable: true,
  },
  {
    key: 'domain',
    label: 'Domain',
    type: 'property-mapping',
    required: false,
    description: 'Maps to the built-in domain field',
    expressionCapable: true,
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

export function register(childTypeIds: {
  person: string;
  listEntry: string;
  note: string;
  file: string;
  preview: string;
}): void {
  nodeTypeRegistry.register({
    id: AFFINITY_ORGANIZATION_NODE_TYPE,
    adapter: PipelineOutputType.AFFINITY,
    label: 'Organization',
    description: 'Create or update an Affinity organization',
    icon: 'business',
    allowedGranularities: ['per-message', 'per-company', 'iterate'],
    allowedParentTypes: [null],
    allowedChildTypes: [
      childTypeIds.person,
      childTypeIds.listEntry,
      childTypeIds.note,
      childTypeIds.file,
      childTypeIds.preview,
    ],
    configSchema,
    fieldDefinitions,
  });
}
