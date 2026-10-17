// Output agent runner

import { z } from 'zod';

import type { AgentUpdate } from '../openai/types';
import type { OntologySummary, AgentContext, AdapterMetadataProvider } from '../../services/knowledge_pipeline/output_v3/agent';
import type { OutputV3Config, ActionNode, TreeNode } from 'movement-engine/public/output-v3';
import type { PropertyInfo, EdgeInfo } from '#shared/expression/formula';

import { anthropicToolLoop, type TurnEvent } from '../anthropic';
import { AgentResponseSchema } from '../openai/db_agent_schema';
import { getAutomationsQb, getKnowledgeQb, getQb } from '../kysely';
import { mq } from '../message_queue';
import { AgentToolSession, OUTPUT_AGENT_SYSTEM_PROMPT } from '../../services/knowledge_pipeline/output_v3/agent';
import { TeamId } from '../../generated/kysely/core/Team';
import { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';
import { PipelineOutputId } from '../../generated/kysely/public/PipelineOutput';
import { PipelineConfigurationId } from '../../generated/kysely/public/PipelineConfiguration';
import PipelineOutputType from '../../generated/kysely/public/PipelineOutputType';
import { decryptToken } from '../credentials';
import { attioCredsParser, getAttioClient } from '../../adapters/attio/apiClient';
import { affinityCredsParser, getAffinityClient, valueType as affinityValueType } from '@listen-fire/affinity/api_client';
import { slackCredsParser, getSlackClient } from '../../adapters/slack/webApi/apiClient';
import { SlackWebApiConfigurer } from '../../adapters/slack/webApi/configurer';
import { airtableCredsParser, getAirtableClient } from '../../adapters/airtable/apiClient';
import { writeExpression, type ExpressionWriterContext } from '../../services/knowledge_pipeline/output_v3/expression_writer';
import { logger } from 'movement-engine/public/log';
import { getStyleBlock } from './style_preferences';

interface OutputAgentOptions {
  sessionId?: string;
  teamId: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  currentConfig: OutputV3Config | null;
  adapterType: string;
  credentialsId: string | null;
  /** Extra tool definitions injected by the orchestrator (e.g., handoff tools) */
  additionalToolDefs?: any[];
  /** Extra tool implementations injected by the orchestrator */
  additionalToolImpls?: Record<string, (args: any) => Promise<any>>;
}

async function loadOntology(teamId: string): Promise<OntologySummary> {
  const [nodeTypes, edgeTypes, propertyTypes] = await Promise.all([
    getKnowledgeQb(['node_type'])
      .selectFrom('node_type')
      .where('team_id', '=', teamId as TeamId)
      .select(['id', 'name', 'description', 'category'])
      .orderBy('name asc')
      .execute(),
    getKnowledgeQb(['edge_type'])
      .selectFrom('edge_type')
      .where('team_id', '=', teamId as TeamId)
      .select([
        'id', 'outbound_name', 'inbound_name', 'description',
        'source_node_type_id', 'target_node_type_id',
        'required', 'scopes', 'edge_group',
      ])
      .orderBy('outbound_name asc')
      .execute(),
    getKnowledgeQb(['property_type'])
      .selectFrom('property_type')
      .where('team_id', '=', teamId as TeamId)
      .select([
        'id', 'node_type_id', 'edge_type_id', 'name', 'description',
        'value_type', 'identity', 'evaluation_strategy', 'enum_values',
      ])
      .orderBy('name asc')
      .execute(),
  ]);

  return { nodeTypes, edgeTypes, propertyTypes };
}

// Resolve credentials from DB and build an adapter-specific metadata provider
async function buildAdapterMetadata(adapterType: string): Promise<AdapterMetadataProvider> {
  return {
    async getObjects(credentialsId: string) {
      if (adapterType === 'ATTIO') {
        const client = await getAttioClientFromCreds(credentialsId);
        if (!client) return [];
        const objects = await client.listObjects();
        return objects.map((o) => ({ id: o.id, name: o.name, apiSlug: o.slug ?? undefined }));
      }
      if (adapterType === 'AFFINITY') {
        return [
          { id: 'organization', name: 'Organization' },
          { id: 'person', name: 'Person' },
        ];
      }
      if (adapterType === 'AIRTABLE') {
        // For Airtable, "objects" are bases
        const client = await getAirtableClientFromCreds(credentialsId);
        if (!client) return [];
        const bases = await client.listBases();
        return bases.map((b) => ({ id: b.id, name: b.name }));
      }
      return [];
    },

    async getAttributes(credentialsId: string, objectId: string) {
      if (adapterType === 'ATTIO') {
        const client = await getAttioClientFromCreds(credentialsId);
        if (!client) return [];
        const attributes = await client.listAttributes({ objectId });
        return attributes.map((a) => ({
          id: a.id,
          name: a.name,
          apiSlug: a.apiSlug,
          type: a.type,
          isRequired: a.isRequired,
          isUnique: a.isUnique,
        }));
      }
      if (adapterType === 'AFFINITY') {
        const client = await getAffinityClientFromCreds(credentialsId);
        if (!client) return [];
        const entityType = objectId === 'person' ? 'PERSON' : 'ORGANIZATION';
        const fields = await client.getFields({ type: entityType as 'PERSON' | 'ORGANIZATION' });
        return fields.map((f) => ({
          id: String(f.id),
          name: f.name,
          type: affinityFieldTypeName(f.value_type),
          isRequired: false,
          isUnique: false,
        }));
      }
      if (adapterType === 'AIRTABLE') {
        // objectId is "baseId:tableId" — list fields on that table
        const [baseId, tableId] = objectId.split(':');
        if (!baseId || !tableId) return [];
        const client = await getAirtableClientFromCreds(credentialsId);
        if (!client) return [];
        const tables = await client.listTables({ baseId });
        const table = tables.find((t) => t.id === tableId);
        if (!table) return [];
        return table.fields.map((f) => ({
          id: f.id,
          name: f.name,
          type: f.type ?? 'unknown',
          isRequired: false,
          isUnique: false,
        }));
      }
      return [];
    },

    async getAttributeOptions(credentialsId: string, objectId: string, attributeId: string) {
      if (adapterType === 'ATTIO') {
        const client = await getAttioClientFromCreds(credentialsId);
        if (!client) return [];
        const attr = (await client.listAttributes({ objectId })).find((a) => a.id === attributeId);
        if (!attr) return [];
        if (attr.type === 'select') {
          return client.listAttributeOptions({ objectId, attributeId });
        }
        if (attr.type === 'status') {
          return client.listStatuses({ objectId, attributeId });
        }
        return [];
      }
      if (adapterType === 'AFFINITY') {
        const client = await getAffinityClientFromCreds(credentialsId);
        if (!client) return [];
        const entityType = objectId === 'person' ? 'PERSON' : 'ORGANIZATION';
        const fields = await client.getFields({ type: entityType as 'PERSON' | 'ORGANIZATION' });
        const field = fields.find((f) => String(f.id) === attributeId);
        if (!field?.dropdown_options?.length) return [];
        return field.dropdown_options.map((o) => ({ id: String(o.id), name: o.text }));
      }
      if (adapterType === 'AIRTABLE') {
        // objectId is "baseId:tableId" — find the field and extract select options
        const [baseId, tableId] = objectId.split(':');
        if (!baseId || !tableId) return [];
        const client = await getAirtableClientFromCreds(credentialsId);
        if (!client) return [];
        const tables = await client.listTables({ baseId });
        const table = tables.find((t) => t.id === tableId);
        const field = table?.fields.find((f) => f.id === attributeId);
        const opts = field?.options as Record<string, unknown> | undefined;
        const choices = opts?.choices as Array<{ id: string; name: string }> | undefined;
        if (!choices?.length) return [];
        return choices.map((c) => ({ id: c.id, name: c.name }));
      }
      return [];
    },

    async getChannels(credentialsId: string) {
      if (adapterType !== 'SLACK') return [];
      const client = await getSlackConfigurerFromCreds(credentialsId);
      if (!client) return [];
      const channels = await client.listChannels({});
      return channels.map((c) => ({ id: c.id, name: c.name }));
    },

    async getLists(credentialsId: string) {
      if (adapterType === 'ATTIO') {
        const client = await getAttioClientFromCreds(credentialsId);
        if (!client) return [];
        return client.listLists();
      }
      if (adapterType === 'AFFINITY') {
        const client = await getAffinityClientFromCreds(credentialsId);
        if (!client) return [];
        const lists = await client.getAllLists();
        return lists.map((l) => ({ id: String(l.id), name: l.name ?? `List ${l.id}` }));
      }
      return [];
    },
  };
}

function affinityFieldTypeName(vt: number): string {
  switch (vt) {
    case affinityValueType.PERSON: return 'person';
    case affinityValueType.ORGANIZATION: return 'organization';
    case affinityValueType.DROPDOWN: return 'dropdown';
    case affinityValueType.NUMBER: return 'number';
    case affinityValueType.DATE: return 'date';
    case affinityValueType.LOCATION: return 'location';
    case affinityValueType.TEXT: return 'text';
    case affinityValueType.RANKED_DROPDOWN: return 'ranked_dropdown';
    default: return 'unknown';
  }
}

async function decryptCredentials(credentialsId: string): Promise<Record<string, unknown> | null> {
  try {
    const row = await getAutomationsQb(['external_service_credentials'])
      .selectFrom('external_service_credentials')
      .where('id', '=', credentialsId as ExternalServiceCredentialsId)
      .select(['id', 'credentials'])
      .executeTakeFirst();
    if (!row) return null;
    const decrypted = await decryptToken(row.credentials, row.id);
    return JSON.parse(decrypted);
  } catch (err) {
    logger.error('Failed to decrypt credentials', { credentialsId, error: err });
    return null;
  }
}

async function getAttioClientFromCreds(credentialsId: string) {
  const raw = await decryptCredentials(credentialsId);
  if (!raw) return null;
  const parsed = attioCredsParser.safeParse(raw);
  if (!parsed.success) return null;
  return getAttioClient(parsed.data.accessToken, parsed.data.baseUrl);
}

async function getAffinityClientFromCreds(credentialsId: string) {
  const raw = await decryptCredentials(credentialsId);
  if (!raw) return null;
  const parsed = affinityCredsParser.safeParse(raw);
  if (!parsed.success) return null;
  return getAffinityClient(parsed.data.apiKey, parsed.data.baseUrl);
}

async function getAirtableClientFromCreds(credentialsId: string) {
  const raw = await decryptCredentials(credentialsId);
  if (!raw) return null;
  const parsed = airtableCredsParser.safeParse(raw);
  if (!parsed.success) return null;
  return getAirtableClient(credentialsId, parsed.data);
}

async function getSlackConfigurerFromCreds(credentialsId: string) {
  const raw = await decryptCredentials(credentialsId);
  if (!raw) return null;
  const parsed = slackCredsParser.safeParse(raw);
  if (!parsed.success) return null;
  const client = getSlackClient(parsed.data.accessToken, parsed.data.baseUrl);
  return new SlackWebApiConfigurer({ client });
}

// Recursively find an ActionNode by ID in the config tree
function findActionNode(config: OutputV3Config, nodeId: string): ActionNode | undefined {
  function search(node: TreeNode): ActionNode | undefined {
    if (node.kind === 'action') {
      if (node.id === nodeId) return node;
      for (const child of node.children) {
        const found = search(child.node);
        if (found) return found;
      }
    } else if (node.kind === 'branch') {
      if (node.match) { const found = search(node.match); if (found) return found; }
      if (node.noMatch) { const found = search(node.noMatch); if (found) return found; }
    }
    return undefined;
  }
  for (const root of config.actionTree.roots) {
    const found = search(root);
    if (found) return found;
  }
  return undefined;
}

// Tool definitions in OpenAI format (consumed by anthropicToolLoop)
const toolDefinitions = [
  {
    type: 'function',
    name: 'setTrigger',
    description: 'Set the output trigger. Extraction triggers fire after a message is ingested. Mutation triggers fire when a node changes.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['extraction', 'mutation'], description: 'Trigger type' },
        messageNodeTypeId: { type: 'string', description: 'For extraction: the message node type ID' },
        nodeTypeId: { type: 'string', description: 'For mutation: the node type ID to watch' },
      },
      required: ['type'],
    },
  },
  {
    type: 'function',
    name: 'addRootAction',
    description: 'Add a root action node to the tree. This is a top-level action that executes when the trigger fires.',
    parameters: {
      type: 'object',
      properties: {
        nodeType: { type: 'string', description: 'Adapter action type (e.g., "attio:object", "slack:message")' },
      },
      required: ['nodeType'],
    },
  },
  {
    type: 'function',
    name: 'addChildAction',
    description: 'Add a child action under an existing action. Child actions execute after their parent and receive the parent result.',
    parameters: {
      type: 'object',
      properties: {
        parentId: { type: 'string', description: 'ID of the parent action node' },
        nodeType: { type: 'string', description: 'Adapter action type' },
      },
      required: ['parentId', 'nodeType'],
    },
  },
  {
    type: 'function',
    name: 'addBranch',
    description: 'Add a branch node that evaluates a condition. Can be a root or child of an action.',
    parameters: {
      type: 'object',
      properties: {
        parentId: { type: 'string', description: 'Optional parent action node ID. Omit for root branch.' },
      },
    },
  },
  {
    type: 'function',
    name: 'setBranchChild',
    description: 'Set the action that executes on a branch path (match = condition true, noMatch = condition false).',
    parameters: {
      type: 'object',
      properties: {
        branchId: { type: 'string', description: 'ID of the branch node' },
        path: { type: 'string', enum: ['match', 'noMatch'], description: 'Which path to set' },
        nodeType: { type: 'string', description: 'Adapter action type for the child' },
      },
      required: ['branchId', 'path', 'nodeType'],
    },
  },
  {
    type: 'function',
    name: 'setMode',
    description: 'Set the mode of an action node. "assert" (default) creates or updates the external record. "read" only looks up an existing record without creating or updating — useful for resolving references to external objects.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'ID of the action node' },
        mode: { type: 'string', enum: ['assert', 'read'], description: 'The execution mode' },
      },
      required: ['nodeId', 'mode'],
    },
  },
  {
    type: 'function',
    name: 'removeNode',
    description: 'Remove a node and its entire subtree from the action tree.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'ID of the node to remove' },
      },
      required: ['nodeId'],
    },
  },
  {
    type: 'function',
    name: 'setTraversal',
    description: 'Set the traversal steps for an action node. This determines which knowledge graph node(s) the action reads from. The system auto-resolves the resulting knowledgeNodeTypeId.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'ID of the action node' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['edge', 'linkBack'], description: 'Step type' },
              edgeTypeId: { type: 'string', description: 'Edge type ID (for edge steps)' },
              direction: { type: 'string', enum: ['outgoing', 'incoming'], description: 'Edge direction (for edge steps)' },
            },
            required: ['type'],
          },
          description: 'Traversal steps. Empty array means "use the trigger context node directly".',
        },
      },
      required: ['nodeId', 'steps'],
    },
  },
  {
    type: 'function',
    name: 'setAdapterConfig',
    description: 'Set an adapter config field on an action node (e.g., objectId for Attio, channelId for Slack).',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'ID of the action node' },
        key: { type: 'string', description: 'Config key (e.g., "objectId", "channelId", "listId")' },
        value: { description: 'Config value' },
      },
      required: ['nodeId', 'key', 'value'],
    },
  },
  {
    type: 'function',
    name: 'addFieldMapping',
    description:
      'Add a field mapping to an action node. Use the `expression` parameter (preferred) to build composable expression trees. Legacy `selection`/`traversal`/`aggregation` parameters are still accepted but expressions are more powerful and should be used for all new mappings.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'ID of the action node' },
        targetField: { type: 'string', description: 'External system field name/slug' },
        expression: {
          type: 'object',
          description:
            'Composable expression tree (preferred). See system prompt for full expression language. Common leaf nodes: { type: "property", propertyTypeId }, { type: "static", value }, { type: "llm", prompt }, { type: "meta", key }. Compose with traverse, concat, conditional, aggregate, compare, etc.',
        },
        traversal: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['edge', 'linkBack'] },
              edgeTypeId: { type: 'string' },
              direction: { type: 'string', enum: ['outgoing', 'incoming'] },
            },
            required: ['type'],
          },
          description: 'Legacy mode: additional traversal from the action context. Prefer using expression with traverse nodes instead.',
        },
        selection: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['property', 'edge_property', 'llm'], description: 'What to read' },
            propertyTypeId: { type: 'string', description: 'Property type ID (for property/edge_property modes)' },
            prompt: { type: 'string', description: 'LLM prompt (for llm mode)' },
          },
          required: ['mode'],
          description: 'Legacy mode: how to select the value. Prefer using expression instead.',
        },
        aggregation: {
          type: 'object',
          properties: {
            function: { type: 'string', enum: ['first', 'last', 'count', 'sum', 'avg', 'min', 'max', 'join', 'collect', 'llm'] },
            separator: { type: 'string', description: 'For "join" function' },
            prompt: { type: 'string', description: 'For "llm" function' },
          },
          description: 'Legacy mode: how to reduce multiple values. Prefer using expression with aggregate nodes instead.',
        },
        identity: {
          type: 'string',
          enum: ['unique', 'fuzzy', 'none'],
          description: 'Deduplication hint. "unique" for exact match, "fuzzy" for search, "none" for no dedup.',
        },
        dataType: {
          type: 'string',
          enum: ['string', 'number', 'boolean', 'json', 'documents'],
          description: 'Type coercion for the field value.',
        },
      },
      required: ['nodeId', 'targetField'],
    },
  },
  {
    type: 'function',
    name: 'updateFieldMapping',
    description: 'Update an existing field mapping by index. Use `expression` for composable expressions (preferred over legacy selection/aggregation).',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'ID of the action node' },
        index: { type: 'number', description: 'Zero-based index of the field mapping to update' },
        targetField: { type: 'string' },
        expression: {
          type: 'object',
          description: 'Composable expression tree (preferred). Replaces any existing selection/traversal/aggregation on this mapping.',
        },
        traversal: {
          type: 'array',
          items: { type: 'object' },
          description: 'Legacy mode traversal. Prefer expression instead.',
        },
        selection: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['property', 'edge_property', 'llm'] },
            propertyTypeId: { type: 'string' },
            prompt: { type: 'string' },
          },
          description: 'Legacy mode selection. Prefer expression instead.',
        },
        aggregation: {
          type: 'object',
          description: 'Legacy mode aggregation. Prefer expression instead.',
        },
        identity: { type: 'string', enum: ['unique', 'fuzzy', 'none'] },
        dataType: { type: 'string', enum: ['string', 'number', 'boolean', 'json', 'documents'] },
      },
      required: ['nodeId', 'index'],
    },
  },
  {
    type: 'function',
    name: 'removeFieldMapping',
    description: 'Remove a field mapping by index.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'ID of the action node' },
        index: { type: 'number', description: 'Zero-based index of the field mapping to remove' },
      },
      required: ['nodeId', 'index'],
    },
  },
  {
    type: 'function',
    name: 'writeExpression',
    description:
      'Use the expression writer to generate a validated expression from a natural-language intent. Returns a composable expression tree that you can pass directly to addFieldMapping or updateFieldMapping. This is the PREFERRED way to create field mapping expressions — describe what you want in plain English and the expression writer builds and validates the formula.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description: 'ID of the action node — used to determine which node type (and thus which properties/edges) are available.',
        },
        intent: {
          type: 'string',
          description:
            'Natural-language description of what the expression should compute. E.g., "the company name", "join all investor names with commas", "if stage is Seed then \'Early\' else \'Late\'".',
        },
        targetFieldName: { type: 'string', description: 'Name of the external field being mapped to (helps the writer pick the right format).' },
        targetFieldType: { type: 'string', description: 'Type of the external field (e.g., "text", "number", "select").' },
        targetFieldOptions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Allowed option values for select/status fields.',
        },
      },
      required: ['nodeId', 'intent'],
    },
  },
  {
    type: 'function',
    name: 'setFilter',
    description: 'Set the filter expression on a branch node.',
    parameters: {
      type: 'object',
      properties: {
        branchId: { type: 'string', description: 'ID of the branch node' },
        filter: { type: 'object', description: 'Filter expression (FilterCondition or $and/$or/$not composition)' },
      },
      required: ['branchId', 'filter'],
    },
  },
  {
    type: 'function',
    name: 'getOntology',
    description: 'Get the full ontology: all node types, edge types, and their connections.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'getEdgesFrom',
    description: 'Get all edges connected to a specific node type (both outgoing and incoming).',
    parameters: {
      type: 'object',
      properties: {
        nodeTypeId: { type: 'string', description: 'Node type ID to query edges for' },
      },
      required: ['nodeTypeId'],
    },
  },
  {
    type: 'function',
    name: 'getPropertiesOf',
    description: 'Get all properties defined on a specific node type.',
    parameters: {
      type: 'object',
      properties: {
        nodeTypeId: { type: 'string', description: 'Node type ID to query properties for' },
      },
      required: ['nodeTypeId'],
    },
  },
  {
    type: 'function',
    name: 'getEdgeProperties',
    description: 'Get all properties defined on a specific edge type.',
    parameters: {
      type: 'object',
      properties: {
        edgeTypeId: { type: 'string', description: 'Edge type ID to query properties for' },
      },
      required: ['edgeTypeId'],
    },
  },
  {
    type: 'function',
    name: 'getAdapterNodeTypes',
    description: 'Get the available action types for a specific adapter (e.g., attio, slack, airtable).',
    parameters: {
      type: 'object',
      properties: {
        adapter: { type: 'string', description: 'Adapter name (attio, slack, airtable, google_sheets, webhook)' },
      },
      required: ['adapter'],
    },
  },
  {
    type: 'function',
    name: 'getAdapterObjects',
    description: 'List the available objects/record types in the connected external service (e.g., Attio Companies, People). Uses the credentials already bound to this session.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'getAdapterAttributes',
    description: 'List attributes/fields on a specific object in the connected external service.',
    parameters: {
      type: 'object',
      properties: {
        objectId: { type: 'string', description: 'The object ID to list attributes for' },
      },
      required: ['objectId'],
    },
  },
  {
    type: 'function',
    name: 'getAdapterAttributeOptions',
    description: 'List the allowed option values for a select or status field in the external service. Use this for enum fields where values are constrained.',
    parameters: {
      type: 'object',
      properties: {
        objectId: { type: 'string', description: 'The object ID' },
        attributeId: { type: 'string', description: 'The attribute ID to list options for' },
      },
      required: ['objectId', 'attributeId'],
    },
  },
  {
    type: 'function',
    name: 'getAdapterChannels',
    description: 'List available channels in the connected Slack workspace.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'getAdapterLists',
    description: 'List available lists in the connected Attio workspace.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'getCurrentConfig',
    description: 'Get the current config state with validation errors and warnings.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'validate',
    description: 'Run full validation on the current config and return errors and warnings.',
    parameters: { type: 'object', properties: {} },
  },
  // -- Airtable-specific tools (two-level base→table→field hierarchy) --
  {
    type: 'function',
    name: 'getAirtableBases',
    description: 'List all Airtable bases accessible with the current credentials.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'getAirtableTables',
    description: 'List all tables in an Airtable base, including their fields. Use this to discover table IDs and field IDs for Airtable outputs.',
    parameters: {
      type: 'object',
      properties: {
        baseId: { type: 'string', description: 'Airtable base ID (e.g., "appXXXXXXXXX")' },
      },
      required: ['baseId'],
    },
  },
  // -- Environment tools: credentials, outputs, persistence --
  {
    type: 'function',
    name: 'listCredentials',
    description: 'List all connected credentials (API keys, OAuth tokens) for this team. Use this to find which credentials are available for a given adapter type (ATTIO, AFFINITY, SLACK, AIRTABLE, GOOGLE_SHEETS, WEBHOOK).',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'selectCredentials',
    description: 'Select credentials for the current session. After calling this, adapter metadata tools (getAdapterObjects, getAdapterAttributes, etc.) will use these credentials. Also sets the adapter type from the credential type.',
    parameters: {
      type: 'object',
      properties: {
        credentialsId: { type: 'string', description: 'Credentials ID from listCredentials' },
      },
      required: ['credentialsId'],
    },
  },
  {
    type: 'function',
    name: 'listOutputs',
    description: 'List all existing output configurations for this team, including their names, types, run modes, and whether they use v3 config.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'loadOutput',
    description: 'Load an existing output configuration into the current session for editing. Replaces the current config, adapter type, and credentials with those from the saved output.',
    parameters: {
      type: 'object',
      properties: {
        outputId: { type: 'string', description: 'Pipeline output ID from listOutputs' },
      },
      required: ['outputId'],
    },
  },
  {
    type: 'function',
    name: 'saveConfig',
    description: 'Save the current configuration to a pipeline output. If outputId is provided, updates an existing output. If not, creates a new output with the given name and adapter type.',
    parameters: {
      type: 'object',
      properties: {
        outputId: { type: 'string', description: 'Existing output ID to update. Omit to create new.' },
        name: { type: 'string', description: 'Output name (required when creating new)' },
      },
    },
  },
];

