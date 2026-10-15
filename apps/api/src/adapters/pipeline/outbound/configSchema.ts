import { z } from 'zod';

import { safeParseConfig } from '../../../lib/safe-config-parse';
import { nodeTypeRegistry } from './nodeTypes';
import {
  webhookGraphOutputConfigSchema,
  webhookGraphOutputConfigInputSchema,
  type WebhookGraphOutputConfig,
} from 'movement-engine/adapters/webhook/configSchema';
import {
  outputV3ConfigSchema,
  type OutputV3Config,
} from 'movement-engine/services/knowledge_pipeline/output_v3/schemas';

// Re-export config types for convenience
export { webhookGraphOutputConfigSchema, webhookGraphOutputConfigInputSchema };
export { outputV3ConfigSchema };
export type { WebhookGraphOutputConfig, OutputV3Config };

/************************************************************
 * Utility
 ************************************************************/

// Granularity levels for output nodes (legacy dealflow path)
// per-message: One output per user message (coarsest)
// per-company: One output per unique company in the message
// per-founder: One output per founder of each company (finest)
// iterate: Knowledge graph iteration — traverse an edge type from the current context node
export const granularitySchema = z.enum(['per-message', 'per-company', 'per-founder', 'iterate']);
export type Granularity = z.infer<typeof granularitySchema>;

// Granularity hierarchy (index = level, lower = coarser)
// 'iterate' has no fixed level — it self-describes its expansion via iterateConfig
export const GRANULARITY_LEVELS: Record<Granularity, number> = {
  'per-message': 0,
  'per-company': 1,
  'per-founder': 2,
  'iterate': 3,
};

// Walk config — knowledge-native replacement for granularity + iterateConfig.
// Root nodes omit walkConfig (execute once per trigger).
// Child nodes specify an edge type + direction to fan out per connected entity.
export const walkConfigSchema = z.object({
  edgeTypeId: z.string(),
  direction: z.enum(['outgoing', 'incoming']),
});
export type WalkConfig = z.infer<typeof walkConfigSchema>;

// Duration schema for deduplication windows
export const durationSchema = z.object({
  years: z.number().optional(),
  months: z.number().optional(),
  weeks: z.number().optional(),
  days: z.number().optional(),
  hours: z.number().optional(),
  minutes: z.number().optional(),
  seconds: z.number().optional(),
});
export type Duration = z.infer<typeof durationSchema>;

/************************************************************
 * Output Node Schemas
 ************************************************************/

// Relationship between parent and child nodes
export const nodeRelationshipSchema = z.object({
  parentField: z.string().optional(), // Field on parent that references child
  childField: z.string().optional(), // Field on child that references parent
  type: z.enum(['reference', 'embed', 'attachment']),
});
export type NodeRelationship = z.infer<typeof nodeRelationshipSchema>;

// Knowledge iteration config — when granularity === 'iterate', specifies which edge type to traverse
export const iterateConfigSchema = z.object({
  edgeTypeId: z.string(),
  direction: z.enum(['outgoing', 'incoming']),
});
export type IterateConfig = z.infer<typeof iterateConfigSchema>;

export interface OutputNode {
  id: string;
  type: string;
  granularity: Granularity;
  condition?: string;
  config: Record<string, unknown>;
  iterateConfig?: IterateConfig;
  walkConfig?: WalkConfig;
  children: {
    node: OutputNode;
    relationship: NodeRelationship;
  }[];
}

export const outputNodeSchema: z.ZodType<OutputNode> = z.object({
  id: z.uuid(),
  type: z.string(),
  granularity: granularitySchema,
  condition: z.string().optional(),
  config: z.record(z.string(), z.unknown()),
  iterateConfig: iterateConfigSchema.optional(),
  walkConfig: walkConfigSchema.optional(),
  children: z.array(
    z.object({
      node: z.lazy((): z.ZodType<OutputNode> => outputNodeSchema),
      relationship: nodeRelationshipSchema,
    }),
  ),
});

/************************************************************
 * Config Parsing
 ************************************************************/

// V2 graph-based configuration
export const outputGraphConfigSchema = z.object({
  version: z.literal(2),
  roots: z.array(outputNodeSchema), // Multiple DAG roots allowed
  // Webhook-specific configuration (URL, auth, headers)
  webhookConfig: webhookGraphOutputConfigSchema.optional(),
});
export type OutputGraphConfig = z.infer<typeof outputGraphConfigSchema>;

// V2 graph-based configuration for input (allows empty/invalid webhook URL)
export const outputGraphConfigInputSchema = z.object({
  version: z.literal(2),
  roots: z.array(outputNodeSchema),
  webhookConfig: webhookGraphOutputConfigInputSchema.optional(),
});

// V1 legacy configuration (existing modal-based configs)
// Actual parsing is done by adapter-specific parsers (hence loose)
export const outputLegacyConfigSchema = z.looseObject({
  version: z.literal(1).optional(), // Optional for backwards compatibility
});
export type OutputLegacyConfig = z.infer<typeof outputLegacyConfigSchema>;

