import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import { FieldDefinition, NodeTypeDefinition } from '../../pipeline/outbound/nodeTypes';
import { SLACK_NODE_TYPES } from './types';

const slackAttachmentConfigSchema = z.object({
  mimeType: z.string().optional().describe('Comma-separated MIME glob patterns (e.g. "application/pdf, image/*")'),
  namePattern: z.string().optional().describe('Regex pattern to match file names'),
});
export type SlackAttachmentConfig = z.infer<typeof slackAttachmentConfigSchema>;

const attachmentFieldDefinitions: FieldDefinition[] = [
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

export const attachmentNode: NodeTypeDefinition = {
  id: SLACK_NODE_TYPES.ATTACHMENT,
  adapter: PipelineOutputType.SLACK,
  label: 'Attachment',
  description: 'Attach files to the message',
  icon: 'attachFile',
  allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
  allowedParentTypes: [SLACK_NODE_TYPES.MESSAGE, SLACK_NODE_TYPES.THREAD_REPLY],
  allowedChildTypes: [],
  configSchema: slackAttachmentConfigSchema,
  fieldDefinitions: attachmentFieldDefinitions,
};
