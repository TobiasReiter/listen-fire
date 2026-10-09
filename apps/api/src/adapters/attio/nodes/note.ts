import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import {
  nodeTypeRegistry,
  createNodeTypeId,
  FieldDefinition,
} from '../../pipeline/outbound/nodeTypes';

export const ATTIO_NOTE_NODE_TYPE = createNodeTypeId('attio', 'note');

export const noteConfigSchema = z.object({
  titlePrompt: z.string().optional(),
  contentPrompt: z.string().optional(),
  includeFileLinks: z.boolean().optional(),
});

export type AttioNoteConfig = z.infer<typeof noteConfigSchema>;

const fieldDefinitions: FieldDefinition[] = [
  {
    key: 'titlePrompt',
    label: 'Title Prompt',
    type: 'textarea',
    required: false,
    placeholder: 'Generate a short title summarizing the key information...',
    isPrompt: true,
  },
  {
    key: 'contentPrompt',
    label: 'Content Prompt',
    type: 'textarea',
    required: false,
    placeholder: 'Summarize the key details from the input...',
    isPrompt: true,
  },
];

export function register(): void {
  nodeTypeRegistry.register({
    id: ATTIO_NOTE_NODE_TYPE,
    adapter: PipelineOutputType.ATTIO,
    label: 'Note',
    description: 'Add a note to an object or list entry',
    icon: 'note',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [
      createNodeTypeId('attio', 'object'),
      createNodeTypeId('attio', 'list-entry'),
    ],
    allowedChildTypes: [],
    configSchema: noteConfigSchema,
    fieldDefinitions,
  });
}
