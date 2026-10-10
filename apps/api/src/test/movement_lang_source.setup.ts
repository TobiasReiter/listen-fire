// The engine reads movement-lang through this specifier; it must be the
// TypeScript sources, never a compiled copy (see the tripwire's message).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { assertResolvesToSource } = require('../../../../packages/movement-lang/conformance/source_tripwire.cjs');

assertResolvesToSource('movement-lang', require.resolve('movement-lang'));
assertResolvesToSource('#shared/cron', require.resolve('#shared/cron'));
