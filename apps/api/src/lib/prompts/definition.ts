import { ChatCompletionMessageParam } from 'openai/resources';
import { z } from 'zod';

import type { ChatModelName } from 'movement-engine/public/models';

type PromptDefinition<T extends readonly string[], V extends z.ZodType> = {
  description: string;
  arguments: T;
  messages: readonly ChatCompletionMessageParam[];
  validator?: V;
  fallback?: unknown;
  model?: ChatModelName;
  response?: z.ZodTypeAny;
  requestId?: string;
  temperature?: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DefinitionArgs<Tuple extends readonly [...any[]]> = {
  [Index in keyof Tuple & number as Tuple[Index]]: string;
};

// this allows us to use "as const" for the keys while simplifying the values
function promptDef<T extends readonly string[], V extends z.ZodType>(
  definition: PromptDefinition<T, V>,
): PromptDefinition<T, V> {
  return definition;
}

export { promptDef, PromptDefinition, DefinitionArgs };
