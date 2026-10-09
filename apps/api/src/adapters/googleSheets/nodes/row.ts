import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import {
  nodeTypeRegistry,
  createNodeTypeId,
  FieldDefinition,
} from '../../pipeline/outbound/nodeTypes';

export const GOOGLE_SHEETS_ROW_NODE_TYPE = createNodeTypeId('sheets', 'row');

const fieldConfigurationSchema = z.object({
  header: z.string(),
  prompt: z.string(),
});

export type GoogleSheetsFieldConfiguration = z.infer<typeof fieldConfigurationSchema>;

export const configSchema = z.object({
  spreadsheetId: z.string(),
  spreadsheetName: z.string().optional(),
  sheetId: z.number(),
  sheetName: z.string().optional(),
  fieldConfigurations: z.array(fieldConfigurationSchema),
});

export type GoogleSheetsRowConfig = z.infer<typeof configSchema>;

const fieldDefinitions: FieldDefinition[] = [
  {
    key: 'spreadsheetId',
    label: 'Spreadsheet',
    type: 'spreadsheet-select',
    required: true,
  },
  {
    key: 'sheetId',
    label: 'Sheet',
    type: 'sheet-select',
    required: true,
  },
  {
    key: 'fieldConfigurations',
    label: 'Column Mappings',
    type: 'sheet-field-select',
    required: true,
    isPrompt: true,
  },
];

export function register(): void {
  nodeTypeRegistry.register({
    id: GOOGLE_SHEETS_ROW_NODE_TYPE,
    adapter: PipelineOutputType.GOOGLE_SHEETS,
    label: 'Row',
    description: 'Add a row to a Google Sheets spreadsheet',
    icon: 'table',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [null],
    allowedChildTypes: [],
    configSchema,
    fieldDefinitions,
  });
}
