/**
 * V3 Output Pipeline Integration Tests
 *
 * These tests wire up the full pipeline: knowledge graph → resolve → execute → adapter.
 * External systems are simulated (not mocked) so tests assert against resulting state
 * rather than call arguments.
 */

import type { OutputV3Config, ActionNode, BranchNode } from 'movement-engine/services/knowledge_pipeline/output_v3/schemas';
import type { OutputExecutionContext } from '../../output_v3/resolve';
import type { Changeset, ApplyResult } from '../../types';
import type { NodeId } from '../../../../generated/kysely/knowledge/Node';
import type { NodeTypeId } from '../../../../generated/kysely/knowledge/NodeType';
import type { PropertyTypeId } from '../../../../generated/kysely/knowledge/PropertyType';
import type { TeamId } from '../../../../generated/kysely/core/Team';

import { KnowledgeGraphSimulator, AttioSimulator, SlackSimulator, WebhookSimulator, AffinitySimulator, AirtableSimulator, GoogleSheetsSimulator } from './simulators';

// ---------------------------------------------------------------------------
// Module-level simulator instances (reset per test)
// ---------------------------------------------------------------------------

let mockGraph: KnowledgeGraphSimulator;

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports that use them
// ---------------------------------------------------------------------------

jest.mock('../../../../lib/slack', () => ({
  sendSlackNotification: jest.fn(),
}));

jest.mock('../../../../lib/credentials', () => ({
  getCredential: jest.fn(),
  encryptCredential: jest.fn(),
  decryptCredential: jest.fn(),
}));

jest.mock('../../../../lib/anthropic', () => ({
  anthropicChat: jest.fn(async () => 'LLM composed text'),
}));

jest.mock('../../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(() => {
    // Return the simulator's query builder — `mockGraph` is set in beforeEach
    return mockGraph.createQueryBuilder();
  }),
  getQb: jest.fn(() => {
    return mockGraph.createQueryBuilder();
  }),
  getCoreQb: jest.fn(() => {
    return mockGraph.createQueryBuilder();
  }),
}));

jest.mock('movement-engine/services/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../../../lib/prompts/execute', () => ({
  parseJson: jest.fn((text: string) => JSON.parse(text)),
}));

jest.mock('movement-engine/lib/utils/types', () => ({
  neverAsAny: (v: never) => v,
}));

