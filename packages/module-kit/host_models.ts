// The host's models, reached by a module served as a process: one POST per
// call to the host's models door (protocol.ts `HostModelRequest`), which the
// host answers through its models slot. The door bills nothing itself; each
// answer's cost is charged to the call that asked, so it rides that call's
// response `cost` to the run.

import { HostModelAnswer, type HostModelRequestShape } from 'engine-contracts';
import { z } from 'zod';

import type { ModuleChat, ModuleModels, ModuleSpend } from './define';

export interface HostModelsDoor {
  /** `{host}/api/public/adapter/{adapterType}/models`. */
  url: string;
  /** The headers the push doors take (the install's secret). */
  headers: Readonly<Record<string, string>>;
}

export function hostModels(door: HostModelsDoor): (spend: ModuleSpend) => ModuleModels {
  return (spend) => {
    const ask = async (request: HostModelRequestShape) => {
      const response = await fetch(door.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...door.headers },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw new Error(`the host's models door answered ${response.status}: ${await response.text()}`);
      const answer = HostModelAnswer.parse(await response.json());
      for (const line of answer.cost) spend.charge(line);
      return answer;
    };
    const base = (input: ModuleChat): HostModelRequestShape => ({
      label: input.label,
      system: input.system,
      userMessage: input.userMessage,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
    });
    return {
      chat: async (input) => (await ask(base(input))).text,
      chatStructured: async (input) => {
        const answer = await ask({
          ...base(input),
          schema: z.toJSONSchema(input.schema),
          toolName: input.toolName,
          toolDescription: input.toolDescription,
        });
        return input.schema.parse(answer.data);
      },
    };
  };
}
