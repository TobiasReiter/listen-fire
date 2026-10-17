// `@acme/words`: a plugin module of one plugin, `initials`. A module is its
// declarations and `create`, which builds its methods over the context the
// host hands it (its credential, fetch, log). This one needs none of them,
// and imports nothing: serve-module knows a module by its shape, so an
// operator's own module needs no package installed beside it.

module.exports = {
  kind: 'plugin',
  name: '@acme/words',
  credentials: [],
  plugins: [
    {
      priced: false,
      signature: {
        name: 'initials',
        description: 'The initials of a name: "Vireo Robotics" is "VR".',
        params: [{ name: 'name', type: { kind: 'string' }, required: true }],
        dataDependency: 'none',
        additions: {},
        effects: {},
        output: { kind: 'value', type: { kind: 'string' } },
      },
    },
  ],
  create: () => ({
    invokePlugin: async ({ config }: { config: Record<string, unknown> }) => {
      const name = typeof config.name === 'string' ? config.name : '';
      const initials = name
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => word[0].toUpperCase())
        .join('');
      return { text: initials };
    },
  }),
};
