import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import { FieldDefinition, NodeTypeDefinition } from '../../pipeline/outbound/nodeTypes';
import { SLACK_NODE_TYPES } from './types';

const slackThreadReplyConfigSchema = z.object({
  prompt: z.string().describe('Reply generation prompt'),
});
export type SlackThreadReplyConfig = z.infer<typeof slackThreadReplyConfigSchema>;

const threadReplyFieldDefinitions: FieldDefinition[] = [
  {
    key: 'prompt',
    label: 'Reply Prompt',
    type: 'textarea',
    required: true,
    description: 'Prompt for generating the thread reply',
    placeholder: 'Provide additional details about the company...',
    isPrompt: true,
  },
];

export const replyNode: NodeTypeDefinition = {
  id: SLACK_NODE_TYPES.THREAD_REPLY,
  adapter: PipelineOutputType.SLACK,
  label: 'Thread Reply',
  description: 'Post a reply in the message thread',
  icon: 'reply',
  allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
  allowedParentTypes: [SLACK_NODE_TYPES.MESSAGE, SLACK_NODE_TYPES.THREAD_REPLY],
  allowedChildTypes: [SLACK_NODE_TYPES.THREAD_REPLY, SLACK_NODE_TYPES.ATTACHMENT, SLACK_NODE_TYPES.PREVIEW],
  configSchema: slackThreadReplyConfigSchema,
  fieldDefinitions: threadReplyFieldDefinitions,
};
