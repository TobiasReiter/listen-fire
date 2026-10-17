// `@lf/web` over tools that replay the platform's recording: each invocation
// finds its recorded case by plugin and arguments, runs the real plugin body
// on the recorded answers, and fails if the body asked anything the recording
// does not hold next or left a recorded ask unmade. Served by serve-module in
// the process parity test; loaded in process by the in-process one.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PluginModuleDefinition } from 'module-kit';

import { defineModule } from 'module-kit';
import { webModuleWith } from '../../index';
import { replayingTools, type RecordedInvocation } from '../replay_tools';

const FIXTURE = join(__dirname, '../__fixtures__/web_tools_parity.json');

function recordedCases(): RecordedInvocation[] {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as RecordedInvocation[];
}

export const replayWebModule: PluginModuleDefinition = defineModule({
  ...webModuleWith(() => {
    throw new Error('replay: tools are built per invocation');
  }),
  create: (ctx) => ({
    async invokePlugin(input) {
      const recorded = recordedCases().find(
        (c) =>
          c.plugin === input.name &&
          JSON.stringify(c.config) === JSON.stringify(input.config) &&
          JSON.stringify(c.extractedContext) === JSON.stringify(input.extractedContext),
      );
      if (recorded === undefined) throw new Error(`replay: no recorded case for ${input.name}`);
      const tools = replayingTools(recorded.tools, ctx.log);
      const saved = { ...process.env };
      Object.assign(process.env, recorded.env ?? {});
      try {
        const answer = await webModuleWith(() => tools).create(ctx).invokePlugin(input);
        tools.done();
        return answer;
      } finally {
        process.env = saved;
      }
    },
  }),
});

export default replayWebModule;