// Mock linked_objects to use the simulator
jest.mock('../../output_v3/linked_objects', () => ({
  storeLinkedObject: jest.fn(async (options: { nodeId: string; teamId: string; source: string; adapterType: string; externalId: string; data?: Record<string, unknown>; actionNodeId?: string }) => {
    mockGraph.storeLinkedObject(options);
  }),
  loadLinkedObjects: jest.fn(async (nodeId: string, teamId: string) => {
    return mockGraph.loadLinkedObjects(nodeId, teamId);
  }),
  storeOutputRun: jest.fn(async (options: { teamId: string; pipelineOutputId: string; actionNodeId: string; contextNodeId: string; adapterType: string; externalId: string | null; status: string }) => {
    mockGraph.storeRun(options);
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { executeOutputs } from '../../output_v3/execute';
import { createAttioV3Adapter } from '../../output_v3/adapters/attio';
import { createSlackV3Adapter } from '../../output_v3/adapters/slack';
import { createWebhookV3Adapter } from '../../output_v3/adapters/webhook';
import { createAffinityV3Adapter } from '../../output_v3/adapters/affinity';
import { createAirtableV3Adapter } from '../../output_v3/adapters/airtable';
import { createGoogleSheetsV3Adapter } from '../../output_v3/adapters/google_sheets';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = 'team-001' as TeamId;

// Node type IDs
const NT_MESSAGE = 'nt-msg';
const NT_COMPANY = 'nt-company';
const NT_PERSON = 'nt-person';

// Edge type IDs
const ET_MSG_COMPANY = 'et-msg-company';
const ET_COMPANY_PERSON = 'et-company-person';

// Property type IDs
const PT_NAME = 'pt-name';
const PT_STAGE = 'pt-stage';
const PT_EMAIL = 'pt-email';
const PT_ROLE = 'pt-role';
const PT_AMOUNT = 'pt-amount';

// Node IDs
const NODE_MSG = 'node-msg-1' as NodeId;
const NODE_COMPANY_1 = 'node-company-1' as NodeId;
const NODE_COMPANY_2 = 'node-company-2' as NodeId;
const NODE_PERSON_1 = 'node-person-1' as NodeId;
const NODE_PERSON_2 = 'node-person-2' as NodeId;

// ---------------------------------------------------------------------------
// Graph setup helper
// ---------------------------------------------------------------------------

function buildDealflowGraph(): KnowledgeGraphSimulator {
  const g = new KnowledgeGraphSimulator();

  // Node types
  g.addNodeType(NT_MESSAGE, 'Dealflow Message', 'message');
  g.addNodeType(NT_COMPANY, 'Company', 'object');
  g.addNodeType(NT_PERSON, 'Person', 'object');

  // Property types
  g.addPropertyType(PT_NAME, 'name');
  g.addPropertyType(PT_STAGE, 'stage');
  g.addPropertyType(PT_EMAIL, 'email');
  g.addPropertyType(PT_ROLE, 'role');
  g.addPropertyType(PT_AMOUNT, 'amount');

  // Nodes
  g.addNode(NODE_MSG, NT_MESSAGE, TEAM_ID);
  g.addNode(NODE_COMPANY_1, NT_COMPANY, TEAM_ID);
  g.addNode(NODE_COMPANY_2, NT_COMPANY, TEAM_ID);
  g.addNode(NODE_PERSON_1, NT_PERSON, TEAM_ID);
  g.addNode(NODE_PERSON_2, NT_PERSON, TEAM_ID);

  // Properties
  g.addProperty(NODE_MSG, PT_NAME, TEAM_ID, 'Dealflow: Acme Corp Series A');
  g.addProperty(NODE_COMPANY_1, PT_NAME, TEAM_ID, 'Acme Corp');
  g.addProperty(NODE_COMPANY_1, PT_STAGE, TEAM_ID, 'Series A');
  g.addProperty(NODE_COMPANY_1, PT_AMOUNT, TEAM_ID, 5000000);
  g.addProperty(NODE_COMPANY_2, PT_NAME, TEAM_ID, 'Beta Inc');
  g.addProperty(NODE_COMPANY_2, PT_STAGE, TEAM_ID, 'Seed');
  g.addProperty(NODE_PERSON_1, PT_NAME, TEAM_ID, 'Jane Doe');
  g.addProperty(NODE_PERSON_1, PT_ROLE, TEAM_ID, 'CEO');
  g.addProperty(NODE_PERSON_1, PT_EMAIL, TEAM_ID, 'jane@acme.com');
  g.addProperty(NODE_PERSON_2, PT_NAME, TEAM_ID, 'Bob Smith');
  g.addProperty(NODE_PERSON_2, PT_ROLE, TEAM_ID, 'CTO');

  // Edges: message → companies, company1 → people
  g.addEdge('e1', NODE_MSG, NODE_COMPANY_1, ET_MSG_COMPANY, TEAM_ID);
  g.addEdge('e2', NODE_MSG, NODE_COMPANY_2, ET_MSG_COMPANY, TEAM_ID);
  g.addEdge('e3', NODE_COMPANY_1, NODE_PERSON_1, ET_COMPANY_PERSON, TEAM_ID);
  g.addEdge('e4', NODE_COMPANY_1, NODE_PERSON_2, ET_COMPANY_PERSON, TEAM_ID);

  // Source content for LLM
  g.addResource(NODE_MSG, TEAM_ID, 'Acme Corp is raising a $5M Series A. Founded by Jane Doe (CEO) and Bob Smith (CTO).');

  return g;
}

function makeContext(rootNodeId: NodeId, overrides?: Partial<OutputExecutionContext>): OutputExecutionContext {
  return {
    rootNodeId,
    teamId: TEAM_ID,
    pipelineOutputId: 'po-1',
    changeset: null,
    tempToRealId: null,
    oldProperties: null,
    meta: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Action node builder
// ---------------------------------------------------------------------------

function actionNode(overrides: Partial<ActionNode> & { id: string; type: string }): ActionNode {
  return {
    kind: 'action',
    knowledgeNodeTypeId: NT_COMPANY,
    traversal: [],
    adapterConfig: {},
    fieldMappings: [],
    children: [],
    ...overrides,
  };
}

function branchNode(overrides: Partial<BranchNode> & { id: string }): BranchNode {
  return {
    kind: 'branch',
    filter: { traversal: [], selection: { mode: 'property', propertyTypeId: 'pt-name' }, operator: 'exists', value: true },
    ...overrides,
  };
}

// ===================================================================
// ATTIO INTEGRATION TESTS
// ===================================================================

describe('V3 Pipeline — Attio', () => {
  let attio: AttioSimulator;

  beforeEach(() => {
    mockGraph = buildDealflowGraph();
    attio = new AttioSimulator();
  });

  it('creates a single object record with property field mappings', async () => {
    const adapter = createAttioV3Adapter(attio.createOperations() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'create-company',
            type: 'attio:object',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [],
            adapterConfig: { objectId: 'companies' },
            fieldMappings: [
              {
                targetField: 'name',
                traversal: [],
                selection: { mode: 'property', propertyTypeId: PT_NAME },
              },
              {
                targetField: 'stage',
                traversal: [],
                selection: { mode: 'property', propertyTypeId: PT_STAGE },
              },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));

    // Assert simulator state
    expect(attio.records).toHaveLength(1);
    expect(attio.records[0].objectId).toBe('companies');
    expect(attio.records[0].fields.name).toBe('Acme Corp');
    expect(attio.records[0].fields.stage).toBe('Series A');
  });

  it('creates parent object + child list entry linked together', async () => {
    const adapter = createAttioV3Adapter(attio.createOperations() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'create-company',
            type: 'attio:object',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [],
            adapterConfig: { objectId: 'companies' },
            fieldMappings: [
              { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
            ],
            children: [
              {
                node: actionNode({
                  id: 'create-list-entry',
                  type: 'attio:list-entry',
                  knowledgeNodeTypeId: NT_COMPANY,
                  traversal: [],
                  adapterConfig: { listId: 'deal-pipeline' },
                  fieldMappings: [
                    { targetField: 'stage', traversal: [], selection: { mode: 'property', propertyTypeId: PT_STAGE } },
                  ],
                }),
                relationship: { type: 'reference' },
              },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));

    // Parent company created
    expect(attio.records).toHaveLength(1);
    expect(attio.records[0].fields.name).toBe('Acme Corp');

    // List entry created and linked to parent
    expect(attio.listEntries).toHaveLength(1);
    expect(attio.listEntries[0].listId).toBe('deal-pipeline');
    expect(attio.listEntries[0].parentObjectId).toBe('companies');
    expect(attio.listEntries[0].parentRecordId).toBe(attio.records[0].recordId);
    expect(attio.listEntries[0].fields.stage).toBe('Series A');
  });

  it('creates object + note + task under it', async () => {
    const adapter = createAttioV3Adapter(attio.createOperations() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'create-company',
            type: 'attio:object',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [],
            adapterConfig: { objectId: 'companies' },
            fieldMappings: [
              { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
            ],
            children: [
              {
                node: actionNode({
                  id: 'create-note',
                  type: 'attio:note',
                  knowledgeNodeTypeId: NT_COMPANY,
                  traversal: [],
                  adapterConfig: { titlePrompt: 'Extract the stage', contentPrompt: 'Extract the name' },
                  fieldMappings: [],
                }),
                relationship: { type: 'embed' },
              },
              {
                node: actionNode({
                  id: 'create-task',
                  type: 'attio:task',
                  knowledgeNodeTypeId: NT_COMPANY,
                  traversal: [],
                  adapterConfig: { assignees: [{ workspaceMemberId: 'wm-1' }], deadlineOffsetDays: 7 },
                  fieldMappings: [
                    { targetField: 'content', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
                  ],
                }),
                relationship: { type: 'embed' },
              },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));

    expect(attio.records).toHaveLength(1);
    expect(attio.notes).toHaveLength(1);
    expect(attio.notes[0].parentRecordId).toBe(attio.records[0].recordId);
    expect(attio.notes[0].title).toBeTruthy();
    expect(attio.notes[0].content).toBeTruthy();

    expect(attio.tasks).toHaveLength(1);
    expect(attio.tasks[0].content).toBe('Acme Corp');
    expect(attio.tasks[0].assignees).toEqual([{ workspaceMemberId: 'wm-1' }]);
    expect(attio.tasks[0].deadlineAt).not.toBeNull();
    expect(attio.tasks[0].linkedRecords[0].targetRecordId).toBe(attio.records[0].recordId);
  });

  it('traverses edge to create company then walks to people', async () => {
    const adapter = createAttioV3Adapter(attio.createOperations() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'create-company',
            type: 'attio:object',
            knowledgeNodeTypeId: NT_COMPANY,
            // Walk from message to company
            traversal: [{ type: 'edge', edgeTypeId: ET_MSG_COMPANY, direction: 'outgoing' }],
            adapterConfig: { objectId: 'companies' },
            fieldMappings: [
              { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
            ],
            children: [
              {
                node: actionNode({
                  id: 'create-person',
                  type: 'attio:object',
                  knowledgeNodeTypeId: NT_PERSON,
                  // Walk from company to person
                  traversal: [{ type: 'edge', edgeTypeId: ET_COMPANY_PERSON, direction: 'outgoing' }],
                  adapterConfig: { objectId: 'people', parentReferenceField: { fieldId: 'company_ref' } },
                  fieldMappings: [
                    { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
                    { targetField: 'email', traversal: [], selection: { mode: 'property', propertyTypeId: PT_EMAIL } },
                  ],
                }),
                relationship: { type: 'reference' },
              },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_MSG));

    // Two companies created (msg → company1, msg → company2)
    const companies = attio.records.filter((r) => r.objectId === 'companies');
    expect(companies).toHaveLength(2);
    expect(companies.map((c) => c.fields.name).sort()).toEqual(['Acme Corp', 'Beta Inc']);

    // People only created under company1 (company2 has no person edges)
    const people = attio.records.filter((r) => r.objectId === 'people');
    expect(people).toHaveLength(2);
    expect(people.map((p) => p.fields.name).sort()).toEqual(['Bob Smith', 'Jane Doe']);

    // People are linked back to their parent company
    const acmeCompany = companies.find((c) => c.fields.name === 'Acme Corp')!;
    for (const person of people) {
      expect(person.fields.company_ref).toEqual({
        target_object: 'companies',
        target_record_id: acmeCompany.recordId,
      });
    }
  });

  it('deduplicates on re-run — same company updated, not duplicated', async () => {
    attio.addAttribute({ objectId: 'companies', id: 'attr-name', name: 'Name', apiSlug: 'name', type: 'text' });

    const adapter = createAttioV3Adapter(attio.createOperations() as any);

    const node = actionNode({
      id: 'create-company',
      type: 'attio:object',
      knowledgeNodeTypeId: NT_COMPANY,
      traversal: [],
      adapterConfig: { objectId: 'companies' },
      fieldMappings: [
        { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME }, identity: 'fuzzy' },
        { targetField: 'stage', traversal: [], selection: { mode: 'property', propertyTypeId: PT_STAGE } },
      ],
    });

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: { roots: [node] },
    };

    // First run
    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));
    expect(attio.records).toHaveLength(1);

    // Second run — searchRecords matches by fuzzy name
    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));
    expect(attio.records).toHaveLength(1); // Still 1, not 2
    expect(attio.records[0].fields.stage).toBe('Series A');
  });
});

// ===================================================================
// SLACK INTEGRATION TESTS
// ===================================================================

describe('V3 Pipeline — Slack', () => {
  let slack: SlackSimulator;

  beforeEach(() => {
    mockGraph = buildDealflowGraph();
    slack = new SlackSimulator();
    slack.addMembership('CDEALS001');
  });

  it('posts a message to a channel with resolved field values', async () => {
    const adapter = createSlackV3Adapter(slack.createClient() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'post-message',
            type: 'slack:message',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [],
            adapterConfig: { channelId: 'CDEALS001', prompt: 'Summarize this company' },
            fieldMappings: [],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));

    const messages = slack.getMessagesInChannel('CDEALS001');
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBeTruthy();
    expect(messages[0].threadTs).toBeUndefined();
  });

  it('posts message + thread replies per company from message', async () => {
    const adapter = createSlackV3Adapter(slack.createClient() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'post-summary',
            type: 'slack:message',
            knowledgeNodeTypeId: NT_MESSAGE,
            traversal: [],
            adapterConfig: { channelId: 'CDEALS001', prompt: 'Summarize this deal' },
            fieldMappings: [],
            children: [
              {
                node: actionNode({
                  id: 'reply-per-company',
                  type: 'slack:thread-reply',
                  knowledgeNodeTypeId: NT_COMPANY,
                  traversal: [{ type: 'edge', edgeTypeId: ET_MSG_COMPANY, direction: 'outgoing' }],
                  adapterConfig: { prompt: 'Summarize this company' },
                  fieldMappings: [],
                }),
                relationship: { type: 'embed' },
              },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_MSG));

    const allMessages = slack.getMessagesInChannel('CDEALS001');
    expect(allMessages).toHaveLength(3); // 1 parent + 2 thread replies

    const parent = allMessages[0];
    expect(parent.threadTs).toBeUndefined();

    const replies = slack.getThreadReplies('CDEALS001', parent.ts);
    expect(replies).toHaveLength(2);
  });

  it('joins channel when not already a member', async () => {
    slack = new SlackSimulator(); // No memberships
    const adapter = createSlackV3Adapter(slack.createClient() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'post-msg',
            type: 'slack:message',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [],
            adapterConfig: { channelId: 'CNEWCH001', prompt: 'Summarize this company' },
            fieldMappings: [],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));

    expect(slack.joinedChannels.has('CNEWCH001')).toBe(true);
    expect(slack.getMessagesInChannel('CNEWCH001')).toHaveLength(1);
  });
});

// ===================================================================
// WEBHOOK INTEGRATION TESTS
// ===================================================================

describe('V3 Pipeline — Webhook', () => {
  let webhook: WebhookSimulator;

  beforeEach(() => {
    mockGraph = buildDealflowGraph();
    webhook = new WebhookSimulator();
    webhook.install();
  });

  afterEach(() => {
    webhook.restore();
  });

  it('POSTs resolved field values to webhook URL', async () => {
    const adapter = createWebhookV3Adapter({
      url: 'https://example.com/hook',
      method: 'POST',
    });

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'send-webhook',
            type: 'webhook:object',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [],
            adapterConfig: {},
            fieldMappings: [
              { targetField: 'company_name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
              { targetField: 'funding_stage', traversal: [], selection: { mode: 'property', propertyTypeId: PT_STAGE } },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));

    expect(webhook.calls).toHaveLength(1);
    expect(webhook.calls[0].url).toBe('https://example.com/hook');
    expect(webhook.calls[0].body).toEqual({
      company_name: 'Acme Corp',
      funding_stage: 'Series A',
    });
  });

  it('sends one webhook per traversed entity', async () => {
    const adapter = createWebhookV3Adapter({
      url: 'https://example.com/hook',
      method: 'POST',
    });

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'send-per-company',
            type: 'webhook:object',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [{ type: 'edge', edgeTypeId: ET_MSG_COMPANY, direction: 'outgoing' }],
            adapterConfig: {},
            fieldMappings: [
              { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_MSG));

    expect(webhook.calls).toHaveLength(2);
    const names = webhook.calls.map((c) => (c.body as { name: string }).name).sort();
    expect(names).toEqual(['Acme Corp', 'Beta Inc']);
  });

  it('includes auth headers when configured', async () => {
    const adapter = createWebhookV3Adapter({
      url: 'https://example.com/hook',
      method: 'POST',
      auth: { type: 'bearer', token: 'secret-token' },
    });

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'send-authed',
            type: 'webhook:object',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [],
            adapterConfig: {},
            fieldMappings: [
              { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));

    expect(webhook.calls[0].headers['Authorization']).toBe('Bearer secret-token');
  });
});

// ===================================================================
// BRANCH NODE TESTS
// ===================================================================

describe('V3 Pipeline — Branch Nodes', () => {
  let attio: AttioSimulator;

  beforeEach(() => {
    mockGraph = buildDealflowGraph();
    attio = new AttioSimulator();
  });

  it('takes match path when filter passes', async () => {
    const adapter = createAttioV3Adapter(attio.createOperations() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          branchNode({
            id: 'check-stage',
            filter: {
              traversal: [],
              selection: { mode: 'property', propertyTypeId: PT_STAGE },
              operator: 'eq',
              value: 'Series A',
            },
            match: actionNode({
              id: 'create-in-series-a-list',
              type: 'attio:object',
              knowledgeNodeTypeId: NT_COMPANY,
              traversal: [],
              adapterConfig: { objectId: 'series-a-companies' },
              fieldMappings: [
                { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
              ],
            }),
            noMatch: actionNode({
              id: 'create-in-other-list',
              type: 'attio:object',
              knowledgeNodeTypeId: NT_COMPANY,
              traversal: [],
              adapterConfig: { objectId: 'other-companies' },
              fieldMappings: [
                { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
              ],
            }),
          }),
        ],
      },
    };

    // Company 1 is Series A → match path
    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));

    expect(attio.records).toHaveLength(1);
    expect(attio.records[0].objectId).toBe('series-a-companies');
  });

  it('takes noMatch path when filter fails', async () => {
    const adapter = createAttioV3Adapter(attio.createOperations() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          branchNode({
            id: 'check-stage',
            filter: {
              traversal: [],
              selection: { mode: 'property', propertyTypeId: PT_STAGE },
              operator: 'eq',
              value: 'Series A',
            },
            match: actionNode({
              id: 'create-in-series-a',
              type: 'attio:object',
              knowledgeNodeTypeId: NT_COMPANY,
              traversal: [],
              adapterConfig: { objectId: 'series-a-companies' },
              fieldMappings: [],
            }),
            noMatch: actionNode({
              id: 'create-in-other',
              type: 'attio:object',
              knowledgeNodeTypeId: NT_COMPANY,
              traversal: [],
              adapterConfig: { objectId: 'other-companies' },
              fieldMappings: [
                { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
              ],
            }),
          }),
        ],
      },
    };

    // Company 2 is Seed → noMatch path
    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_2));

    expect(attio.records).toHaveLength(1);
    expect(attio.records[0].objectId).toBe('other-companies');
    expect(attio.records[0].fields.name).toBe('Beta Inc');
  });

  it('silently drops when no branch path is defined for outcome', async () => {
    const adapter = createAttioV3Adapter(attio.createOperations() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          branchNode({
            id: 'filter-only',
            filter: {
              traversal: [],
              selection: { mode: 'property', propertyTypeId: PT_STAGE },
              operator: 'eq',
              value: 'Series B', // Neither company matches
            },
            match: actionNode({
              id: 'create-match',
              type: 'attio:object',
              knowledgeNodeTypeId: NT_COMPANY,
              traversal: [],
              adapterConfig: { objectId: 'companies' },
              fieldMappings: [],
            }),
            // no noMatch branch
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));
    expect(attio.records).toHaveLength(0); // Nothing created
  });

  it('supports composite filter with $and', async () => {
    const adapter = createAttioV3Adapter(attio.createOperations() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          branchNode({
            id: 'composite-filter',
            filter: {
              $and: [
                { traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME }, operator: 'contains', value: 'Acme' },
                { traversal: [], selection: { mode: 'property', propertyTypeId: PT_STAGE }, operator: 'eq', value: 'Series A' },
              ],
            },
            match: actionNode({
              id: 'create-qualified',
              type: 'attio:object',
              knowledgeNodeTypeId: NT_COMPANY,
              traversal: [],
              adapterConfig: { objectId: 'qualified' },
              fieldMappings: [
                { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
              ],
            }),
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));
    expect(attio.records).toHaveLength(1);
    expect(attio.records[0].objectId).toBe('qualified');
  });
});

// ===================================================================
// CROSS-ADAPTER: EDGE TRAVERSAL + FIELD RESOLUTION
// ===================================================================

describe('V3 Pipeline — Field Resolution', () => {
  let attio: AttioSimulator;

  beforeEach(() => {
    mockGraph = buildDealflowGraph();
    attio = new AttioSimulator();
  });

  it('resolves fields via multi-step traversal (msg → company → person name)', async () => {
    const adapter = createAttioV3Adapter(attio.createOperations() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'create-company',
            type: 'attio:object',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [{ type: 'edge', edgeTypeId: ET_MSG_COMPANY, direction: 'outgoing', cardinality: { mode: 'first' } }],
            adapterConfig: { objectId: 'companies' },
            fieldMappings: [
              { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
              // Resolve CEO name by walking company → person edge and picking first
              {
                targetField: 'ceo_name',
                traversal: [{ type: 'edge', edgeTypeId: ET_COMPANY_PERSON, direction: 'outgoing', cardinality: { mode: 'first' } }],
                selection: { mode: 'property', propertyTypeId: PT_NAME },
              },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_MSG));

    expect(attio.records).toHaveLength(1);
    expect(attio.records[0].fields.name).toBe('Acme Corp');
    // First person connected to company 1 is person 1 (Jane Doe)
    expect(attio.records[0].fields.ceo_name).toBe('Jane Doe');
  });

  it('aggregates multiple values with join', async () => {
    const adapter = createAttioV3Adapter(attio.createOperations() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'create-company',
            type: 'attio:object',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [{ type: 'edge', edgeTypeId: ET_MSG_COMPANY, direction: 'outgoing', cardinality: { mode: 'first' } }],
            adapterConfig: { objectId: 'companies' },
            fieldMappings: [
              { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
              {
                targetField: 'team_names',
                traversal: [{ type: 'edge', edgeTypeId: ET_COMPANY_PERSON, direction: 'outgoing' }],
                selection: { mode: 'property', propertyTypeId: PT_NAME },
                aggregation: { function: 'join', separator: ', ' },
              },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_MSG));

    expect(attio.records).toHaveLength(1);
    expect(attio.records[0].fields.team_names).toBe('Jane Doe, Bob Smith');
  });

  it('aggregates with count', async () => {
    const adapter = createAttioV3Adapter(attio.createOperations() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'create-company',
            type: 'attio:object',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [{ type: 'edge', edgeTypeId: ET_MSG_COMPANY, direction: 'outgoing', cardinality: { mode: 'first' } }],
            adapterConfig: { objectId: 'companies' },
            fieldMappings: [
              {
                targetField: 'team_size',
                traversal: [{ type: 'edge', edgeTypeId: ET_COMPANY_PERSON, direction: 'outgoing' }],
                selection: { mode: 'property', propertyTypeId: PT_NAME },
                aggregation: { function: 'count' },
              },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_MSG));

    expect(attio.records).toHaveLength(1);
    expect(attio.records[0].fields.team_size).toBe(2);
  });

  it('returns empty context when traversal yields nothing', async () => {
    const adapter = createAttioV3Adapter(attio.createOperations() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'traverse-empty',
            type: 'attio:object',
            knowledgeNodeTypeId: NT_PERSON,
            // Person nodes have no outgoing company edges
            traversal: [{ type: 'edge', edgeTypeId: ET_MSG_COMPANY, direction: 'outgoing' }],
            adapterConfig: { objectId: 'companies' },
            fieldMappings: [],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_PERSON_1));
    expect(attio.records).toHaveLength(0);
  });
});

// ===================================================================
// OUTPUT RUN LOGGING
// ===================================================================

describe('V3 Pipeline — Output Run Logging', () => {
  let attio: AttioSimulator;

  beforeEach(() => {
    mockGraph = buildDealflowGraph();
    attio = new AttioSimulator();
  });

  it('logs a run for each action node execution', async () => {
    const adapter = createAttioV3Adapter(attio.createOperations() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'create-company',
            type: 'attio:object',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [],
            adapterConfig: { objectId: 'companies' },
            fieldMappings: [
              { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));

    expect(mockGraph.outputRuns).toHaveLength(1);
    expect(mockGraph.outputRuns[0]).toMatchObject({
      teamId: TEAM_ID,
      pipelineOutputId: 'po-1',
      actionNodeId: 'create-company',
      contextNodeId: NODE_COMPANY_1,
      status: 'success',
    });
    expect(mockGraph.outputRuns[0].externalId).toBe(attio.records[0].recordId);
  });
});

// ===================================================================
// CHANGESET OVERLAY (extraction trigger context)
// ===================================================================

describe('V3 Pipeline — Changeset Overlay', () => {
  let attio: AttioSimulator;

  beforeEach(() => {
    mockGraph = buildDealflowGraph();
    attio = new AttioSimulator();
  });

  it('resolves edges from changeset overlay using temp→real ID mapping', async () => {
    const adapter = createAttioV3Adapter(attio.createOperations() as any);

    // Simulate extraction: temp IDs map to real node IDs
    const tempToRealId = new Map<string, NodeId>();
    tempToRealId.set('temp-msg', NODE_MSG);
    tempToRealId.set('temp-company-1', NODE_COMPANY_1);
    tempToRealId.set('temp-company-2', NODE_COMPANY_2);

    const changeset: Changeset = {
      messageNode: { tempId: 'temp-msg', nodeType: NT_MESSAGE as NodeTypeId },
      nodes: [
        { tempId: 'temp-msg', nodeType: NT_MESSAGE as NodeTypeId, resolution: { action: 'create' } },
        { tempId: 'temp-company-1', nodeType: NT_COMPANY as NodeTypeId, resolution: { action: 'create' } },
        { tempId: 'temp-company-2', nodeType: NT_COMPANY as NodeTypeId, resolution: { action: 'create' } },
      ],
      edges: [
        { sourceTempId: 'temp-msg', targetTempId: 'temp-company-1', edgeType: ET_MSG_COMPANY as any },
        { sourceTempId: 'temp-msg', targetTempId: 'temp-company-2', edgeType: ET_MSG_COMPANY as any },
      ],
      properties: [],
      evidence: [],
      edgeEvidence: [],
      nodeResources: [],
    };

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'create-company',
            type: 'attio:object',
            knowledgeNodeTypeId: NT_COMPANY,
            // Walk from message → company using overlay edges
            traversal: [{ type: 'edge', edgeTypeId: ET_MSG_COMPANY, direction: 'outgoing' }],
            adapterConfig: { objectId: 'companies' },
            fieldMappings: [
              { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
            ],
          }),
        ],
      },
    };

    await executeOutputs(
      config,
      adapter,
      makeContext(NODE_MSG, { changeset, tempToRealId }),
    );

    // Both companies created via overlay edges
    expect(attio.records).toHaveLength(2);
    expect(attio.records.map((r) => r.fields.name).sort()).toEqual(['Acme Corp', 'Beta Inc']);
  });

  it('linkBack step resolves temp IDs to real IDs for permanent graph traversal', async () => {
    const adapter = createAttioV3Adapter(attio.createOperations() as any);

    // Temp IDs from extraction, real IDs in the permanent graph
    const tempToRealId = new Map<string, NodeId>();
    tempToRealId.set('temp-msg', NODE_MSG);
    tempToRealId.set('temp-company-1', NODE_COMPANY_1);

    const changeset: Changeset = {
      messageNode: { tempId: 'temp-msg', nodeType: NT_MESSAGE as NodeTypeId },
      nodes: [
        { tempId: 'temp-msg', nodeType: NT_MESSAGE as NodeTypeId, resolution: { action: 'create' } },
        { tempId: 'temp-company-1', nodeType: NT_COMPANY as NodeTypeId, resolution: { action: 'match', existingNodeId: NODE_COMPANY_1, confidence: 1 } },
      ],
      edges: [
        { sourceTempId: 'temp-msg', targetTempId: 'temp-company-1', edgeType: ET_MSG_COMPANY as any },
      ],
      properties: [],
      evidence: [],
      edgeEvidence: [],
      nodeResources: [],
    };

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'create-company',
            type: 'attio:object',
            knowledgeNodeTypeId: NT_COMPANY,
            // Overlay: msg → company, then linkBack to punch into permanent graph, then walk permanent company → person
            traversal: [
              { type: 'edge', edgeTypeId: ET_MSG_COMPANY, direction: 'outgoing' },
            ],
            adapterConfig: { objectId: 'companies' },
            fieldMappings: [
              { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
            ],
            children: [
              {
                node: actionNode({
                  id: 'create-person',
                  type: 'attio:object',
                  knowledgeNodeTypeId: NT_PERSON,
                  // linkBack resolves to the permanent company node, then walks permanent edges
                  traversal: [
                    { type: 'linkBack' },
                    { type: 'edge', edgeTypeId: ET_COMPANY_PERSON, direction: 'outgoing' },
                  ],
                  adapterConfig: { objectId: 'people' },
                  fieldMappings: [
                    { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
                  ],
                }),
                relationship: { type: 'reference' },
              },
            ],
          }),
        ],
      },
    };

    await executeOutputs(
      config,
      adapter,
      makeContext(NODE_MSG, { changeset, tempToRealId }),
    );

    const companies = attio.records.filter((r) => r.objectId === 'companies');
    expect(companies).toHaveLength(1);
    expect(companies[0].fields.name).toBe('Acme Corp');

    // People resolved via permanent graph (company → person edges)
    const people = attio.records.filter((r) => r.objectId === 'people');
    expect(people).toHaveLength(2);
    expect(people.map((p) => p.fields.name).sort()).toEqual(['Bob Smith', 'Jane Doe']);
  });
});

