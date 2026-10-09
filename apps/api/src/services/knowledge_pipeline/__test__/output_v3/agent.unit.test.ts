
jest.mock('../../../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { OntologySummary, AgentContext, AdapterMetadataProvider } from '../../output_v3/agent';

import { AgentToolSession, ConfigState, validate } from '../../output_v3/agent';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeOntology(): OntologySummary {
  return {
    nodeTypes: [
      { id: 'nt-msg', name: 'Dealflow Message', description: null, category: 'message' },
      { id: 'nt-org', name: 'Organisation', description: null, category: 'object' },
      { id: 'nt-person', name: 'Person', description: null, category: 'object' },
      { id: 'nt-round', name: 'Funding Round', description: null, category: 'scoped_object' },
    ],
    edgeTypes: [
      {
        id: 'et-msg-org',
        outbound_name: 'mentions_organisation',
        inbound_name: 'mentioned_in',
        description: null,
        source_node_type_id: 'nt-msg',
        target_node_type_id: 'nt-org',
        required: false,
        scopes: false,
        edge_group: null,
      },
      {
        id: 'et-org-round',
        outbound_name: 'has_round',
        inbound_name: 'round_of',
        description: null,
        source_node_type_id: 'nt-org',
        target_node_type_id: 'nt-round',
        required: false,
        scopes: true,
        edge_group: null,
      },
      {
        id: 'et-msg-person',
        outbound_name: 'mentions_person',
        inbound_name: 'mentioned_in',
        description: null,
        source_node_type_id: 'nt-msg',
        target_node_type_id: 'nt-person',
        required: false,
        scopes: false,
        edge_group: null,
      },
    ],
    propertyTypes: [
      { id: 'pt-name', node_type_id: 'nt-org', edge_type_id: null, name: 'Name', description: null, value_type: 'text', identity: 'primary', evaluation_strategy: 'manual', enum_values: null },
      { id: 'pt-website', node_type_id: 'nt-org', edge_type_id: null, name: 'Website', description: null, value_type: 'text', identity: 'secondary', evaluation_strategy: 'manual', enum_values: null },
      { id: 'pt-stage', node_type_id: 'nt-org', edge_type_id: null, name: 'Stage', description: null, value_type: 'text', identity: 'none', evaluation_strategy: 'manual', enum_values: ['Seed', 'Series A', 'Series B'] },
      { id: 'pt-person-name', node_type_id: 'nt-person', edge_type_id: null, name: 'Name', description: null, value_type: 'text', identity: 'primary', evaluation_strategy: 'manual', enum_values: null },
      { id: 'pt-round-size', node_type_id: 'nt-round', edge_type_id: null, name: 'Round Size', description: null, value_type: 'number', identity: 'none', evaluation_strategy: 'manual', enum_values: null },
      { id: 'pt-edge-weight', node_type_id: null, edge_type_id: 'et-msg-org', name: 'Confidence', description: null, value_type: 'number', identity: 'none', evaluation_strategy: 'manual', enum_values: null },
    ],
  };
}

const mockAdapterMetadata: AdapterMetadataProvider = {
  async getObjects() {
    return [
      { id: 'obj-companies', name: 'Companies', apiSlug: 'companies' },
      { id: 'obj-people', name: 'People', apiSlug: 'people' },
    ];
  },
  async getAttributes(_credId, objectId) {
    if (objectId === 'obj-companies') {
      return [
        { id: 'attr-name', name: 'Name', apiSlug: 'name', type: 'text', isRequired: true, isUnique: false },
        { id: 'attr-domains', name: 'Domains', apiSlug: 'domains', type: 'domain', isRequired: false, isUnique: true },
        { id: 'attr-stage', name: 'Stage', apiSlug: 'stage', type: 'select', isRequired: false, isUnique: false },
      ];
    }
    return [];
  },
  async getAttributeOptions(_credId, _objectId, attributeId) {
    if (attributeId === 'attr-stage') {
      return [
        { id: 'opt-lead', name: 'Lead' },
        { id: 'opt-qualified', name: 'Qualified' },
        { id: 'opt-negotiation', name: 'Negotiation' },
      ];
    }
    return [];
  },
  async getChannels() {
    return [{ id: 'C123', name: '#dealflow' }];
  },
  async getLists() {
    return [{ id: 'list-deals', name: 'Deal Pipeline' }];
  },
};

function makeContext(): AgentContext {
  return {
    ontology: makeOntology(),
    adapterMetadata: mockAdapterMetadata,
    credentialsId: 'creds-1',
    adapterType: 'ATTIO',
  };
}

// ---------------------------------------------------------------------------
// ConfigState
// ---------------------------------------------------------------------------

describe('ConfigState', () => {
  it('creates an empty config', () => {
    const state = new ConfigState(makeOntology());
    expect(state.config.version).toBe(3);
    expect(state.config.actionTree.roots).toHaveLength(0);
  });

  it('sets trigger', () => {
    const state = new ConfigState(makeOntology());
    state.setTrigger({ type: 'extraction', messageNodeTypeId: 'nt-msg' });
    expect(state.config.trigger).toEqual({ type: 'extraction', messageNodeTypeId: 'nt-msg' });
  });

  it('adds root action and indexes it', () => {
    const state = new ConfigState(makeOntology());
    const id = state.addRootAction('attio:object');
    expect(state.config.actionTree.roots).toHaveLength(1);
    expect(state.getActionNode(id)).toBeDefined();
    expect(state.getActionNode(id)!.type).toBe('attio:object');
  });

  it('adds child action with parent reference', () => {
    const state = new ConfigState(makeOntology());
    const rootId = state.addRootAction('attio:object');
    const childId = state.addChildAction(rootId, 'attio:note');
    expect(state.getActionNode(rootId)!.children).toHaveLength(1);
    expect(state.getParentId(childId)).toBe(rootId);
  });

  it('auto-resolves knowledgeNodeTypeId from traversal', () => {
    const state = new ConfigState(makeOntology());
    state.setTrigger({ type: 'extraction', messageNodeTypeId: 'nt-msg' });
    const id = state.addRootAction('attio:object');
    state.setTraversal(id, [{ type: 'edge', edgeTypeId: 'et-msg-org', direction: 'outgoing' }]);
    expect(state.getActionNode(id)!.knowledgeNodeTypeId).toBe('nt-org');
  });

  it('resolves multi-step traversal', () => {
    const state = new ConfigState(makeOntology());
    state.setTrigger({ type: 'extraction', messageNodeTypeId: 'nt-msg' });
    const id = state.addRootAction('attio:object');
    state.setTraversal(id, [
      { type: 'edge', edgeTypeId: 'et-msg-org', direction: 'outgoing' },
      { type: 'edge', edgeTypeId: 'et-org-round', direction: 'outgoing' },
    ]);
    expect(state.getActionNode(id)!.knowledgeNodeTypeId).toBe('nt-round');
  });

  it('removes node from tree', () => {
    const state = new ConfigState(makeOntology());
    const rootId = state.addRootAction('attio:object');
    state.removeNode(rootId);
    expect(state.config.actionTree.roots).toHaveLength(0);
    expect(state.getNode(rootId)).toBeUndefined();
  });

  it('adds and configures branch', () => {
    const state = new ConfigState(makeOntology());
    const branchId = state.addBranch();
    expect(state.getBranchNode(branchId)).toBeDefined();

    const matchId = state.setBranchChild(branchId, 'match', 'attio:object');
    expect(state.getBranchNode(branchId)!.match).toBeDefined();
    expect(state.getActionNode(matchId)).toBeDefined();
  });

  it('adds field mappings', () => {
    const state = new ConfigState(makeOntology());
    const id = state.addRootAction('attio:object');
    state.addFieldMapping(id, {
      targetField: 'name',
      traversal: [],
      selection: { mode: 'property', propertyTypeId: 'pt-name' },
    });
    expect(state.getActionNode(id)!.fieldMappings).toHaveLength(1);
  });

  it('updates field mapping', () => {
    const state = new ConfigState(makeOntology());
    const id = state.addRootAction('attio:object');
    state.addFieldMapping(id, {
      targetField: 'name',
      traversal: [],
      selection: { mode: 'property', propertyTypeId: 'pt-name' },
    });
    state.updateFieldMapping(id, 0, { identity: 'unique' });
    expect(state.getActionNode(id)!.fieldMappings[0].identity).toBe('unique');
  });

  it('removes field mapping', () => {
    const state = new ConfigState(makeOntology());
    const id = state.addRootAction('attio:object');
    state.addFieldMapping(id, {
      targetField: 'name',
      traversal: [],
      selection: { mode: 'property', propertyTypeId: 'pt-name' },
    });
    state.removeFieldMapping(id, 0);
    expect(state.getActionNode(id)!.fieldMappings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

describe('validate', () => {
  const ontology = makeOntology();

  it('returns errors for empty config', () => {
    const config = {
      version: 3 as const,
      trigger: { type: 'extraction' as const, messageNodeTypeId: '' },
      actionTree: { roots: [] },
    };
    const result = validate(config, ontology);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('messageNodeTypeId'))).toBe(true);
    expect(result.errors.some((e) => e.message.includes('no root nodes'))).toBe(true);
  });

  it('validates a complete config', () => {
    const config = {
      version: 3 as const,
      trigger: { type: 'extraction' as const, messageNodeTypeId: 'nt-msg' },
      actionTree: {
        roots: [
          {
            kind: 'action' as const,
            id: 'action-1',
            type: 'attio:object',
            knowledgeNodeTypeId: 'nt-org',
            traversal: [{ type: 'edge' as const, edgeTypeId: 'et-msg-org', direction: 'outgoing' as const }],
            adapterConfig: { objectId: 'obj-companies' },
            fieldMappings: [
              {
                targetField: 'name',
                traversal: [],
                selection: { mode: 'property' as const, propertyTypeId: 'pt-name' },
                identity: 'fuzzy' as const,
              },
            ],
            children: [],
          },
        ],
      },
    };

    const result = validate(config, ontology);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('catches missing adapter config', () => {
    const config = {
      version: 3 as const,
      trigger: { type: 'extraction' as const, messageNodeTypeId: 'nt-msg' },
      actionTree: {
        roots: [
          {
            kind: 'action' as const,
            id: 'action-1',
            type: 'attio:object',
            knowledgeNodeTypeId: 'nt-org',
            traversal: [{ type: 'edge' as const, edgeTypeId: 'et-msg-org', direction: 'outgoing' as const }],
            adapterConfig: {},
            fieldMappings: [],
            children: [],
          },
        ],
      },
    };

    const result = validate(config, ontology);
    expect(result.errors.some((e) => e.message.includes('objectId'))).toBe(true);
  });

  it('warns about missing identity fields', () => {
    const config = {
      version: 3 as const,
      trigger: { type: 'extraction' as const, messageNodeTypeId: 'nt-msg' },
      actionTree: {
        roots: [
          {
            kind: 'action' as const,
            id: 'action-1',
            type: 'attio:object',
            knowledgeNodeTypeId: 'nt-org',
            traversal: [{ type: 'edge' as const, edgeTypeId: 'et-msg-org', direction: 'outgoing' as const }],
            adapterConfig: { objectId: 'obj-companies' },
            fieldMappings: [
              {
                targetField: 'name',
                traversal: [],
                selection: { mode: 'property' as const, propertyTypeId: 'pt-name' },
              },
            ],
            children: [],
          },
        ],
      },
    };

    const result = validate(config, ontology);
    expect(result.warnings.some((w) => w.message.includes('identity'))).toBe(true);
  });

  it('catches missing parentReferenceField on child attio:object', () => {
    const config = {
      version: 3 as const,
      trigger: { type: 'extraction' as const, messageNodeTypeId: 'nt-msg' },
      actionTree: {
        roots: [
          {
            kind: 'action' as const,
            id: 'parent-action',
            type: 'attio:object',
            knowledgeNodeTypeId: 'nt-org',
            traversal: [{ type: 'edge' as const, edgeTypeId: 'et-msg-org', direction: 'outgoing' as const }],
            adapterConfig: { objectId: 'obj-companies' },
            fieldMappings: [
              {
                targetField: 'name',
                traversal: [],
                selection: { mode: 'property' as const, propertyTypeId: 'pt-name' },
                identity: 'fuzzy' as const,
              },
            ],
            children: [
              {
                node: {
                  kind: 'action' as const,
                  id: 'child-action',
                  type: 'attio:object',
                  knowledgeNodeTypeId: 'nt-round',
                  traversal: [{ type: 'edge' as const, edgeTypeId: 'et-org-round', direction: 'outgoing' as const }],
                  adapterConfig: { objectId: 'obj-deals' },
                  fieldMappings: [],
                  children: [],
                },
                relationship: { type: 'reference' as const },
              },
            ],
          },
        ],
      },
    };

    const result = validate(config, ontology);
    expect(result.errors.some((e) => e.message.includes('parentReferenceField'))).toBe(true);
  });

  it('accepts child attio:object with parentReferenceField', () => {
    const config = {
      version: 3 as const,
      trigger: { type: 'extraction' as const, messageNodeTypeId: 'nt-msg' },
      actionTree: {
        roots: [
          {
            kind: 'action' as const,
            id: 'parent-action',
            type: 'attio:object',
            knowledgeNodeTypeId: 'nt-org',
            traversal: [{ type: 'edge' as const, edgeTypeId: 'et-msg-org', direction: 'outgoing' as const }],
            adapterConfig: { objectId: 'obj-companies' },
            fieldMappings: [
              {
                targetField: 'name',
                traversal: [],
                selection: { mode: 'property' as const, propertyTypeId: 'pt-name' },
                identity: 'fuzzy' as const,
              },
            ],
            children: [
              {
                node: {
                  kind: 'action' as const,
                  id: 'child-action',
                  type: 'attio:object',
                  knowledgeNodeTypeId: 'nt-round',
                  traversal: [{ type: 'edge' as const, edgeTypeId: 'et-org-round', direction: 'outgoing' as const }],
                  adapterConfig: { objectId: 'obj-deals', parentReferenceField: { fieldId: 'company' } },
                  fieldMappings: [],
                  children: [],
                },
                relationship: { type: 'reference' as const },
              },
            ],
          },
        ],
      },
    };

    const result = validate(config, ontology);
    expect(result.errors.some((e) => e.message.includes('parentReferenceField'))).toBe(false);
  });

  it('validates branch with missing children', () => {
    const config = {
      version: 3 as const,
      trigger: { type: 'extraction' as const, messageNodeTypeId: 'nt-msg' },
      actionTree: {
        roots: [
          {
            kind: 'branch' as const,
            id: 'branch-1',
            filter: { traversal: [], selection: { mode: 'property' as const, propertyTypeId: 'pt-name' }, operator: 'exists' as const },
          },
        ],
      },
    };

    const result = validate(config, ontology);
    expect(result.errors.some((e) => e.message.includes('no match or noMatch'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AgentToolSession — end-to-end flow
// ---------------------------------------------------------------------------

describe('AgentToolSession', () => {
  it('builds a complete Attio output config step by step', async () => {
    const session = new AgentToolSession(makeContext());

    // 1. Query ontology
    const ontology = session.getOntology();
    expect(ontology.nodeTypes.length).toBeGreaterThan(0);

    // 2. Query adapter node types
    const adapterTypes = session.getAdapterNodeTypes({ adapter: 'attio' });
    expect(adapterTypes.types.some((t) => t.type === 'attio:object')).toBe(true);

    // 3. Set trigger
    const triggerResult = session.setTrigger({ type: 'extraction', messageNodeTypeId: 'nt-msg' });
    expect(triggerResult.config.trigger.type).toBe('extraction');

    // 4. Add root action
    const rootResult = session.addRootAction({ nodeType: 'attio:object' });
    const actionId = rootResult.nodeId!;
    expect(actionId).toBeDefined();
    // Should have errors (no objectId, no knowledgeNodeTypeId)
    expect(rootResult.errors.length).toBeGreaterThan(0);

    // 5. Query adapter objects
    const objects = await session.getAdapterObjects();
    expect(objects.objects.some((o) => o.name === 'Companies')).toBe(true);

    // 6. Set adapter config
    session.setAdapterConfig({ nodeId: actionId, key: 'objectId', value: 'obj-companies' });

    // 7. Query edges from message type
    const edges = session.getEdgesFrom({ nodeTypeId: 'nt-msg' });
    expect(edges.outgoing.some((e) => e.targetTypeName === 'Organisation')).toBe(true);

    // 8. Set traversal
    const travResult = session.setTraversal({
      nodeId: actionId,
      steps: [{ type: 'edge', edgeTypeId: 'et-msg-org', direction: 'outgoing' }],
    });
    // knowledgeNodeTypeId should now be resolved
    expect(travResult.config.actionTree.roots[0]).toMatchObject({
      kind: 'action',
      knowledgeNodeTypeId: 'nt-org',
    });

    // 9. Query properties on Organisation
    const props = session.getPropertiesOf({ nodeTypeId: 'nt-org' });
    expect(props.properties.some((p) => p.name === 'Name')).toBe(true);

    // 10. Query adapter attributes
    const attrs = await session.getAdapterAttributes({ objectId: 'obj-companies' });
    expect(attrs.attributes.some((a) => a.apiSlug === 'name')).toBe(true);

    // 11. Add field mappings
    session.addFieldMapping({
      nodeId: actionId,
      targetField: 'name',
      selection: { mode: 'property', propertyTypeId: 'pt-name' },
      identity: 'fuzzy',
    });

    session.addFieldMapping({
      nodeId: actionId,
      targetField: 'domains',
      selection: { mode: 'property', propertyTypeId: 'pt-website' },
      identity: 'unique',
    });

    // 12. Get final config
    const finalResult = session.getCurrentConfig();
    expect(finalResult.errors).toHaveLength(0);
    expect(finalResult.config.actionTree.roots).toHaveLength(1);

    const action = finalResult.config.actionTree.roots[0];
    expect(action.kind).toBe('action');
    if (action.kind === 'action') {
      expect(action.fieldMappings).toHaveLength(2);
      expect(action.adapterConfig.objectId).toBe('obj-companies');
    }
  });

  it('builds config with branch and child action', () => {
    const session = new AgentToolSession(makeContext());

    session.setTrigger({ type: 'extraction', messageNodeTypeId: 'nt-msg' });
    const rootResult = session.addRootAction({ nodeType: 'attio:object' });
    const rootId = rootResult.nodeId!;
    session.setAdapterConfig({ nodeId: rootId, key: 'objectId', value: 'obj-companies' });
    session.setTraversal({
      nodeId: rootId,
      steps: [{ type: 'edge', edgeTypeId: 'et-msg-org', direction: 'outgoing' }],
    });
    session.addFieldMapping({
      nodeId: rootId,
      targetField: 'name',
      selection: { mode: 'property', propertyTypeId: 'pt-name' },
      identity: 'fuzzy',
    });

    // Add branch under root action
    const branchResult = session.addBranch({ parentId: rootId });
    const branchId = branchResult.nodeId!;

    // Set filter: branch on parent_result.created
    session.setFilter({
      branchId,
      filter: {
        traversal: [],
        selection: { mode: 'parent_result', field: 'created' },
        operator: 'eq',
        value: true,
      },
    });

    // Set match child: add note on newly created companies
    const noteResult = session.setBranchChild({ branchId, path: 'match', nodeType: 'attio:note' });
    const noteId = noteResult.nodeId!;

    session.addFieldMapping({
      nodeId: noteId,
      targetField: 'title',
      selection: { mode: 'llm', prompt: 'Generate a title summarizing the deal' },
    });

    session.addFieldMapping({
      nodeId: noteId,
      targetField: 'content',
      selection: { mode: 'llm', prompt: 'Summarize the deal details from the message' },
    });

    const final = session.getCurrentConfig();
    // Note has no errors (parent action provides parent record)
    // But branch only has match path — expect warning
    expect(final.warnings.some((w) => w.message.includes('match'))).toBe(true);
    expect(final.errors).toHaveLength(0);
  });

  it('exposes edge properties via getEdgeProperties', () => {
    const session = new AgentToolSession(makeContext());
    const edgeProps = session.getEdgeProperties({ edgeTypeId: 'et-msg-org' });
    expect(edgeProps.properties).toHaveLength(1);
    expect(edgeProps.properties[0].name).toBe('Confidence');
  });

  it('validates and reports errors', () => {
    const session = new AgentToolSession(makeContext());
    const result = session.validate();
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
