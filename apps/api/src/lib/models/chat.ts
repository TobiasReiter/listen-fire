// The hosted product's answer to which provider serves each chat model name:
// its MODEL_MAP and environment pick the vendor and its credentials. The
// routing lives in packages/model-providers; this binds it to the process.

import type { ChatCall, ChatProvider } from 'movement-engine/lib/models/chat';
import type { ChatModelName } from 'movement-engine/lib/models/registry';

import { chatCallFor as chatCallForEnv } from 'model-providers/chat';
import { hostedEnv } from './host';

export function chatCallFor(name: ChatModelName, env: NodeJS.ProcessEnv = process.env): ChatCall {
  return chatCallForEnv(name, hostedEnv(env));
}

export type { ChatCall, ChatProvider };