// ===================================================================
// LINKED OBJECTS ROUND-TRIP
// ===================================================================

describe('V3 Pipeline — Linked Objects', () => {
  let attio: AttioSimulator;

  beforeEach(() => {
    mockGraph = buildDealflowGraph();
    attio = new AttioSimulator();
  });

  it('stores linked objects at linkBack pivot point', async () => {
    const adapter = createAttioV3Adapter(attio.createOperations() as any);

    const tempToRealId = new Map<string, NodeId>();
    tempToRealId.set('temp-msg', NODE_MSG);
    tempToRealId.set('temp-company-1', NODE_COMPANY_1);

    const changeset: Changeset = {
      messageNode: { tempId: 'temp-msg', nodeType: NT_MESSAGE as NodeTypeId },
      nodes: [
        { tempId: 'temp-msg', nodeType: NT_MESSAGE as NodeTypeId, resolution: { action: 'create' } },
        { tempId: 'temp-company-1', nodeType: NT_COMPANY as NodeTypeId, resolution: { action: 'create' } },
      ],
      edges: [
        { sourceTempId: 'temp-msg', targetTempId: 'temp-company-1', edgeType: ET_MSG_COMPANY as any },
      ],
      properties: [],
      evidence: [],
      edgeEvidence: [],
      nodeResources: [],
    };

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'create-company',
            type: 'attio:object',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [
              { type: 'edge', edgeTypeId: ET_MSG_COMPANY, direction: 'outgoing' },
              { type: 'linkBack' },
            ],
            adapterConfig: { objectId: 'companies' },
            fieldMappings: [
              { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
            ],
          }),
        ],
      },
    };

    await executeOutputs(
      config,
      adapter,
      makeContext(NODE_MSG, { changeset, tempToRealId }),
    );

    // Company created
    expect(attio.records).toHaveLength(1);

    // Linked object stored on the real company node (the linkBack pivot)
    const linkedObjects = mockGraph.loadLinkedObjects(NODE_COMPANY_1, TEAM_ID);
    expect(linkedObjects).toHaveLength(1);
    expect(linkedObjects[0].adapter_type.toLowerCase()).toBe('attio');
    expect(linkedObjects[0].action_node_id).toBe('create-company');
    expect(linkedObjects[0].external_id).toBe(attio.records[0].recordId);
  });

  it('linked objects are available in subsequent filter evaluations', async () => {
    const adapter = createAttioV3Adapter(attio.createOperations() as any);

    // Pre-seed a linked object to simulate a previous run
    mockGraph.storeLinkedObject({
      nodeId: NODE_COMPANY_1,
      teamId: TEAM_ID,
      adapterType: 'attio',
      actionNodeId: 'create-company',
      externalId: 'rec-existing-001',
    });

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'mutation', nodeTypeId: NT_COMPANY },
      actionTree: {
        roots: [
          branchNode({
            id: 'check-linked',
            filter: {
              traversal: [],
              selection: { mode: 'linked_object', adapter: 'attio', field: 'external_id' },
              operator: 'exists',
              value: true,
            },
            match: actionNode({
              id: 'update-existing',
              type: 'attio:object',
              knowledgeNodeTypeId: NT_COMPANY,
              traversal: [],
              adapterConfig: { objectId: 'companies' },
              fieldMappings: [
                { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
              ],
            }),
            noMatch: actionNode({
              id: 'create-new',
              type: 'attio:object',
              knowledgeNodeTypeId: NT_COMPANY,
              traversal: [],
              adapterConfig: { objectId: 'new-companies' },
              fieldMappings: [],
            }),
          }),
        ],
      },
    };

    // Company 1 has a linked object → should take match path
    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));

    expect(attio.records).toHaveLength(1);
    expect(attio.records[0].objectId).toBe('companies');
    expect(attio.records[0].fields.name).toBe('Acme Corp');
  });
});

