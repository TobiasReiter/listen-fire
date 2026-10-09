import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import {
  nodeTypeRegistry,
  createNodeTypeId,
  FieldDefinition,
} from '../../pipeline/outbound/nodeTypes';

export const GOOGLE_SHEETS_TABLE_ROW_NODE_TYPE = createNodeTypeId('sheets', 'table-row');

const columnConfigurationSchema = z.object({
  columnName: z.string(),
  columnIndex: z.number(),
  columnType: z.string().optional(),
  prompt: z.string(),
});

export type GoogleSheetsColumnConfiguration = z.infer<typeof columnConfigurationSchema>;

export const tableRowConfigSchema = z.object({
  spreadsheetId: z.string(),
  spreadsheetName: z.string().optional(),
  tableId: z.string(),
  tableName: z.string().optional(),
  columnConfigurations: z.array(columnConfigurationSchema).optional(),
});

export type GoogleSheetsTableRowConfig = z.infer<typeof tableRowConfigSchema>;

const fieldDefinitions: FieldDefinition[] = [
  {
    key: 'spreadsheetId',
    label: 'Spreadsheet',
    type: 'spreadsheet-select',
    required: true,
  },
  {
    key: 'tableId',
    label: 'Table',
    type: 'table-select',
    required: true,
  },
  {
    key: 'fieldMappings',
    label: 'Field Mappings',
    type: 'field-select',
    required: true,
  },
];

export function register(): void {
  nodeTypeRegistry.register({
    id: GOOGLE_SHEETS_TABLE_ROW_NODE_TYPE,
    adapter: PipelineOutputType.GOOGLE_SHEETS,
    label: 'Table Row',
    description: 'Add a row to a table in Google Sheets',
    icon: 'tableRows',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [null],
    allowedChildTypes: [],
    configSchema: tableRowConfigSchema,
    fieldDefinitions,
  });
}
