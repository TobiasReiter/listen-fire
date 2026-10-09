import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import {
  nodeTypeRegistry,
  createNodeTypeId,
  FieldDefinition,
} from '../../pipeline/outbound/nodeTypes';

export const AFFINITY_FILE_NODE_TYPE = createNodeTypeId('affinity', 'file');

const configSchema = z.object({
  prettyDeckNames: z.boolean().optional(),
  fileTypes: z.array(z.string()).optional(),
});

export type AffinityFileConfig = z.infer<typeof configSchema>;

const fieldDefinitions: FieldDefinition[] = [
  {
    key: 'prettyDeckNames',
    label: 'Pretty Deck Names',
    type: 'boolean',
    required: false,
  },
  {
    key: 'fileTypes',
    label: 'File Types',
    type: 'select',
    required: false,
    options: [
      { label: 'PDF', value: '.pdf' },
      { label: 'PowerPoint', value: '.pptx' },
      { label: 'Word', value: '.docx' },
      { label: 'Excel', value: '.xlsx' },
    ],
  },
];

export function register(): void {
  nodeTypeRegistry.register({
    id: AFFINITY_FILE_NODE_TYPE,
    adapter: PipelineOutputType.AFFINITY,
    label: 'File',
    description: 'Attach files to an organization or person',
    icon: 'attachFile',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [
      createNodeTypeId('affinity', 'organization'),
      createNodeTypeId('affinity', 'person'),
    ],
    allowedChildTypes: [],
    configSchema,
    fieldDefinitions,
  });
}
