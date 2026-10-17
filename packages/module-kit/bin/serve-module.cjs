#!/usr/bin/env node
// Serves a module over adapter protocol 2. Runs the TypeScript sources
// directly, as lf does.
require('tsx/cjs');
require('../serve.ts')
  .main(process.argv.slice(2), process.env)
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
