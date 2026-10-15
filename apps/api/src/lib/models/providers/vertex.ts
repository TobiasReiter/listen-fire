// Claude on Google Cloud, passed through: the Vertex SDK serves the same
// messages surface as Anthropic's own, minus endpoints the seam never asks for.

import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

import type { ChatProvider } from '../chat';

import { googleAuth, googleModelRegion, googleServiceAccount } from 'movement-engine/lib/google_cloud';

let client: AnthropicVertex | undefined;

export function vertexChatProvider(env: NodeJS.ProcessEnv = process.env): ChatProvider {
  return (client ??= new AnthropicVertex({
    projectId: googleServiceAccount(env).projectId,
    region: googleModelRegion(env),
    googleAuth: googleAuth(env),
  }));
}