// ===================================================================
// AFFINITY INTEGRATION TESTS
// ===================================================================

describe('V3 Pipeline — Affinity', () => {
  let affinity: AffinitySimulator;

  beforeEach(() => {
    mockGraph = buildDealflowGraph();
    affinity = new AffinitySimulator();
  });

  it('creates an organization from field values', async () => {
    const adapter = createAffinityV3Adapter(affinity.createOperations() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'create-org',
            type: 'affinity:organization',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [],
            adapterConfig: {
              name: { selection: { mode: 'property', propertyTypeId: PT_NAME }, traversal: [] },
            },
            fieldMappings: [],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));

    expect(affinity.organizations).toHaveLength(1);
    expect(affinity.organizations[0].name).toBe('Acme Corp');
  });

  it('creates org + person linked to it + list entry', async () => {
    const adapter = createAffinityV3Adapter(affinity.createOperations() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'create-org',
            type: 'affinity:organization',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [],
            adapterConfig: {
              name: { selection: { mode: 'property', propertyTypeId: PT_NAME }, traversal: [] },
            },
            fieldMappings: [],
            children: [
              {
                node: actionNode({
                  id: 'create-person',
                  type: 'affinity:person',
                  knowledgeNodeTypeId: NT_PERSON,
                  traversal: [{ type: 'edge', edgeTypeId: ET_COMPANY_PERSON, direction: 'outgoing', cardinality: { mode: 'first' } }],
                  adapterConfig: {
                    name: { selection: { mode: 'property', propertyTypeId: PT_NAME }, traversal: [] },
                    email: { selection: { mode: 'property', propertyTypeId: PT_EMAIL }, traversal: [] },
                  },
                  fieldMappings: [],
                }),
                relationship: { type: 'reference' },
              },
              {
                node: actionNode({
                  id: 'create-list-entry',
                  type: 'affinity:list-entry',
                  knowledgeNodeTypeId: NT_COMPANY,
                  traversal: [],
                  adapterConfig: { listId: 42 },
                  fieldMappings: [],
                }),
                relationship: { type: 'reference' },
              },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));

    // Organization created
    expect(affinity.organizations).toHaveLength(1);
    expect(affinity.organizations[0].name).toBe('Acme Corp');

    // Person linked to org
    expect(affinity.persons).toHaveLength(1);
    expect(affinity.persons[0].name).toBe('Jane Doe');
    expect(affinity.persons[0].orgId).toBe(affinity.organizations[0].id);

    // List entry linked to the org
    expect(affinity.listEntries).toHaveLength(1);
    expect(affinity.listEntries[0].listId).toBe(42);
    expect(affinity.listEntries[0].entityId).toBe(affinity.organizations[0].id);
  });

  it('creates org + note under it', async () => {
    const adapter = createAffinityV3Adapter(affinity.createOperations() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'create-org',
            type: 'affinity:organization',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [],
            adapterConfig: {
              name: { selection: { mode: 'property', propertyTypeId: PT_NAME }, traversal: [] },
            },
            fieldMappings: [],
            children: [
              {
                node: actionNode({
                  id: 'create-note',
                  type: 'affinity:note',
                  knowledgeNodeTypeId: NT_COMPANY,
                  traversal: [],
                  adapterConfig: {},
                  fieldMappings: [
                    { targetField: 'content', traversal: [], selection: { mode: 'property', propertyTypeId: PT_STAGE } },
                  ],
                }),
                relationship: { type: 'embed' },
              },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));

    expect(affinity.organizations).toHaveLength(1);
    expect(affinity.notes).toHaveLength(1);
    expect(affinity.notes[0].content).toBe('Series A');
    expect(affinity.notes[0].organizationId).toBe(affinity.organizations[0].id);
  });

  it('deduplicates organizations on re-run', async () => {
    const adapter = createAffinityV3Adapter(affinity.createOperations() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'create-org',
            type: 'affinity:organization',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [],
            adapterConfig: {
              name: { selection: { mode: 'property', propertyTypeId: PT_NAME }, traversal: [] },
            },
            fieldMappings: [],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));
    expect(affinity.organizations).toHaveLength(1);

    // Second run — same org should be deduplicated
    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));
    expect(affinity.organizations).toHaveLength(1);
  });

  it('traverses message → companies and creates one org per company', async () => {
    const adapter = createAffinityV3Adapter(affinity.createOperations() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'create-org',
            type: 'affinity:organization',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [{ type: 'edge', edgeTypeId: ET_MSG_COMPANY, direction: 'outgoing' }],
            adapterConfig: {
              name: { selection: { mode: 'property', propertyTypeId: PT_NAME }, traversal: [] },
            },
            fieldMappings: [],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_MSG));

    expect(affinity.organizations).toHaveLength(2);
    expect(affinity.organizations.map((o) => o.name).sort()).toEqual(['Acme Corp', 'Beta Inc']);
  });
});

