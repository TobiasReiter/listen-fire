// The models the platform lends a built-in module (routed by this
// deployment's model map, metered and billed to the run like the platform's
// own calls). A module asks through `ctx.models`; nothing here names one.
// Its files are `platformModuleFiles` (engine/files/module_files).

import type { ModuleModels } from 'module-kit';

import { anthropicChat, anthropicChatStructured } from '../../../lib/anthropic';

export const hostedModels: ModuleModels = {
  chat: (input) => anthropicChat(input),
  chatStructured: (input) => anthropicChatStructured(input),
};