interface ToolContext {
  session: AgentToolSession;
  teamId: string;
  ontology: OntologySummary;
  emitUpdate: (update: Omit<AgentUpdate, 'sessionId' | 'timestamp'>) => void;
}

function createWrappedTools(ctx: ToolContext): Record<string, (args: any) => Promise<any>> {
  const { session, teamId, ontology, emitUpdate } = ctx;

  const wrap = (label: string, fn: (args: any) => any) => async (args: any) => {
    emitUpdate({ type: 'tool_call', message: label });
    try {
      const result = fn(args);
      return result instanceof Promise ? await result : result;
    } catch (error: any) {
      if (error?.isHandoff || error?.isHandBack) throw error;
      const errMsg = error instanceof Error ? error.message : String(error);
      return { error: errMsg };
    }
  };

  return {
    // Config mutation tools
    setTrigger: wrap('Setting up trigger', (args) => session.setTrigger(args)),
    addRootAction: wrap('Adding action', (args) => session.addRootAction(args)),
    addChildAction: wrap('Adding child action', (args) => session.addChildAction(args)),
    addBranch: wrap('Adding branch', (args) => session.addBranch(args ?? {})),
    setMode: wrap('Setting action mode', (args) => session.setMode(args)),
    setBranchChild: wrap('Configuring branch path', (args) => session.setBranchChild(args)),
    removeNode: wrap('Removing node', (args) => session.removeNode(args)),
    setTraversal: wrap('Setting graph traversal', (args) => session.setTraversal(args)),
    setAdapterConfig: wrap('Configuring adapter settings', (args) => session.setAdapterConfig(args)),
    addFieldMapping: wrap('Mapping field', (args) => session.addFieldMapping(args)),
    updateFieldMapping: wrap('Updating field mapping', (args) => session.updateFieldMapping(args)),
    removeFieldMapping: wrap('Removing field mapping', (args) => session.removeFieldMapping(args)),

    writeExpression: wrap('Writing expression', async (args: {
      nodeId: string;
      intent: string;
      targetFieldName?: string;
      targetFieldType?: string;
      targetFieldOptions?: string[];
    }) => {
      // Find the action node's resolved knowledgeNodeTypeId from the live config
      const configResult = session.getCurrentConfig();
      const actionNode = findActionNode(configResult.config, args.nodeId);
      if (!actionNode) return { error: `Action node ${args.nodeId} not found` };

      const nodeTypeId = actionNode.knowledgeNodeTypeId;
      if (!nodeTypeId) return { error: 'Action node has no resolved node type — set a traversal first' };

      const nodeType = ontology.nodeTypes.find((n) => n.id === nodeTypeId);
      if (!nodeType) return { error: `Node type ${nodeTypeId} not found in ontology` };

      // Build PropertyInfo[] and EdgeInfo[] from the raw ontology
      const properties: PropertyInfo[] = ontology.propertyTypes
        .filter((p) => p.node_type_id === nodeTypeId)
        .map((p) => ({
          id: p.id,
          name: p.name,
          nodeTypeId: p.node_type_id ?? undefined,
          valueType: p.value_type ?? undefined,
          enumValues: p.enum_values ?? undefined,
        }));

      const edges: EdgeInfo[] = ontology.edgeTypes
        .filter((e) => e.source_node_type_id === nodeTypeId || e.target_node_type_id === nodeTypeId)
        .map((e) => ({
          id: e.id,
          outboundName: e.outbound_name,
          inboundName: e.inbound_name,
          sourceNodeTypeId: e.source_node_type_id,
          targetNodeTypeId: e.target_node_type_id,
        }));

      const edgeIds = new Set(edges.map((e) => e.id));
      const edgeProperties: PropertyInfo[] = ontology.propertyTypes
        .filter((p) => p.edge_type_id && edgeIds.has(p.edge_type_id))
        .map((p) => ({
          id: p.id,
          name: p.name,
          valueType: p.value_type ?? undefined,
        }));

      const writerCtx: ExpressionWriterContext = {
        intent: args.intent,
        subjectNodeTypeId: nodeTypeId,
        subjectNodeTypeName: nodeType.name,
        properties,
        edges,
        edgeProperties: edgeProperties.length > 0 ? edgeProperties : undefined,
        targetFieldName: args.targetFieldName,
        targetFieldType: args.targetFieldType,
        targetFieldOptions: args.targetFieldOptions,
      };

      const result = await writeExpression(writerCtx);

      if ('error' in result) {
        return { error: result.error, bestAttempt: result.bestAttempt };
      }

      return { expression: result.expression, formula: result.formula };
    }),

    setFilter: wrap('Setting filter condition', (args) => session.setFilter(args)),

    // Ontology & adapter query tools
    getOntology: wrap('Reading ontology', () => session.getOntology()),
    getEdgesFrom: wrap('Exploring relationships', (args) => session.getEdgesFrom(args)),
    getPropertiesOf: wrap('Checking available properties', (args) => session.getPropertiesOf(args)),
    getEdgeProperties: wrap('Checking edge properties', (args) => session.getEdgeProperties(args)),
    getAdapterNodeTypes: wrap('Looking up action types', (args) => session.getAdapterNodeTypes(args)),
    getAdapterObjects: wrap('Fetching external objects', () => session.getAdapterObjects()),
    getAdapterAttributes: wrap('Fetching external fields', (args) => session.getAdapterAttributes(args)),
    getAdapterAttributeOptions: wrap('Fetching field options', (args) => session.getAdapterAttributeOptions(args)),
    getAdapterChannels: wrap('Fetching channels', () => session.getAdapterChannels()),
    getAdapterLists: wrap('Fetching lists', () => session.getAdapterLists()),
    getCurrentConfig: wrap('Reviewing configuration', () => session.getCurrentConfig()),
    validate: wrap('Validating', () => session.validate()),

    // Airtable-specific tools
    getAirtableBases: wrap('Listing Airtable bases', async () => {
      if (!session.credentialsId) return { error: 'No credentials selected. Use selectCredentials first.' };
      const client = await getAirtableClientFromCreds(session.credentialsId);
      if (!client) return { error: 'Failed to connect to Airtable' };
      const bases = await client.listBases();
      return { bases: bases.map((b) => ({ id: b.id, name: b.name })) };
    }),

    getAirtableTables: wrap('Listing Airtable tables', async (args: { baseId: string }) => {
      if (!session.credentialsId) return { error: 'No credentials selected. Use selectCredentials first.' };
      const client = await getAirtableClientFromCreds(session.credentialsId);
      if (!client) return { error: 'Failed to connect to Airtable' };
      const tables = await client.listTables({ baseId: args.baseId });
      return {
        tables: tables.map((t) => ({
          id: t.id,
          name: t.name,
          fields: t.fields.map((f) => ({
            id: f.id,
            name: f.name,
            type: f.type,
            description: f.description,
          })),
        })),
      };
    }),

    // Environment tools: credentials, outputs, persistence
    listCredentials: wrap('Listing credentials', async () => {
      const rows = await getAutomationsQb(['external_service_credentials'])
        .selectFrom('external_service_credentials')
        .where('team_id', '=', teamId as TeamId)
        .select(['id', 'name', 'type'])
        .orderBy('name', 'asc')
        .execute();
      return { credentials: rows.map((c) => ({ id: c.id, name: c.name, type: c.type })) };
    }),

    selectCredentials: wrap('Selecting credentials', async (args: { credentialsId: string }) => {
      const row = await getAutomationsQb(['external_service_credentials'])
        .selectFrom('external_service_credentials')
        .where('id', '=', args.credentialsId as ExternalServiceCredentialsId)
        .where('team_id', '=', teamId as TeamId)
        .select(['id', 'name', 'type'])
        .executeTakeFirst();
      if (!row) return { error: 'Credentials not found' };

      session.setCredentialsId(row.id);
      session.setAdapterType(row.type);
      session.setAdapterMetadata(await buildAdapterMetadata(row.type));
      return { selected: { id: row.id, name: row.name, adapterType: row.type } };
    }),

    listOutputs: wrap('Listing outputs', async () => {
      const rows = await getQb(['pipeline_output', 'pipeline_configuration'])
        .selectFrom('pipeline_output as po')
        .innerJoin('pipeline_configuration as pc', 'pc.id', 'po.pipeline_configuration_id')
        .where('pc.team_id', '=', teamId as TeamId)
        .where('po.deleted_at', 'is', null)
        .select([
          'po.id', 'po.name', 'po.type', 'po.run_mode', 'po.config_version',
          'po.credentials_id', 'po.pipeline_configuration_id',
        ])
        .orderBy('po.name', 'asc')
        .execute();
      return {
        outputs: rows.map((o) => ({
          id: o.id,
          name: o.name,
          type: o.type,
          runMode: o.run_mode,
          configVersion: o.config_version,
          credentialsId: o.credentials_id,
        })),
      };
    }),

    loadOutput: wrap('Loading output config', async (args: { outputId: string }) => {
      const row = await getQb(['pipeline_output', 'pipeline_configuration'])
        .selectFrom('pipeline_output as po')
        .innerJoin('pipeline_configuration as pc', 'pc.id', 'po.pipeline_configuration_id')
        .where('po.id', '=', args.outputId as PipelineOutputId)
        .where('pc.team_id', '=', teamId as TeamId)
        .where('po.deleted_at', 'is', null)
        .select(['po.id', 'po.name', 'po.type', 'po.config', 'po.config_version', 'po.credentials_id'])
        .executeTakeFirst();
      if (!row) return { error: 'Output not found' };
      if (row.config_version < 3) return { error: `Output uses config v${row.config_version}; only v3 configs can be loaded` };

      const config = row.config as unknown as OutputV3Config;
      session.setAdapterType(row.type);
      session.setCredentialsId(row.credentials_id);
      session.setAdapterMetadata(await buildAdapterMetadata(row.type));
      return session.replaceConfig(config);
    }),

    saveConfig: wrap('Saving configuration', async (args: { outputId?: string; name?: string }) => {
      const config = session.config;

      if (args.outputId) {
        // Update existing — persist config and credentials
        const updated = await getQb(['pipeline_output', 'pipeline_configuration'])
          .updateTable('pipeline_output')
          .set({
            config: config as unknown as Record<string, unknown>,
            config_version: 3,
            credentials_id: session.credentialsId as ExternalServiceCredentialsId | null,
          })
          .where('id', '=', args.outputId as PipelineOutputId)
          .where('pipeline_configuration_id', 'in', ($) =>
            $.selectFrom('pipeline_configuration as pc')
              .select('pc.id')
              .where('pc.team_id', '=', teamId as TeamId),
          )
          .returning(['id', 'name'])
          .executeTakeFirst();
        if (!updated) return { error: 'Output not found or access denied' };
        return { saved: { id: updated.id, name: updated.name, action: 'updated' } };
      }

      // Create new — need pipeline_configuration_id
      if (!session.adapterType) return { error: 'Select an adapter type first (use selectCredentials)' };

      const pipelineConfig = await getQb(['pipeline_configuration'])
        .selectFrom('pipeline_configuration')
        .where('team_id', '=', teamId as TeamId)
        .where('deleted_at', 'is', null)
        .select('id')
        .executeTakeFirst();
      if (!pipelineConfig) return { error: 'No pipeline configuration found for this team' };

      const created = await getQb(['pipeline_output'])
        .insertInto('pipeline_output')
        .values({
          pipeline_configuration_id: pipelineConfig.id as PipelineConfigurationId,
          name: args.name || 'New Output',
          type: session.adapterType as PipelineOutputType,
          config: config as unknown as Record<string, unknown>,
          config_version: 3,
          credentials_id: session.credentialsId as ExternalServiceCredentialsId | null,
        })
        .returning(['id', 'name'])
        .executeTakeFirst();
      return { saved: { id: created?.id, name: created?.name, action: 'created' } };
    }),
  };
}