// Parse config based on version field in the database row.
//
// Returns a `{ ok: false, error }` shape on invalid input instead of
// throwing — callers in the runtime path (adapter dispatchers, projection
// readers, UI list surfaces) treat invalid configs as "skip / show as invalid"
// rather than failing the whole network call. Delegates to `safeParseConfig`
// for the repo-wide pattern (warn-log + structured failure shape).
export function parseOutputConfig(
  configVersion: number,
  config: unknown,
  context: string = `parseOutputConfig:v${configVersion}`,
):
  | { ok: true; version: 1; config: OutputLegacyConfig }
  | { ok: true; version: 2; config: OutputGraphConfig }
  | { ok: true; version: 3; config: OutputV3Config }
  | { ok: false; version: number; error: string } {
  if (configVersion === 3) {
    const parsed = safeParseConfig(outputV3ConfigSchema, config, context);
    if (!parsed.ok) return { ok: false, version: 3, error: parsed.error };
    return { ok: true, version: 3, config: parsed.config };
  }
  if (configVersion === 2) {
    const parsed = safeParseConfig(outputGraphConfigSchema, config, context);
    if (!parsed.ok) return { ok: false, version: 2, error: parsed.error };
    return { ok: true, version: 2, config: parsed.config };
  }
  // Default to v1 for backwards compatibility — v1 is a loose pass-through.
  return { ok: true, version: 1, config: config as OutputLegacyConfig };
}

/************************************************************
 * Validation
 ************************************************************/

export interface ValidationError {
  nodeId: string;
  message: string;
  type: 'granularity' | 'node-type' | 'config' | 'relationship';
}

// Check if a node type is an array type (can have finer granularity than parent)
function isArrayNodeType(nodeType: string): boolean {
  const [, actionType] = nodeType.split(':');
  return actionType === 'array';
}

// Child must be equal to or finer than parent for arrays,
// but objects must match parent granularity exactly.
// 'iterate' is always valid — it self-describes its expansion via iterateConfig.
export function isValidChildGranularity(
  parentGranularity: Granularity,
  childGranularity: Granularity,
  isArrayChild: boolean,
): boolean {
  if (childGranularity === 'iterate') return true;
  if (parentGranularity === 'iterate') return true;
  if (isArrayChild) {
    // Arrays can have finer granularity (that's their purpose for iteration)
    return GRANULARITY_LEVELS[childGranularity] >= GRANULARITY_LEVELS[parentGranularity];
  }
  // Objects must match parent granularity - finer granularity doesn't make sense
  return childGranularity === parentGranularity;
}

export function validateOutputGraph(config: OutputGraphConfig): ValidationError[] {
  const errors: ValidationError[] = [];

  function validateNode(node: OutputNode, parentNode: OutputNode | null): void {
    const parentGranularity = parentNode?.granularity ?? null;
    const isArray = isArrayNodeType(node.type);

    // If the parent has no array-type children registered, treat all children as arrays
    // (they implicitly iterate over finer granularity)
    const parentDef = parentNode ? nodeTypeRegistry.get(parentNode.type) : undefined;
    const parentHasArrayChildren = parentDef?.allowedChildTypes.some(
      (childType) => childType.endsWith(':array'),
    ) ?? false;
    const treatAsArray = isArray || !parentHasArrayChildren;

    // Check granularity constraint
    if (
      parentGranularity &&
      !isValidChildGranularity(parentGranularity, node.granularity, treatAsArray)
    ) {
      if (treatAsArray) {
        errors.push({
          nodeId: node.id,
          message: `Granularity "${node.granularity}" is coarser than parent "${parentGranularity}"`,
          type: 'granularity',
        });
      } else {
        errors.push({
          nodeId: node.id,
          message: `Object granularity "${node.granularity}" must match parent "${parentGranularity}" (use an array for iteration)`,
          type: 'granularity',
        });
      }
    }

    // 'iterate' nodes must have iterateConfig
    if (node.granularity === 'iterate' && !node.iterateConfig) {
      errors.push({
        nodeId: node.id,
        message: 'Iterate granularity requires iterateConfig (edgeTypeId and direction)',
        type: 'granularity',
      });
    }

    // Validate node config against its type's schema
    const configValidation = nodeTypeRegistry.validateConfig(node.type, node.config);
    if (!configValidation.success) {
      const zodError = configValidation.error;
      for (const issue of zodError.issues) {
        errors.push({
          nodeId: node.id,
          message: `Invalid config at ${issue.path.join('.')}: ${issue.message}`,
          type: 'config',
        });
      }
    }

    // Recursively validate children
    for (const child of node.children) {
      validateNode(child.node, node);
    }
  }

  for (const root of config.roots) {
    validateNode(root, null);
  }

  return errors;
}
