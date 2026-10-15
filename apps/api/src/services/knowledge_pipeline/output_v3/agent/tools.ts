// Agent tool suite

import type { FieldMapping, TraversalStep, FilterExpression, OutputV3Config, Expression } from 'movement-engine/services/knowledge_pipeline/output_v3/schemas';
import type {
  OntologySummary,
  AdapterMetadataProvider,
  AgentContext,
  ToolResult,
  ValidationResult,
} from './types';

import { ConfigState } from './config_state';
import { validate } from './validator';

// ---------------------------------------------------------------------------
// Agent Tool Session — stateful wrapper holding config + context
// ---------------------------------------------------------------------------

class AgentToolSession {
  private state: ConfigState;
  private context: AgentContext;

  constructor(context: AgentContext, initialConfig?: OutputV3Config) {
    this.context = context;
    this.state = new ConfigState(context.ontology, initialConfig);
  }

  get config(): OutputV3Config {
    return this.state.config;
  }

  get adapterType(): string {
    return this.context.adapterType;
  }

  get credentialsId(): string | null {
    return this.context.credentialsId;
  }

  // -----------------------------------------------------------------------
  // Config mutation tools — each returns { config, errors, warnings, nodeId? }
  // -----------------------------------------------------------------------

  setTrigger(args: {
    type: 'extraction' | 'mutation';
    messageNodeTypeId?: string;
    nodeTypeId?: string;
  }): ToolResult {
    if (args.type === 'extraction') {
      this.state.setTrigger({ type: 'extraction', messageNodeTypeId: args.messageNodeTypeId ?? '' });
    } else {
      this.state.setTrigger({ type: 'mutation', nodeTypeId: args.nodeTypeId ?? '' });
    }
    return this.result();
  }

  addRootAction(args: { nodeType: string }): ToolResult {
    const nodeId = this.state.addRootAction(args.nodeType);
    return this.result(nodeId);
  }

  addChildAction(args: { parentId: string; nodeType: string }): ToolResult {
    const nodeId = this.state.addChildAction(args.parentId, args.nodeType);
    return this.result(nodeId);
  }

  addBranch(args: { parentId?: string }): ToolResult {
    const nodeId = this.state.addBranch(args.parentId);
    return this.result(nodeId);
  }

  setBranchChild(args: { branchId: string; path: 'match' | 'noMatch'; nodeType: string }): ToolResult {
    const nodeId = this.state.setBranchChild(args.branchId, args.path, args.nodeType);
    return this.result(nodeId);
  }

  setMode(args: { nodeId: string; mode: 'assert' | 'read' }): ToolResult {
    this.state.setMode(args.nodeId, args.mode);
    return this.result();
  }

  removeNode(args: { nodeId: string }): ToolResult {
    this.state.removeNode(args.nodeId);
    return this.result();
  }

  setTraversal(args: { nodeId: string; steps: TraversalStep[] }): ToolResult {
    this.state.setTraversal(args.nodeId, args.steps);
    return this.result();
  }

  setAdapterConfig(args: { nodeId: string; key: string; value: unknown }): ToolResult {
    this.state.setAdapterConfig(args.nodeId, args.key, args.value);
    return this.result();
  }

  addFieldMapping(args: {
    nodeId: string;
    targetField: string;
    expression?: Expression;
    traversal?: TraversalStep[];
    selection?: FieldMapping['selection'];
    aggregation?: FieldMapping['aggregation'];
    identity?: FieldMapping['identity'];
    dataType?: FieldMapping['dataType'];
  }): ToolResult {
    const mapping: FieldMapping = {
      targetField: args.targetField,
      expression: args.expression,
      traversal: args.traversal ?? [],
      selection: args.selection,
      aggregation: args.aggregation,
      identity: args.identity,
      dataType: args.dataType,
    };
    this.state.addFieldMapping(args.nodeId, mapping);
    return this.result();
  }

