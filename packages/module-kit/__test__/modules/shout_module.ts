// A plugin module for the kit's own tests: one plugin, `shout`, that upper-
// cases its text, priced by the length it shouted.

import type { PluginDeclaration } from 'movement-engine/public/plugins';

import { defineModule } from '../../define';

export const SHOUT: PluginDeclaration = {
  priced: true,
  signature: {
    name: 'shout',
    description: 'Upper-case some text.',
    params: [{ name: 'text', type: { kind: 'string' }, required: true }],
    dataDependency: 'none',
    additions: {},
    effects: {},
    output: { kind: 'value', type: { kind: 'string' } },
  },
};

export default defineModule({
  kind: 'plugin',
  name: '@lf/shout',
  credentials: [],
  plugins: [SHOUT],
  create: () => ({
    invokePlugin: async ({ name, config }) => {
      if (name !== 'shout') throw new Error(`no plugin ${name}`);
      const text = typeof config.text === 'string' ? config.text : '';
      return { text: text.toUpperCase(), costMicrodollars: text.length };
    },
  }),
});
