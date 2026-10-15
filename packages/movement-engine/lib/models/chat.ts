// The seam every chat call crosses: a provider object in Anthropic's own
// request and response types, plus the name to put on its wire.
//
// Typed structurally rather than as either SDK's class, so a translator that is
// not an Anthropic client at all can stand behind it, and so a caller cannot
// wander onto an endpoint (batches, files) that only one vendor has.
//
// Which provider answers a name is the shell's to decide (the hosted product
// routes by its MODEL_MAP and environment; `lf` by its secrets file), so the
// shared client is handed a `ChatCallFor` rather than reading either.

import type Anthropic from '@anthropic-ai/sdk';
import type { Resolved } from './map';
import type { ChatModelName } from './registry';

export type ChatProvider = {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: Anthropic.RequestOptions,
    ): Promise<Anthropic.Message>;
    stream(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: Anthropic.RequestOptions,
    ): { finalMessage(): Promise<Anthropic.Message> };
  };
};

export interface ChatCall {
  client: ChatProvider;
  wireModel: string;
  resolved: Resolved;
}

export type ChatCallFor = (name: ChatModelName) => ChatCall;