  updateFieldMapping(args: {
    nodeId: string;
    index: number;
    targetField?: string;
    expression?: Expression;
    traversal?: TraversalStep[];
    selection?: FieldMapping['selection'];
    aggregation?: FieldMapping['aggregation'];
    identity?: FieldMapping['identity'];
    dataType?: FieldMapping['dataType'];
  }): ToolResult {
    const { nodeId, index, ...partial } = args;
    this.state.updateFieldMapping(nodeId, index, partial as Partial<FieldMapping>);
    return this.result();
  }

  removeFieldMapping(args: { nodeId: string; index: number }): ToolResult {
    this.state.removeFieldMapping(args.nodeId, args.index);
    return this.result();
  }

  setFilter(args: { branchId: string; filter: FilterExpression }): ToolResult {
    this.state.setFilter(args.branchId, args.filter);
    return this.result();
  }

  // -----------------------------------------------------------------------
  // Query tools — read-only, do not mutate config
  // -----------------------------------------------------------------------

  getOntology(): {
    nodeTypes: { id: string; name: string; category: string }[];
    edgeTypes: { id: string; outbound_name: string; inbound_name: string; source: string; target: string }[];
  } {
    return {
      nodeTypes: this.context.ontology.nodeTypes.map((nt) => ({
        id: nt.id,
        name: nt.name,
        category: nt.category,
      })),
      edgeTypes: this.context.ontology.edgeTypes.map((et) => ({
        id: et.id,
        outbound_name: et.outbound_name,
        inbound_name: et.inbound_name,
        source: this.nodeTypeName(et.source_node_type_id),
        target: this.nodeTypeName(et.target_node_type_id),
      })),
    };
  }

  getEdgesFrom(args: { nodeTypeId: string }): {
    outgoing: { edgeTypeId: string; name: string; targetTypeId: string; targetTypeName: string }[];
    incoming: { edgeTypeId: string; name: string; sourceTypeId: string; sourceTypeName: string }[];
  } {
    const outgoing = this.context.ontology.edgeTypes
      .filter((e) => e.source_node_type_id === args.nodeTypeId)
      .map((e) => ({
        edgeTypeId: e.id,
        name: e.outbound_name,
        targetTypeId: e.target_node_type_id,
        targetTypeName: this.nodeTypeName(e.target_node_type_id),
      }));

    const incoming = this.context.ontology.edgeTypes
      .filter((e) => e.target_node_type_id === args.nodeTypeId)
      .map((e) => ({
        edgeTypeId: e.id,
        name: e.inbound_name,
        sourceTypeId: e.source_node_type_id,
        sourceTypeName: this.nodeTypeName(e.source_node_type_id),
      }));

    return { outgoing, incoming };
  }

  getPropertiesOf(args: { nodeTypeId: string }): {
    properties: { id: string; name: string; valueType: string; identity: string }[];
  } {
    return {
      properties: this.context.ontology.propertyTypes
        .filter((p) => p.node_type_id === args.nodeTypeId)
        .map((p) => ({
          id: p.id,
          name: p.name,
          valueType: p.value_type,
          identity: p.identity,
        })),
    };
  }

  getEdgeProperties(args: { edgeTypeId: string }): {
    properties: { id: string; name: string; valueType: string }[];
  } {
    return {
      properties: this.context.ontology.propertyTypes
        .filter((p) => p.edge_type_id === args.edgeTypeId)
        .map((p) => ({
          id: p.id,
          name: p.name,
          valueType: p.value_type,
        })),
    };
  }

