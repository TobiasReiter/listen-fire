import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import {
  nodeTypeRegistry,
  createNodeTypeId,
  FieldDefinition,
} from '../../pipeline/outbound/nodeTypes';

export const AIRTABLE_ATTACHMENT_NODE_TYPE = createNodeTypeId('airtable', 'attachment');

const configSchema = z.object({
  mimeType: z.string().optional().describe('Comma-separated MIME glob patterns (e.g. "application/pdf, image/*")'),
  namePattern: z.string().optional().describe('Regex pattern to match file names'),
});

export type AirtableAttachmentConfig = z.infer<typeof configSchema>;

const fieldDefinitions: FieldDefinition[] = [
  {
    key: 'mimeType',
    label: 'MIME Filter',
    type: 'text',
    required: false,
    description: 'Comma-separated MIME types or globs to include',
    placeholder: 'e.g. application/pdf, image/*',
  },
  {
    key: 'namePattern',
    label: 'Name Filter',
    type: 'text',
    required: false,
    description: 'Regex pattern to match file names',
    placeholder: 'e.g. \\.pdf$',
  },
];

export function register(): void {
  nodeTypeRegistry.register({
    id: AIRTABLE_ATTACHMENT_NODE_TYPE,
    adapter: PipelineOutputType.AIRTABLE,
    label: 'Attachment',
    description: 'Add files to an attachment field',
    icon: 'attachFile',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [createNodeTypeId('airtable', 'record')],
    allowedChildTypes: [],
    configSchema,
    fieldDefinitions,
  });
}
