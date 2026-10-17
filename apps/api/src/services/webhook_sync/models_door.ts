// The platform's answer at the models door (`answerModels`, the shared doors
// core): a module served as a process, installed by a team, asks for one
// model call, and the platform makes it as it makes a built-in module's
// (routed by this deployment's model map, billed to the team's usage). What
// the call spent comes back as the answer's cost lines, which the module adds
// to the response of the call that asked, so the run that made it is charged.
//
// A schema request is a forced tool call, the module's JSON schema carried as
// the tool's input schema. The module validates the answer against its own
// schema; the platform checks only that it is an object.

import { z } from 'zod';

import { HostModelRefused, type HostModelCall } from 'movement-engine/public/inbound';
import { NO_BUDGET_LIMIT, parseChatModelName, withSpendMeter, type ChatModelName, type CostLine } from 'movement-engine/public/models';

import { anthropicChat, anthropicChatStructured } from '../../lib/anthropic';
import { LlmUsageContext } from '../../lib/llm_usage';

/** A cost line as a module carries it: a model's spend is labelled by its
 *  provider, as lf's door labels it. */
function wireCostLine(line: CostLine): { label: string; microdollars: number } {
  return { label: line.source.startsWith('model:') ? `anthropic/${line.source.slice('model:'.length)}` : line.source, microdollars: line.microdollars };
}

function chatModel(model: string | undefined): ChatModelName | undefined {
  if (model === undefined) return undefined;
  try {
    return parseChatModelName(model, 'the models door request\'s model');
  } catch (error) {
    throw new HostModelRefused(error instanceof Error ? error.message : String(error));
  }
}

export const platformModelCall: HostModelCall = async ({ caller, request }) => {
  const model = chatModel(request.model);
  const schema = request.schema;
  if (schema !== undefined && schema.type !== 'object') {
    throw new HostModelRefused('a schema request needs an object-rooted JSON schema (a forced tool call takes an object)');
  }
  const asked = { system: request.system, userMessage: request.userMessage, label: request.label, ...(model !== undefined ? { model } : {}) };
  const { value, cost } = await new LlmUsageContext({ teamId: caller.teamId }).runAsync(() =>
    withSpendMeter(NO_BUDGET_LIMIT, async () => {
      if (schema === undefined) {
        return { text: await anthropicChat({ ...asked, ...(request.effort !== undefined ? { effort: request.effort } : {}) }) };
      }
      const data = await anthropicChatStructured({
        ...asked,
        schema: z.looseObject({}).meta(schema),
        toolName: request.toolName ?? 'answer',
        toolDescription: request.toolDescription ?? 'The answer, in the shape asked for.',
      });
      return { text: JSON.stringify(data), data };
    }),
  );
  return { ...value, cost: cost.map(wireCostLine) };
};
