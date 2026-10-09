import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import {
  nodeTypeRegistry,
  createNodeTypeId,
  FieldDefinition,
} from '../../pipeline/outbound/nodeTypes';
import { fieldConfigurationSchema } from './shared';

export const AIRTABLE_RECORD_NODE_TYPE = createNodeTypeId('airtable', 'record');

const configSchema = z.object({
  baseId: z.string(),
  baseName: z.string().optional(),
  tableId: z.string(),
  tableName: z.string().optional(),
  fieldConfigurations: z.array(fieldConfigurationSchema),
  linkToParentField: z.string().optional(),
});

export type AirtableRecordConfig = z.infer<typeof configSchema>;

const fieldDefinitions: FieldDefinition[] = [
  {
    key: 'baseId',
    label: 'Base',
    type: 'base-select',
    required: true,
  },
  {
    key: 'tableId',
    label: 'Table',
    type: 'airtable-table-select',
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
  {
    key: 'linkToParentField',
    label: 'Link to Parent Field',
    type: 'airtable-link-field-select',
    required: false,
    hideForRootNode: true,
    requiredForChildNode: true,
  },
];

export function register(): void {
  nodeTypeRegistry.register({
    id: AIRTABLE_RECORD_NODE_TYPE,
    adapter: PipelineOutputType.AIRTABLE,
    label: 'Record',
    description: 'Create a row in an Airtable table',
    icon: 'table',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [null, AIRTABLE_RECORD_NODE_TYPE],
    allowedChildTypes: [AIRTABLE_RECORD_NODE_TYPE],
    configSchema,
    fieldDefinitions,
  });
}
