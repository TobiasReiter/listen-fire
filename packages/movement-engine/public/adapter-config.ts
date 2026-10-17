// How an adapter's configuration is declared and validated: the config blocks
// a trigger or an install form is built from (and the zod schema derived from
// them), and the webhook adapter's output config.

export * from '../services/translation_graph/triggerConfig';
export * from '../adapters/webhook/configSchema';
