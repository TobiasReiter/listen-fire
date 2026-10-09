import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import { nodeTypeRegistry, createNodeTypeId, FieldDefinition } from '../../pipeline/outbound/nodeTypes';

export const DROPBOX_DOCUMENT_NODE_TYPE = createNodeTypeId('dropbox', 'document');

export const documentConfigSchema = z.object({
  titlePrompt: z.string().optional(),
  contentPrompt: z.string(),
});

export type DropboxDocumentConfig = z.infer<typeof documentConfigSchema>;

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
    id: DROPBOX_DOCUMENT_NODE_TYPE,
    adapter: PipelineOutputType.DROPBOX,
    label: 'Document',
    description: 'Create a text document with LLM-generated content in Dropbox',
    icon: 'description',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [createNodeTypeId('dropbox', 'folder')],
    allowedChildTypes: [],
    configSchema: documentConfigSchema,
    fieldDefinitions,
  });
}
