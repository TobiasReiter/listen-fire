import { z } from 'zod';

// Extracted from ./graphOutput.ts to break a circular import.
// graphOutput.ts needed types from ../pipeline/outbound/configSchema.ts,
// which in turn needed these schemas — that round-trip left
// webhookGraphOutputConfigSchema undefined at the moment configSchema.ts
// tried to call `.optional()` on it during module init, throwing
// "Cannot access 'webhookGraphOutputConfigSchema' before initialization"
// the first time the Translation agent was loaded.
//
// These schemas don't depend on anything in either of those files, so
// they live here and both sides import from this leaf module.

export const webhookAuthConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), token: z.string() }),
  z.object({ type: z.literal('basic'), username: z.string(), password: z.string() }),
  z.object({ type: z.literal('api_key'), headerName: z.string(), apiKey: z.string() }),
]);
export type WebhookAuthConfig = z.infer<typeof webhookAuthConfigSchema>;

// Graph-based webhook config stored at output level
export const webhookGraphOutputConfigSchema = z.object({
  url: z.string().url(),
  method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
  headers: z.record(z.string(), z.string()).optional(),
  auth: webhookAuthConfigSchema.optional(),
});
export type WebhookGraphOutputConfig = z.infer<typeof webhookGraphOutputConfigSchema>;

// Partial schema for initial creation — allows empty/invalid URL
export const webhookGraphOutputConfigInputSchema = z.object({
  url: z.string().default(''),
  method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
  headers: z.record(z.string(), z.string()).optional(),
  auth: webhookAuthConfigSchema.optional(),
});
