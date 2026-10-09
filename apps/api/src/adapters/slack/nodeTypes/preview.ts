import { z } from 'zod';

import type { FieldDefinition, NodeTypeDefinition } from '../../pipeline/outbound/nodeTypes';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import { SLACK_NODE_TYPES } from './types';

const slackPreviewConfigSchema = z.object({
  channelId: z.string().optional(),
  channelName: z.string().optional(),
});
export type SlackPreviewConfig = z.infer<typeof slackPreviewConfigSchema>;

const previewFieldDefinitions: FieldDefinition[] = [
  {
    key: 'channelId',
    label: 'Channel',
    type: 'channel-select',
    required: true,
    description: 'The Slack channel to post to',
    hideForChildNode: true,
    expressionCapable: true,
  },
];

export const previewNode: NodeTypeDefinition = {
  id: SLACK_NODE_TYPES.PREVIEW,
  adapter: PipelineOutputType.SLACK,
  label: 'Preview',
  description: 'Post a rich preview of a resource (email, document, etc.)',
  icon: 'preview',
  allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
  allowedParentTypes: [null, SLACK_NODE_TYPES.MESSAGE, SLACK_NODE_TYPES.THREAD_REPLY],
  allowedChildTypes: [SLACK_NODE_TYPES.THREAD_REPLY, SLACK_NODE_TYPES.ATTACHMENT],
  configSchema: slackPreviewConfigSchema,
  fieldDefinitions: previewFieldDefinitions,
};
