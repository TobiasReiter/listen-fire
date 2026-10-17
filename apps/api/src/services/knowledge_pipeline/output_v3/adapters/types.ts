import type { NodeId } from '../../../../generated/kysely/knowledge/Node';
import type { NodeRelationship } from '../../../../adapters/pipeline/outbound/configSchema';
import type { OutputExecutionContext } from '../resolve';
import type { FieldMapping } from 'movement-engine/public/output-v3';

// Tier 0 linked object refs

/**
 * Thrown by adapters when a Tier 0 linked object references an external record
 * that no longer exists. The orchestrator catches this, removes the stale link,
 * and retries without it so normal search/create flow takes over.
 */
class StaleLinkedObjectError extends Error {
  constructor(public readonly externalId: string) {
    super(`Linked external record ${externalId} no longer exists`);
    this.name = 'StaleLinkedObjectError';
  }
}

/**
 * Thrown by adapters when an external record has been merged into another.
 * The orchestrator catches this, updates the linked object's external_id
 * to the new ID, and retries with the corrected reference.
 */
class MergedEntityError extends Error {
  constructor(
    public readonly oldExternalId: string,
    public readonly newExternalId: string,
  ) {
    super(`External record ${oldExternalId} has been merged into ${newExternalId}`);
    this.name = 'MergedEntityError';
  }
}

interface LinkedObjectRef {
  externalId: string;
  externalObjectType: string | null;
  data: Record<string, unknown>;
}

// ResourceContext
interface ResourceContext {
  resourceId: string;
  name: string;
  url: string | null;
  type: string; // ResourceType enum: URL, EMAIL, WHATSAPP, FILE, TEXT
  documentObjectUri: string | null;
  documentId: string | null;
  content: string | null; // raw_text.content — full text of the resource
  metadata: Record<string, unknown>;
  payload?: Record<string, unknown>; // inbound_payload.data, loaded when includePayload filter is set
}

interface V3AdapterExecuteInput {
  type: string;
  readOnly?: boolean;
  adapterConfig: Record<string, unknown>;
  fieldValues: Record<string, unknown>;
  fieldMappings: FieldMapping[];
  parentResult: AdapterResult | null;
  relationship: NodeRelationship | null;
  contextNodeId: NodeId;
  context: OutputExecutionContext;
  linkedObjects: LinkedObjectRef[];
  resource: ResourceContext | null;
  afterEmbedValues?: Map<number, string>;
}

interface AdapterResult {
  externalId?: string;
  created?: boolean;
  externalObjectType?: string;
  data?: Record<string, unknown>;
  displayValues?: Record<string, unknown>;
  parentRecord?: { objectId: string; recordId: string };
  parentMessage?: { channelId: string; threadTs: string };
  parentFolder?: { folderId: string };
  parentEntity?: { profileId: string };
  skipped?: boolean;
  skipReason?: string;
}

interface FieldConstraints {
  options?: string[];
  displayName?: string;
}

interface V3Adapter {
  execute(input: V3AdapterExecuteInput): Promise<AdapterResult>;
  getFieldConstraints?(actionNode: { type: string; adapterConfig: Record<string, unknown>; fieldMappings: { targetField: unknown }[] }): Promise<Map<string, FieldConstraints>>;
}

// __expr discriminator
interface ExpressionConfigValue {
  __expr: true;
  expression: import('movement-engine/public/catalog').Expression;
}

function isExpressionConfig(v: unknown): v is ExpressionConfigValue {
  return typeof v === 'object' && v !== null && '__expr' in v && (v as Record<string, unknown>).__expr === true;
}

/**
 * Resolve an adapter config field that may be a static value or an expression.
 * Returns the resolved string value, or undefined if not set.
 */
async function resolveConfigField(
  key: string,
  config: Record<string, unknown>,
  input: V3AdapterExecuteInput,
): Promise<string | undefined> {
  const value = config[key];
  if (typeof value === 'string') return value;
  if (isExpressionConfig(value)) {
    const { evaluateExpression } = await import('../evaluate');
    const result = await evaluateExpression(value.expression, {
      nodeIds: [input.contextNodeId],
      lastEdges: [],
      exec: input.context,
    });
    return typeof result === 'string' ? result : result != null ? String(result) : undefined;
  }
  return undefined;
}

export { isExpressionConfig, resolveConfigField };
export { StaleLinkedObjectError, MergedEntityError };
export type { V3AdapterExecuteInput, AdapterResult, V3Adapter, FieldConstraints, LinkedObjectRef, ResourceContext, ExpressionConfigValue };