// ===================================================================
// AIRTABLE INTEGRATION TESTS
// ===================================================================

describe('V3 Pipeline — Airtable', () => {
  let airtable: AirtableSimulator;

  beforeEach(() => {
    mockGraph = buildDealflowGraph();
    airtable = new AirtableSimulator();
  });

  it('creates a record with resolved field values', async () => {
    const adapter = createAirtableV3Adapter(airtable.createClient() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'create-record',
            type: 'airtable:record',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [],
            adapterConfig: { baseId: 'app123', tableId: 'tbl456' },
            fieldMappings: [
              { targetField: 'Name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
              { targetField: 'Stage', traversal: [], selection: { mode: 'property', propertyTypeId: PT_STAGE } },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));

    expect(airtable.records).toHaveLength(1);
    expect(airtable.records[0].baseId).toBe('app123');
    expect(airtable.records[0].tableId).toBe('tbl456');
    expect(airtable.records[0].fields.Name).toBe('Acme Corp');
    expect(airtable.records[0].fields.Stage).toBe('Series A');
  });

  it('creates parent + child records linked via linkToParentField', async () => {
    const adapter = createAirtableV3Adapter(airtable.createClient() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'create-company-record',
            type: 'airtable:record',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [],
            adapterConfig: { baseId: 'app123', tableId: 'tblCompanies' },
            fieldMappings: [
              { targetField: 'Name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
            ],
            children: [
              {
                node: actionNode({
                  id: 'create-person-record',
                  type: 'airtable:record',
                  knowledgeNodeTypeId: NT_PERSON,
                  traversal: [{ type: 'edge', edgeTypeId: ET_COMPANY_PERSON, direction: 'outgoing' }],
                  adapterConfig: {
                    baseId: 'app123',
                    tableId: 'tblPeople',
                    linkToParentField: 'Company',
                  },
                  fieldMappings: [
                    { targetField: 'Name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
                    { targetField: 'Email', traversal: [], selection: { mode: 'property', propertyTypeId: PT_EMAIL } },
                  ],
                }),
                relationship: { type: 'reference' },
              },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));

    // Parent company record
    const companyRecords = airtable.getRecordsInTable('app123', 'tblCompanies');
    expect(companyRecords).toHaveLength(1);
    expect(companyRecords[0].fields.Name).toBe('Acme Corp');

    // Child person records linked to parent via linkToParentField
    const personRecords = airtable.getRecordsInTable('app123', 'tblPeople');
    expect(personRecords).toHaveLength(2);
    expect(personRecords.map((r) => r.fields.Name).sort()).toEqual(['Bob Smith', 'Jane Doe']);

    // Each person record has a link back to the parent company record
    for (const person of personRecords) {
      expect(person.fields.Company).toEqual([companyRecords[0].id]);
    }
  });

  it('creates one record per traversed entity', async () => {
    const adapter = createAirtableV3Adapter(airtable.createClient() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'create-per-company',
            type: 'airtable:record',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [{ type: 'edge', edgeTypeId: ET_MSG_COMPANY, direction: 'outgoing' }],
            adapterConfig: { baseId: 'app123', tableId: 'tblDeals' },
            fieldMappings: [
              { targetField: 'Company', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
              { targetField: 'Stage', traversal: [], selection: { mode: 'property', propertyTypeId: PT_STAGE } },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_MSG));

    expect(airtable.records).toHaveLength(2);
    expect(airtable.records.map((r) => r.fields.Company).sort()).toEqual(['Acme Corp', 'Beta Inc']);
  });

  it('skips record creation when all fields resolve to null', async () => {
    const adapter = createAirtableV3Adapter(airtable.createClient() as any);

    // Person 1 has no "amount" property — all fields resolve to null → skip
    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'create-empty',
            type: 'airtable:record',
            knowledgeNodeTypeId: NT_PERSON,
            traversal: [],
            adapterConfig: { baseId: 'app123', tableId: 'tblTest' },
            fieldMappings: [
              { targetField: 'Amount', traversal: [], selection: { mode: 'property', propertyTypeId: PT_AMOUNT } },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_PERSON_1));

    expect(airtable.records).toHaveLength(0);
  });
});

// ===================================================================
// GOOGLE SHEETS INTEGRATION TESTS
// ===================================================================

describe('V3 Pipeline — Google Sheets', () => {
  let sheets: GoogleSheetsSimulator;

  beforeEach(() => {
    mockGraph = buildDealflowGraph();
    sheets = new GoogleSheetsSimulator();
  });

  it('adds a row with resolved field values', async () => {
    const adapter = createGoogleSheetsV3Adapter(sheets.createClient() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'add-row',
            type: 'google_sheets:row',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [],
            adapterConfig: { spreadsheetId: 'sheet-abc', sheetId: 0 },
            fieldMappings: [
              { targetField: 'Company Name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
              { targetField: 'Stage', traversal: [], selection: { mode: 'property', propertyTypeId: PT_STAGE } },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));

    expect(sheets.rows).toHaveLength(1);
    expect(sheets.rows[0].spreadsheetId).toBe('sheet-abc');
    expect(sheets.rows[0].sheetId).toBe(0);
    expect(sheets.rows[0].row['Company Name']).toBe('Acme Corp');
    expect(sheets.rows[0].row['Stage']).toBe('Series A');
  });

  it('adds a table-row using field mappings for column names', async () => {
    sheets.setTableColumns('sheet-abc', 'table-1', [
      { columnIndex: 0, columnName: 'name' },
      { columnIndex: 1, columnName: 'stage' },
    ]);
    const adapter = createGoogleSheetsV3Adapter(sheets.createClient() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'add-table-row',
            type: 'google_sheets:table-row',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [],
            adapterConfig: {
              spreadsheetId: 'sheet-abc',
              tableId: 'table-1',
            },
            fieldMappings: [
              { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
              { targetField: 'stage', traversal: [], selection: { mode: 'property', propertyTypeId: PT_STAGE } },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));

    expect(sheets.tableRows).toHaveLength(1);
    expect(sheets.tableRows[0].spreadsheetId).toBe('sheet-abc');
    expect(sheets.tableRows[0].tableId).toBe('table-1');
    expect(sheets.tableRows[0].valuesByColumn).toEqual([
      { columnIndex: 0, value: 'Acme Corp' },
      { columnIndex: 1, value: 'Series A' },
    ]);
  });

  it('adds one row per traversed entity', async () => {
    const adapter = createGoogleSheetsV3Adapter(sheets.createClient() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'add-per-company',
            type: 'google_sheets:row',
            knowledgeNodeTypeId: NT_COMPANY,
            traversal: [{ type: 'edge', edgeTypeId: ET_MSG_COMPANY, direction: 'outgoing' }],
            adapterConfig: { spreadsheetId: 'sheet-abc', sheetId: 0 },
            fieldMappings: [
              { targetField: 'Name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME } },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_MSG));

    expect(sheets.rows).toHaveLength(2);
    const names = sheets.rows.map((r) => r.row['Name']).sort();
    expect(names).toEqual(['Acme Corp', 'Beta Inc']);
  });

  it('skips row when no fields resolve', async () => {
    const adapter = createGoogleSheetsV3Adapter(sheets.createClient() as any);

    const config: OutputV3Config = {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
      actionTree: {
        roots: [
          actionNode({
            id: 'add-empty-row',
            type: 'google_sheets:row',
            knowledgeNodeTypeId: NT_PERSON,
            traversal: [],
            adapterConfig: { spreadsheetId: 'sheet-abc', sheetId: 0 },
            fieldMappings: [
              { targetField: 'Amount', traversal: [], selection: { mode: 'property', propertyTypeId: PT_AMOUNT } },
            ],
          }),
        ],
      },
    };

    await executeOutputs(config, adapter, makeContext(NODE_PERSON_1));

    // Person has no amount property → empty row → skipped
    expect(sheets.rows).toHaveLength(0);
  });
});

// ===================================================================
// ENTITY RESOLUTION TESTS
// ===================================================================

describe('V3 Pipeline — Entity Resolution', () => {
  describe('Attio', () => {
    let attio: AttioSimulator;

    beforeEach(() => {
      mockGraph = buildDealflowGraph();
      attio = new AttioSimulator();
    });

    it('Tier 1: Attio isUnique attribute finds existing record via filterRecords', async () => {
      // Set up an attribute with isUnique
      attio.addAttribute({ objectId: 'companies', id: 'attr-domain', name: 'Domain', apiSlug: 'domain', type: 'domain', isUnique: true });
      attio.addAttribute({ objectId: 'companies', id: 'attr-name', name: 'Name', apiSlug: 'name', type: 'text' });

      // Pre-populate a record with matching domain
      attio.records.push({ objectId: 'companies', recordId: 'existing-1', fields: { name: 'Old Name', domain: 'acme.com' } });

      // Add domain property to the graph
      mockGraph.addPropertyType('pt-domain', 'domain');
      mockGraph.addProperty(NODE_COMPANY_1, 'pt-domain', TEAM_ID, 'acme.com');

      const adapter = createAttioV3Adapter(attio.createOperations() as any);

      const config: OutputV3Config = {
        version: 3,
        trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
        actionTree: {
          roots: [
            actionNode({
              id: 'create-company',
              type: 'attio:object',
              adapterConfig: { objectId: 'companies' },
              fieldMappings: [
                { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME }, identity: 'fuzzy' },
                { targetField: 'domain', traversal: [], selection: { mode: 'property', propertyTypeId: 'pt-domain' }, identity: 'unique' },
              ],
            }),
          ],
        },
      };

      await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));

      // Should update existing record, not create new
      expect(attio.records).toHaveLength(1);
      expect(attio.records[0].recordId).toBe('existing-1');
      expect(attio.records[0].fields.name).toBe('Acme Corp');
    });

    it('Tier 2: identity unique field mapping finds existing via filterRecords', async () => {
      // Attio attribute exists but is NOT isUnique on Attio's side
      attio.addAttribute({ objectId: 'companies', id: 'attr-email', name: 'Email', apiSlug: 'email', type: 'email-address' });
      attio.addAttribute({ objectId: 'companies', id: 'attr-name', name: 'Name', apiSlug: 'name', type: 'text' });

      // Pre-populate a record with matching email
      attio.records.push({ objectId: 'companies', recordId: 'existing-2', fields: { name: 'Some Company', email: 'jane@acme.com' } });

      const adapter = createAttioV3Adapter(attio.createOperations() as any);

      const config: OutputV3Config = {
        version: 3,
        trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
        actionTree: {
          roots: [
            actionNode({
              id: 'create-company',
              type: 'attio:object',
              knowledgeNodeTypeId: NT_PERSON,
              adapterConfig: { objectId: 'companies' },
              fieldMappings: [
                { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME }, identity: 'fuzzy' },
                { targetField: 'email', traversal: [], selection: { mode: 'property', propertyTypeId: PT_EMAIL }, identity: 'unique' },
              ],
            }),
          ],
        },
      };

      await executeOutputs(config, adapter, makeContext(NODE_PERSON_1));

      // Should find existing via identity unique email filter
      expect(attio.records).toHaveLength(1);
      expect(attio.records[0].recordId).toBe('existing-2');
      expect(attio.records[0].fields.email).toBe('jane@acme.com');
    });

    it('Tier 3: identity fuzzy field mapping falls back to searchRecords', async () => {
      attio.addAttribute({ objectId: 'companies', id: 'attr-name', name: 'Name', apiSlug: 'name', type: 'text' });

      // Pre-populate a record with fuzzy-matchable name
      attio.records.push({ objectId: 'companies', recordId: 'existing-3', fields: { name: 'Acme Corp' } });

      const adapter = createAttioV3Adapter(attio.createOperations() as any);

      const config: OutputV3Config = {
        version: 3,
        trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
        actionTree: {
          roots: [
            actionNode({
              id: 'create-company',
              type: 'attio:object',
              adapterConfig: { objectId: 'companies' },
              fieldMappings: [
                { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME }, identity: 'fuzzy' },
                { targetField: 'stage', traversal: [], selection: { mode: 'property', propertyTypeId: PT_STAGE }, identity: 'none' },
              ],
            }),
          ],
        },
      };

      await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));

      // Should find existing via searchRecords (fuzzy name match)
      expect(attio.records).toHaveLength(1);
      expect(attio.records[0].recordId).toBe('existing-3');
      expect(attio.records[0].fields.stage).toBe('Series A');
    });

    it('no identity fields creates new record', async () => {
      attio.addAttribute({ objectId: 'companies', id: 'attr-name', name: 'Name', apiSlug: 'name', type: 'text' });

      const adapter = createAttioV3Adapter(attio.createOperations() as any);

      const config: OutputV3Config = {
        version: 3,
        trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
        actionTree: {
          roots: [
            actionNode({
              id: 'create-company',
              type: 'attio:object',
              adapterConfig: { objectId: 'companies' },
              fieldMappings: [
                { targetField: 'name', traversal: [], selection: { mode: 'property', propertyTypeId: PT_NAME }, identity: 'none' },
                { targetField: 'stage', traversal: [], selection: { mode: 'property', propertyTypeId: PT_STAGE }, identity: 'none' },
              ],
            }),
          ],
        },
      };

      await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));

      // No identity fields → no search → creates new
      expect(attio.records).toHaveLength(1);
      expect(attio.records[0].fields.name).toBe('Acme Corp');
    });
  });

  describe('Affinity', () => {
    let affinity: AffinitySimulator;

    beforeEach(() => {
      mockGraph = buildDealflowGraph();
      affinity = new AffinitySimulator();
    });

    it('identity unique domain field deduplicates organizations', async () => {
      // Pre-populate an org with matching domain but different name
      affinity.organizations.push({ id: 999, name: 'Different Name', domain: 'acme.com' });

      mockGraph.addPropertyType('pt-domain', 'domain');
      mockGraph.addProperty(NODE_COMPANY_1, 'pt-domain', TEAM_ID, 'acme.com');

      const adapter = createAffinityV3Adapter(affinity.createOperations() as any);

      const config: OutputV3Config = {
        version: 3,
        trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
        actionTree: {
          roots: [
            actionNode({
              id: 'create-org',
              type: 'affinity:organization',
              adapterConfig: {
                name: { selection: { mode: 'property', propertyTypeId: PT_NAME }, traversal: [] },
                domain: { selection: { mode: 'property', propertyTypeId: 'pt-domain' }, traversal: [] },
              },
              fieldMappings: [],
            }),
          ],
        },
      };

      await executeOutputs(config, adapter, makeContext(NODE_COMPANY_1));

      // Should match existing org by domain, not create new
      expect(affinity.organizations).toHaveLength(1);
      expect(affinity.organizations[0].id).toBe(999);
    });

    it('identity unique email field deduplicates persons', async () => {
      // Pre-populate a person with matching email but different name
      affinity.persons.push({ id: 888, name: 'J. Doe', email: 'jane@acme.com', orgId: undefined });

      const adapter = createAffinityV3Adapter(affinity.createOperations() as any);

      const config: OutputV3Config = {
        version: 3,
        trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
        actionTree: {
          roots: [
            actionNode({
              id: 'create-person',
              type: 'affinity:person',
              knowledgeNodeTypeId: NT_PERSON,
              adapterConfig: {
                name: { selection: { mode: 'property', propertyTypeId: PT_NAME }, traversal: [] },
                email: { selection: { mode: 'property', propertyTypeId: PT_EMAIL }, traversal: [] },
              },
              fieldMappings: [],
            }),
          ],
        },
      };

      await executeOutputs(config, adapter, makeContext(NODE_PERSON_1));

      // Should match existing person by email
      expect(affinity.persons).toHaveLength(1);
      expect(affinity.persons[0].id).toBe(888);
    });

    it('identity fuzzy name field finds existing via name match', async () => {
      // Pre-populate a person with matching name
      affinity.persons.push({ id: 777, name: 'Jane Doe', email: null, orgId: undefined });

      const adapter = createAffinityV3Adapter(affinity.createOperations() as any);

      const config: OutputV3Config = {
        version: 3,
        trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
        actionTree: {
          roots: [
            actionNode({
              id: 'create-person',
              type: 'affinity:person',
              knowledgeNodeTypeId: NT_PERSON,
              adapterConfig: {
                name: { selection: { mode: 'property', propertyTypeId: PT_NAME }, traversal: [] },
              },
              fieldMappings: [],
            }),
          ],
        },
      };

      await executeOutputs(config, adapter, makeContext(NODE_PERSON_1));

      // Should match by name
      expect(affinity.persons).toHaveLength(1);
      expect(affinity.persons[0].id).toBe(777);
    });
  });

  describe('Skip visibility', () => {
    let slack: SlackSimulator;

    beforeEach(() => {
      mockGraph = buildDealflowGraph();
      slack = new SlackSimulator();
      slack.addMembership('C001');
    });

    it('logs skipped status when adapter returns skipped', async () => {
      const adapter = createSlackV3Adapter(slack.createClient() as any);

      const config: OutputV3Config = {
        version: 3,
        trigger: { type: 'extraction', messageNodeTypeId: NT_MESSAGE },
        actionTree: {
          roots: [
            actionNode({
              id: 'send-message',
              type: 'slack:message',
              knowledgeNodeTypeId: NT_PERSON,
              adapterConfig: { channelId: 'C001' },
              fieldMappings: [
                // PT_AMOUNT doesn't exist on person node → text resolves to null → skipped
                { targetField: 'text', traversal: [], selection: { mode: 'property', propertyTypeId: PT_AMOUNT } },
              ],
            }),
          ],
        },
      };

      // NODE_PERSON_2 has no amount property → text resolves to null → message skipped
      await executeOutputs(config, adapter, makeContext(NODE_PERSON_2));

      // Message was not sent
      expect(slack.messages).toHaveLength(0);

      // But a run was logged as skipped
      const skippedRuns = mockGraph.outputRuns.filter((r) => r.status === 'skipped');
      expect(skippedRuns).toHaveLength(1);
      expect(skippedRuns[0].actionNodeId).toBe('send-message');
    });
  });
});
