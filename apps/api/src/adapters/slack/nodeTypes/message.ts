import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import { FieldDefinition, NodeTypeDefinition } from '../../pipeline/outbound/nodeTypes';
import { SLACK_NODE_TYPES } from './types';

const slackMessageConfigSchema = z.object({
  channelId: z.string(),
  channelName: z.string().optional(),
  prompt: z.string().describe('Prompt for generating the message content'),
});
export type SlackMessageConfig = z.infer<typeof slackMessageConfigSchema>;

const messageFieldDefinitions: FieldDefinition[] = [
  {
    key: 'channelId',
    label: 'Channel',
    type: 'channel-select',
    required: true,
    description: 'The Slack channel to post to',
    expressionCapable: true,
  },
  {
    key: 'prompt',
    label: 'Message Prompt',
    type: 'textarea',
    required: true,
    description: 'Prompt for generating the message content',
    placeholder: `The format must be:

:rotating_light: {{company name}}

- :hammer_and_wrench: {{description}}
- :bust_in_silhouette: {{team summary}}
- :chart_with_upwards_trend: {{traction}}`,
    isPrompt: true,
  },
];

export const messageNode: NodeTypeDefinition = {
  id: SLACK_NODE_TYPES.MESSAGE,
  adapter: PipelineOutputType.SLACK,
  label: 'Message',
  description: 'Post a message to a Slack channel',
  icon: 'chat',
  allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
  allowedParentTypes: [null], // Root only
  allowedChildTypes: [SLACK_NODE_TYPES.THREAD_REPLY, SLACK_NODE_TYPES.ATTACHMENT, SLACK_NODE_TYPES.PREVIEW],
  configSchema: slackMessageConfigSchema,
  fieldDefinitions: messageFieldDefinitions,
};
