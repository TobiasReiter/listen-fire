import { z } from 'zod';

import PipelineOutputType from '../../../generated/kysely/public/PipelineOutputType';
import { Granularity } from './configSchema';

// Field definition for dynamic form generation in the UI
export interface FieldDefinition {
  key: string;
  label: string;
  type:
    | 'text'
    | 'textarea'
    | 'select'
    | 'number'
    | 'boolean'
    | 'duration'
    | 'field-select'
    | 'object-select'
    | 'list-select'
    | 'channel-select'
    | 'attribute-select'
    | 'spreadsheet-select'
    | 'sheet-select'
    | 'sheet-field-select'
    | 'table-select'
    | 'table-column-select'
    | 'base-select'
    | 'airtable-table-select'
    | 'airtable-field-select'
    | 'airtable-link-field-select'
    | 'drive-folder-select'
    | 'dropbox-folder-select'
    | 'workspace-member-select'
    | 'assignee-list'
    | 'field-list'
    | 'property-mapping';
  required: boolean;
  description?: string;
  placeholder?: string;
  // For select types, options can be static or fetched dynamically
  options?: { label: string; value: string }[];
  // For field-select, which object/list to fetch fields from
  fetchFieldsFrom?: 'parent' | 'self' | string;
  // For prompts that support AI extraction. Controls UI behavior.
  isPrompt?: boolean;
  // Hide this field when the node is a root node (has no parent)
  hideForRootNode?: boolean;
  // Hide this field when the node is a child node (has a parent)
  hideForChildNode?: boolean;
  // Make this field required only when the node is a child (has a parent)
  requiredForChildNode?: boolean;
  // Enable simple/expression toggle — field value can be an expression resolved at runtime
  expressionCapable?: boolean;
}

export interface NodeTypeDefinition {
  id: string; // e.g., "attio:object", "slack:message"
  adapter: PipelineOutputType;
  label: string;
  description: string;
  icon?: string;
  allowedGranularities: Granularity[];
  allowedParentTypes: (string | null)[]; // null in array = can be a root node
  allowedChildTypes: string[];
  configSchema: z.ZodSchema;
  fieldDefinitions: FieldDefinition[];
}

class NodeTypeRegistry {
  private types: Map<string, NodeTypeDefinition> = new Map();

  register(definition: NodeTypeDefinition): void {
    if (this.types.has(definition.id)) {
      throw new Error(`Node type "${definition.id}" is already registered`);
    }
    this.types.set(definition.id, definition);
  }

  get(id: string): NodeTypeDefinition | undefined {
    return this.types.get(id);
  }

  getAll(): NodeTypeDefinition[] {
    return Array.from(this.types.values());
  }

  getByAdapter(adapter: PipelineOutputType): NodeTypeDefinition[] {
    return this.getAll().filter((def) => def.adapter === adapter);
  }

  getRootTypes(adapter: PipelineOutputType): NodeTypeDefinition[] {
    return this.getByAdapter(adapter).filter((def) => def.allowedParentTypes.includes(null));
  }

  getChildTypes(parentTypeId: string): NodeTypeDefinition[] {
    const parentType = this.get(parentTypeId);
    if (!parentType) return [];
    return parentType.allowedChildTypes
      .map((id) => this.get(id))
      .filter((def): def is NodeTypeDefinition => def !== undefined);
  }

  // Check if a node type can be a child of another
  canBeChildOf(childTypeId: string, parentTypeId: string): boolean {
    const parentType = this.get(parentTypeId);
    if (!parentType) return false;
    return parentType.allowedChildTypes.includes(childTypeId);
  }

  // Check if a node type can be a root
  canBeRoot(typeId: string): boolean {
    const type = this.get(typeId);
    return type?.allowedParentTypes.includes(null) ?? false;
  }

  // Validate node config against its type's schema
  validateConfig(
    typeId: string,
    config: unknown,
  ): { success: true; data: unknown } | { success: false; error: z.ZodError } {
    const type = this.get(typeId);
    if (!type) {
      return {
        success: false,
        error: new z.ZodError([
          {
            code: 'custom',
            message: `Unknown node type: ${typeId}`,
            path: ['type'],
          },
        ]),
      };
    }
    return type.configSchema.safeParse(config);
  }
}

// Global registry instance
export const nodeTypeRegistry = new NodeTypeRegistry();

// Helper to create a node type ID
export function createNodeTypeId<T extends string, U extends string>(
  adapter: T,
  type: U,
): `${T}:${U}` {
  return `${adapter}:${type}`;
}

// Helper to parse a node type ID
export function parseNodeTypeId(id: string): { adapter: string; type: string } | null {
  const parts = id.split(':');
  if (parts.length !== 2) return null;
  return { adapter: parts[0], type: parts[1] };
}

// Serializable node type definition for API responses
export interface SerializableNodeTypeDefinition {
  id: string;
  adapter: PipelineOutputType;
  label: string;
  description: string;
  icon?: string;
  allowedGranularities: Granularity[];
  allowedParentTypes: (string | null)[];
  allowedChildTypes: string[];
  fieldDefinitions: FieldDefinition[];
}

export function serializeNodeType(def: NodeTypeDefinition): SerializableNodeTypeDefinition {
  return {
    id: def.id,
    adapter: def.adapter,
    label: def.label,
    description: def.description,
    icon: def.icon,
    allowedGranularities: def.allowedGranularities,
    allowedParentTypes: def.allowedParentTypes,
    allowedChildTypes: def.allowedChildTypes,
    fieldDefinitions: def.fieldDefinitions,
  };
}
