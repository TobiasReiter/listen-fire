// Agent context and result types

// Ontology summary passed to the agent at session start
interface OntologyNodeType {
  id: string;
  name: string;
  description: string | null;
  category: string;
}

interface OntologyEdgeType {
  id: string;
  outbound_name: string;
  inbound_name: string;
  description: string | null;
  source_node_type_id: string;
  target_node_type_id: string;
  required: boolean;
  scopes: boolean;
  edge_group: string | null;
}

interface OntologyPropertyType {
  id: string;
  node_type_id: string | null;
  edge_type_id: string | null;
  name: string;
  description: string | null;
  value_type: string;
  identity: string;
  evaluation_strategy: string;
  enum_values: string[] | null;
}

interface OntologySummary {
  nodeTypes: OntologyNodeType[];
  edgeTypes: OntologyEdgeType[];
  propertyTypes: OntologyPropertyType[];
}

// Adapter metadata provider — injected at session start
interface AdapterMetadataProvider {
  getObjects(credentialsId: string): Promise<AdapterObject[]>;
  getAttributes(credentialsId: string, objectId: string): Promise<AdapterAttribute[]>;
  getAttributeOptions(credentialsId: string, objectId: string, attributeId: string): Promise<{ id: string; name: string }[]>;
  getChannels(credentialsId: string): Promise<AdapterChannel[]>;
  getLists(credentialsId: string): Promise<AdapterList[]>;
}

interface AdapterObject {
  id: string;
  name: string;
  apiSlug?: string;
}

interface AdapterAttribute {
  id: string;
  name: string;
  apiSlug?: string;
  type: string;
  isRequired?: boolean;
  isUnique?: boolean;
}

interface AdapterChannel {
  id: string;
  name: string;
}

interface AdapterList {
  id: string;
  name: string;
}

// Validation results
interface ValidationError {
  nodeId?: string;
  path?: string;
  message: string;
}

interface ValidationWarning {
  nodeId?: string;
  path?: string;
  message: string;
}

interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

// Tool result — every mutation returns this
interface ToolResult {
  config: import('movement-engine/services/knowledge_pipeline/output_v3/schemas').OutputV3Config;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  nodeId?: string;
}

// Agent session context — everything the agent needs
interface AgentContext {
  ontology: OntologySummary;
  adapterMetadata: AdapterMetadataProvider;
  credentialsId: string | null;
  adapterType: string;
}

export type {
  OntologyNodeType,
  OntologyEdgeType,
  OntologyPropertyType,
  OntologySummary,
  AdapterMetadataProvider,
  AdapterObject,
  AdapterAttribute,
  AdapterChannel,
  AdapterList,
  ValidationError,
  ValidationWarning,
  ValidationResult,
  ToolResult,
  AgentContext,
};
