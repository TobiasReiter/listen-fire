import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import {
  nodeTypeRegistry,
  createNodeTypeId,
  FieldDefinition,
} from '../../pipeline/outbound/nodeTypes';

export const AFFINITY_NOTE_NODE_TYPE = createNodeTypeId('affinity', 'note');

const configSchema = z.object({
  prompt: z.string(),
});

export type AffinityNoteConfig = z.infer<typeof configSchema>;

const fieldDefinitions: FieldDefinition[] = [
  {
    key: 'prompt',
    label: 'Note Prompt',
    type: 'textarea',
    required: true,
    placeholder: 'Summarize the key information from the input...',
    isPrompt: true,
  },
];

export function register(): void {
  nodeTypeRegistry.register({
    id: AFFINITY_NOTE_NODE_TYPE,
    adapter: PipelineOutputType.AFFINITY,
    label: 'Note',
    description: 'Add a note to an organization, person, or list entry',
    icon: 'note',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [
      createNodeTypeId('affinity', 'organization'),
      createNodeTypeId('affinity', 'person'),
      createNodeTypeId('affinity', 'list-entry'),
    ],
    allowedChildTypes: [],
    configSchema,
    fieldDefinitions,
  });
}
