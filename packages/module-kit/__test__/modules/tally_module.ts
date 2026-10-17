// A plugin module for the kit's serve-module tests: `tally` counts its calls
// in the install's kv and answers the count, every key it holds, and the
// install's construction arguments.

import type { PluginDeclaration } from 'movement-engine/public/plugins';

import { defineModule } from '../../define';

export const TALLY: PluginDeclaration = {
  priced: false,
  signature: {
    name: 'tally',
    description: 'Count the calls made so far.',
    params: [],
    dataDependency: 'none',
    additions: {},
    effects: {},
    output: { kind: 'value', type: { kind: 'number' } },
  },
};

export default defineModule({
  kind: 'plugin',
  name: '@lf/tally',
  credentials: [],
  plugins: [TALLY],
  create: (ctx) => ({
    invokePlugin: async ({ name }) => {
      if (name !== 'tally') throw new Error(`no plugin ${name}`);
      const before = await ctx.kv.get('count');
      const count = (typeof before === 'number' ? before : 0) + 1;
      await ctx.kv.set('count', count);
      return { data: { count, keys: (await ctx.kv.list('')).map((entry) => entry.key), args: ctx.config.constructionArgs } };
    },
  }),
});
