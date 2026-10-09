import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import {
  nodeTypeRegistry,
  createNodeTypeId,
  FieldDefinition,
} from '../../pipeline/outbound/nodeTypes';
import { durationSchema } from '../../pipeline/outbound/configSchema';
import { fieldConfigurationSchema } from './shared';

export const ATTIO_OBJECT_NODE_TYPE = createNodeTypeId('attio', 'object');

export const objectConfigSchema = z.object({
  objectId: z.string(),
  objectName: z.string().optional(),
  fieldConfigurations: z.array(fieldConfigurationSchema),
  deduplication: z
    .object({
      field: z.string().optional(),
      window: durationSchema.optional(),
    })
    .optional(),
  parentReferenceField: z
    .object({
      fieldId: z.string(),
    })
    .optional(),
});

export type AttioObjectConfig = z.infer<typeof objectConfigSchema>;

const fieldDefinitions: FieldDefinition[] = [
  {
    key: 'objectId',
    label: 'Object Type',
    type: 'object-select',
    required: true,
  },
  {
    key: 'parentReferenceField.fieldId',
    label: 'Parent Reference Field',
    type: 'attribute-select',
    required: false,
    requiredForChildNode: true,
    hideForRootNode: true,
    fetchFieldsFrom: 'self',
    description: 'Field to link this record to its parent record',
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

export function register(childTypeIds: { listEntry: string; note: string; task: string; upload: string }): void {
  nodeTypeRegistry.register({
    id: ATTIO_OBJECT_NODE_TYPE,
    adapter: PipelineOutputType.ATTIO,
    label: 'Object',
    description: 'Create or update an Attio object (Company, Person, or custom)',
    icon: 'apartment',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [null],
    allowedChildTypes: [
      ATTIO_OBJECT_NODE_TYPE,
      childTypeIds.listEntry,
      childTypeIds.note,
      childTypeIds.task,
      childTypeIds.upload,
    ],
    configSchema: objectConfigSchema,
    fieldDefinitions,
  });
}