  getAdapterNodeTypes(args: { adapter: string }): { types: { type: string; description: string }[] } {
    const adapterTypes: Record<string, { type: string; description: string }[]> = {
      attio: [
        { type: 'attio:object', description: 'Create or update an Attio object record (Company, Person, etc.)' },
        { type: 'attio:list-entry', description: 'Add an entry to an Attio list (requires parent object)' },
        { type: 'attio:note', description: 'Create a note on an Attio record (requires parent object)' },
        { type: 'attio:task', description: 'Create a task linked to an Attio record (requires parent object)' },
      ],
      affinity: [
        { type: 'affinity:organization', description: 'Create or update an Affinity organization' },
        { type: 'affinity:person', description: 'Create or update an Affinity person (can link to parent organization)' },
        { type: 'affinity:list-entry', description: 'Add an entity to an Affinity list (requires parent organization or person)' },
        { type: 'affinity:note', description: 'Create a note on an Affinity entity (requires parent organization or person)' },
        { type: 'affinity:file', description: 'Upload a file (e.g. a pitch deck) to an Affinity organization. Iterates over resources attached to the context node; add an explicit resource step only when you need to filter or traverse to a different node first.' },
      ],
      slack: [
        { type: 'slack:message', description: 'Send a message to a Slack channel' },
        { type: 'slack:thread-reply', description: 'Reply in a Slack thread (requires parent message)' },
      ],
      airtable: [
        { type: 'airtable:record', description: 'Create or update an Airtable record' },
      ],
      google_sheets: [
        { type: 'google_sheets:row', description: 'Append a row to a Google Sheet' },
        { type: 'google_sheets:table-row', description: 'Append a row to a named table in a Google Sheet' },
      ],
      webhook: [
        { type: 'webhook:request', description: 'Send a webhook HTTP request' },
      ],
    };

    return { types: adapterTypes[args.adapter.toLowerCase()] ?? [] };
  }

  async getAdapterObjects(): Promise<{
    objects: { id: string; name: string; apiSlug?: string }[];
  }> {
    if (!this.context.credentialsId) return { objects: [] };
    const objects = await this.context.adapterMetadata.getObjects(this.context.credentialsId);
    return { objects };
  }

  async getAdapterAttributes(args: { objectId: string }): Promise<{
    attributes: { id: string; name: string; apiSlug?: string; type: string; isRequired?: boolean; isUnique?: boolean }[];
  }> {
    if (!this.context.credentialsId) return { attributes: [] };
    const attributes = await this.context.adapterMetadata.getAttributes(this.context.credentialsId, args.objectId);
    return { attributes };
  }

  async getAdapterAttributeOptions(args: { objectId: string; attributeId: string }): Promise<{
    options: { id: string; name: string }[];
  }> {
    if (!this.context.credentialsId) return { options: [] };
    const options = await this.context.adapterMetadata.getAttributeOptions(
      this.context.credentialsId,
      args.objectId,
      args.attributeId,
    );
    return { options };
  }

  async getAdapterChannels(): Promise<{
    channels: { id: string; name: string }[];
  }> {
    if (!this.context.credentialsId) return { channels: [] };
    const channels = await this.context.adapterMetadata.getChannels(this.context.credentialsId);
    return { channels };
  }

  async getAdapterLists(): Promise<{
    lists: { id: string; name: string }[];
  }> {
    if (!this.context.credentialsId) return { lists: [] };
    const lists = await this.context.adapterMetadata.getLists(this.context.credentialsId);
    return { lists };
  }

  getCurrentConfig(): ToolResult {
    return this.result();
  }

  // -----------------------------------------------------------------------
  // Context mutation — allow agent to switch adapter/credentials mid-session
  // -----------------------------------------------------------------------

  setAdapterType(adapterType: string): void {
    this.context.adapterType = adapterType;
  }

  setCredentialsId(credentialsId: string | null): void {
    this.context.credentialsId = credentialsId;
  }

  setAdapterMetadata(provider: AdapterMetadataProvider): void {
    this.context.adapterMetadata = provider;
  }

  replaceConfig(config: OutputV3Config): ToolResult {
    this.state = new ConfigState(this.context.ontology, config);
    return this.result();
  }

  // -----------------------------------------------------------------------
  // Validation tool
  // -----------------------------------------------------------------------

  validate(): ValidationResult {
    return validate(this.state.config, this.context.ontology);
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private result(nodeId?: string): ToolResult {
    const { errors, warnings } = validate(this.state.config, this.context.ontology);
    return {
      config: this.state.config,
      errors,
      warnings,
      nodeId,
    };
  }

  private nodeTypeName(id: string): string {
    return this.context.ontology.nodeTypes.find((nt) => nt.id === id)?.name ?? id;
  }
}

export { AgentToolSession };
