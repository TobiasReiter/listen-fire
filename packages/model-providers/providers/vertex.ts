// Claude on Google Cloud, passed through: the Vertex SDK serves the same
// messages surface as Anthropic's own, minus endpoints the seam never asks for.

import type { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

import type { ChatProvider } from '../chat';

import { googleAuth, googleModelRegion, googleServiceAccount } from 'movement-engine/public/google-cloud';

let client: AnthropicVertex | undefined;

export function vertexChatProvider(env: NodeJS.ProcessEnv): ChatProvider {
  // Loaded on first use: the Vertex SDK is an optional peer of this package.
  const sdk: typeof import('@anthropic-ai/vertex-sdk') = require('@anthropic-ai/vertex-sdk');
  return (client ??= new sdk.AnthropicVertex({
    projectId: googleServiceAccount(env).projectId,
    region: googleModelRegion(env),
    googleAuth: googleAuth(env),
  }));
}
