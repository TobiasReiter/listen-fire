import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import {
  nodeTypeRegistry,
  createNodeTypeId,
  FieldDefinition,
} from '../../pipeline/outbound/nodeTypes';

export const GDRIVE_DOCUMENT_NODE_TYPE = createNodeTypeId('gdrive', 'document');

export const documentConfigSchema = z.object({
  titlePrompt: z.string().optional(),
  contentPrompt: z.string(),
});

export type GDriveDocumentConfig = z.infer<typeof documentConfigSchema>;

const fieldDefinitions: FieldDefinition[] = [
  {
    key: 'titlePrompt',
    label: 'Title Prompt',
    type: 'textarea',
    required: false,
    placeholder: 'Generate a short title for this document...',
    isPrompt: true,
  },
  {
    key: 'contentPrompt',
    label: 'Content Prompt',
    type: 'textarea',
    required: true,
    placeholder: 'Write a detailed memo covering...',
    isPrompt: true,
  },
];

export function register(): void {
  nodeTypeRegistry.register({
    id: GDRIVE_DOCUMENT_NODE_TYPE,
    adapter: PipelineOutputType.GOOGLE_DRIVE,
    label: 'Document',
    description: 'Create a Google Doc with LLM-generated content',
    icon: 'description',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [createNodeTypeId('gdrive', 'folder')],
    allowedChildTypes: [],
    configSchema: documentConfigSchema,
    fieldDefinitions,
  });
}
