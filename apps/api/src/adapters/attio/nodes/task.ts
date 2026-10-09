import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import {
  nodeTypeRegistry,
  createNodeTypeId,
  FieldDefinition,
} from '../../pipeline/outbound/nodeTypes';

export const ATTIO_TASK_NODE_TYPE = createNodeTypeId('attio', 'task');

const assigneeSchema = z.object({
  workspaceMemberId: z.string(),
  workspaceMemberName: z.string(),
  conditionPrompt: z.string().optional(),
});

export type AttioTaskAssignee = z.infer<typeof assigneeSchema>;

export const taskConfigSchema = z.object({
  contentPrompt: z.string(),
  assignees: z.array(assigneeSchema).optional(),
  deadlineOffsetDays: z.number().optional(),
});

export type AttioTaskConfig = z.infer<typeof taskConfigSchema>;

const fieldDefinitions: FieldDefinition[] = [
  {
    key: 'contentPrompt',
    label: 'Task Content',
    type: 'textarea',
    required: true,
    placeholder: 'Generate a task description based on the input...',
    isPrompt: true,
  },
  {
    key: 'assignees',
    label: 'Assignees',
    type: 'assignee-list',
    required: false,
  },
  {
    key: 'deadlineOffsetDays',
    label: 'Deadline (days from now)',
    type: 'number',
    required: false,
    placeholder: '7',
  },
];

export function register(): void {
  nodeTypeRegistry.register({
    id: ATTIO_TASK_NODE_TYPE,
    adapter: PipelineOutputType.ATTIO,
    label: 'Task',
    description: 'Create a task linked to an object or list entry',
    icon: 'task',
    allowedGranularities: ['per-message', 'per-company', 'per-founder', 'iterate'],
    allowedParentTypes: [
      createNodeTypeId('attio', 'object'),
      createNodeTypeId('attio', 'list-entry'),
    ],
    allowedChildTypes: [],
    configSchema: taskConfigSchema,
    fieldDefinitions,
  });
}