async function runOutputAgent(
  message: string,
  options: OutputAgentOptions,
): Promise<{ text: string; config: OutputV3Config }> {
  const { sessionId, teamId, conversationHistory, currentConfig, adapterType, credentialsId, additionalToolDefs = [], additionalToolImpls = {} } = options;

  const sid = sessionId || `oa-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const startTime = Date.now();

  const emitUpdate = (update: Omit<AgentUpdate, 'sessionId' | 'timestamp'>) => {
    if (sessionId) {
      mq.agentUpdates.update.publish({
        sessionId: sid,
        timestamp: Date.now(),
        ...update,
      });
    }
  };

  try {
    emitUpdate({ type: 'start', message: 'Starting output agent...' });

    // When invoked via handoff (no adapterType), auto-discover the team's first matching output
    let resolvedAdapterType = adapterType;
    let resolvedConfig = currentConfig;
    let resolvedCredentialsId = credentialsId;
    let existingOutputsSummary = '';

    if (!resolvedAdapterType) {
      const existingOutputs = await getQb(['pipeline_output', 'pipeline_configuration'])
        .selectFrom('pipeline_output as po')
        .innerJoin('pipeline_configuration as pc', 'pc.id', 'po.pipeline_configuration_id')
        .where('pc.team_id', '=', teamId as TeamId)
        .where('po.deleted_at', 'is', null)
        .select(['po.id', 'po.name', 'po.type', 'po.config', 'po.credentials_id', 'po.config_version'])
        .orderBy('po.name asc')
        .execute();

      if (existingOutputs.length > 0) {
        existingOutputsSummary = `\n\n## Existing Outputs\n\nThis team has ${existingOutputs.length} configured output(s):\n${existingOutputs.map((o) => `- **${o.name}** (${o.type}, id: ${o.id})`).join('\n')}\n\nUse \`loadOutput\` to load any of these for editing, or \`listCredentials\` + \`selectCredentials\` to start a new output from scratch.`;

        // Try to auto-select if there's only one, or if the referral mentions the type
        const referralText = (conversationHistory ?? []).map((m) => m.content).join(' ').toLowerCase();
        const matched = existingOutputs.find((o) =>
          referralText.includes(o.type.toLowerCase()) || referralText.includes(o.name.toLowerCase()),
        );
        if (matched && matched.config_version >= 3) {
          resolvedAdapterType = matched.type;
          resolvedConfig = matched.config as OutputV3Config;
          resolvedCredentialsId = matched.credentials_id;
          logger.info('[output_agent] auto-loaded output from handoff', { outputId: matched.id, type: matched.type });
        }
      }
    }

    const ontology = await loadOntology(teamId);
    const adapterMetadata = await buildAdapterMetadata(resolvedAdapterType);

    const context: AgentContext = {
      ontology,
      adapterMetadata,
      credentialsId: resolvedCredentialsId,
      adapterType: resolvedAdapterType,
    };

    const session = new AgentToolSession(context, resolvedConfig ?? undefined);
    const wrappedTools = createWrappedTools({ session, teamId, ontology, emitUpdate });

    // Build augmented system prompt with current ontology summary
    const ontologySummary = session.getOntology();
    const ontologyContext = `\n\n## Current Ontology\n\nNode types: ${ontologySummary.nodeTypes.map((nt) => `${nt.name} (${nt.category}, id: ${nt.id})`).join(', ') || 'none'}\n\nEdge types: ${ontologySummary.edgeTypes.map((et) => `${et.outbound_name}: ${et.source} → ${et.target} (id: ${et.id})`).join(', ') || 'none'}\n\nAdapter type: ${resolvedAdapterType || 'not set'}${existingOutputsSummary}`;

    const styleBlock = await getStyleBlock(teamId);
    let systemPrompt = OUTPUT_AGENT_SYSTEM_PROMPT + ontologyContext + styleBlock;

    if (sid.startsWith('mcp-')) {
      systemPrompt += `\n\n## MCP session constraints\n\nThis request is being served via MCP with a tight time budget. Be direct and concise — short answers, minimal formatting, no preamble. Prefer a single tool call over chained lookups when possible.`;
    }

    const onTurn = (event: TurnEvent) => {
      if (event.thinkingText) {
        emitUpdate({ type: 'thinking', message: event.thinkingText });
      }
    };

    // Inject additional tools from orchestrator (e.g., handoff tools)
    const allToolDefs: any[] = [...(toolDefinitions as any[]), ...additionalToolDefs];
    const allToolImpls = { ...wrappedTools, ...additionalToolImpls };

    const rawResult = await anthropicToolLoop(
      {
        model: 'claude-sonnet-5',
        max_output_tokens: 4096,
        maxTurns: 75,
        system: systemPrompt,
        userMessage: message,
        conversationHistory,
        tools: allToolDefs,
        onTurn,
        label: 'output_agent',
      },
      allToolImpls,
    );

    const validated = AgentResponseSchema.parse(rawResult);
    const text =
      validated
        .map((item) => item.text || item.content)
        .filter((t): t is string => !!t)
        .join('\n\n') || 'No response generated';

    const elapsedMs = Date.now() - startTime;
    emitUpdate({
      type: 'complete',
      message: `Complete in ${(elapsedMs / 1000).toFixed(1)}s`,
      data: { elapsedMs, text, config: session.config, agent: 'output' },
    });

    return { text, config: session.config };
  } catch (error: any) {
    if (error?.isHandoff || error?.isHandBack) throw error;

    console.error('Output agent error:', error);

    emitUpdate({
      type: 'error',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
      data: { error: String(error) },
    });

    if (error instanceof z.ZodError) {
      throw new Error(`Invalid response format: ${error.message}`);
    }
    throw error;
  }
}

export { runOutputAgent };
export type { OutputAgentOptions };
